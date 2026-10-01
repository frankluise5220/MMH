#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MMH 后台管理服务：纯标准库 HTTP 服务。

设计取舍
    - 零第三方依赖。宿主是台老 VPS（系统 Python 3.6），跑在 python:3.11-slim 容器里，
      不装 flask/gunicorn，避免以后再出现"镜像换了、依赖装不上"这类事故。
    - ThreadingHTTPServer + 每请求独立 sqlite 连接。后台管理是人工点击级并发，
      不需要连接池。
    - 认证：口令换签名 cookie（见 auth.py）。口令来源 DATA_DIR/admin-token 文件
      优先于 ADMIN_TOKEN 环境变量，所以口令可以在 UI 里改、无需重启。
    - 写操作全部走 audit.write()。

路由表在 api.ROUTES，由各 panels/*.py 通过 @route 注册。
"""

import json
import os
import posixpath
import sys
import threading
import time
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import api          # noqa: E402
import audit        # noqa: E402
import auth as auth_mod  # noqa: E402
import config       # noqa: E402
import tzutil       # noqa: E402
from api import ApiError, Ctx  # noqa: E402
from auth import COOKIE_NAME, Auth  # noqa: E402

MAX_BODY = 2 * 1024 * 1024      # 2MB，足够放长邮件正文/长评论
PUBLIC_API = {"/api/health", "/api/login"}

AUTH = None
START_TS = int(time.time())


# ---------------------------------------------------------------- 面板加载
def load_panels():
    """导入 panels 包，触发 @route 注册。"""
    import panels  # noqa: F401
    return sorted({p for _, p in api.ROUTES})


# ---------------------------------------------------------------- 静态文件
_MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
}


def _safe_join(root, rel):
    """把 URL 路径安全地映射到 root 下，阻断 ../ 穿越。"""
    rel = unquote(rel).lstrip("/")
    target = os.path.normpath(os.path.join(root, rel))
    if not (target == root or target.startswith(root + os.sep)):
        return None
    return target


# ---------------------------------------------------------------- Handler
class Handler(BaseHTTPRequestHandler):
    server_version = "mmh-admin/" + config.APP_VERSION
    protocol_version = "HTTP/1.1"

    # -- 基础 --------------------------------------------------------
    def log_message(self, fmt, *args):
        # 默认实现往 stderr 刷；改成一行带时间的前缀，方便 journalctl 看。
        # 时间用配置的时区（tzutil），跟页面上看到的一致。
        sys.stderr.write("[%s] %s - %s\n" % (
            tzutil.fmt(), self.address_string(), fmt % args))

    def _client_ip(self):
        """nginx 会加 X-Real-IP / X-Forwarded-For；直连时用 socket 对端。"""
        xr = self.headers.get("X-Real-IP")
        if xr:
            return xr.strip()
        xf = self.headers.get("X-Forwarded-For")
        if xf:
            return xf.split(",")[0].strip()
        return self.client_address[0]

    def _send(self, status, body, ctype="application/json; charset=utf-8", extra=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj, extra=None):
        self._send(status, json.dumps(obj, ensure_ascii=False, default=str), extra=extra)

    def _drain_body(self):
        """把请求体读掉再返回。

        必须做：HTTP/1.1 是 keep-alive，如果我们在读完 body 之前就回响应（比如
        未登录直接 401），残留在 socket 里的 body 字节会被当成下一个请求行，
        服务端就报 `Bad request syntax`，连接错位。客户端虽然还是拿到 401，
        但这条连接已经废了。
        """
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return
        if length > MAX_BODY:
            # 太大就别读了，直接让这条连接断掉
            self.close_connection = True
            return
        try:
            remaining = length
            while remaining > 0:
                chunk = self.rfile.read(min(remaining, 65536))
                if not chunk:
                    break
                remaining -= len(chunk)
        except (OSError, ValueError):
            self.close_connection = True

    def _error(self, status, message, **extra):
        payload = {"ok": False, "error": message}
        payload.update(extra)
        self._json(status, payload)

    # -- 认证 --------------------------------------------------------
    def _session_ok(self):
        raw = self.headers.get("Cookie")
        if not raw:
            return False
        try:
            jar = SimpleCookie()
            jar.load(raw)
        except Exception:
            return False
        morsel = jar.get(COOKIE_NAME)
        return bool(morsel and AUTH.verify(morsel.value))

    # -- 入口 --------------------------------------------------------
    def do_GET(self):
        self._handle("GET")

    def do_HEAD(self):
        self._handle("HEAD")

    def do_POST(self):
        self._handle("POST")

    def do_PATCH(self):
        self._handle("PATCH")

    def do_DELETE(self):
        self._handle("DELETE")

    def _handle(self, method):
        try:
            parts = urlsplit(self.path)
            path = posixpath.normpath(unquote(parts.path))
            if parts.path.endswith("/") and path != "/":
                path += "/"
            query = parse_qs(parts.query, keep_blank_values=True)

            if path.startswith("/api/"):
                return self._handle_api(method, path, query)
            return self._handle_static(method, path)
        except ApiError as e:
            self._error(e.status, e.message, **e.extra)
        except BrokenPipeError:
            pass
        except Exception:
            traceback.print_exc()
            self._error(500, "服务内部错误，详见服务端日志")

    # -- API ---------------------------------------------------------
    def _handle_api(self, method, path, query):
        if path == "/api/health":
            return self._json(200, {
                "ok": True, "app": config.APP_NAME, "version": config.APP_VERSION,
                "uptime": int(time.time()) - START_TS, "routes": len(api.ROUTES),
            })

        if method == "POST" and path == "/api/login":
            return self._api_login()

        # MMH 验证码邮件中继不使用后台 Cookie 会话，改用独立的
        # MMH_RELAY_TOKEN（见 panels/relay.py）。这里跳过会话检查，让请求
        # 继续走到 body 解析和 dispatch，由 relay.py 自行鉴权。
        is_relay = method == "POST" and path == "/api/mmh/relay/send-code"

        if not is_relay and not self._session_ok():
            self._drain_body()          # 提前返回前必须读掉 body，否则连接错位
            return self._error(401, "未登录或会话已过期")

        if method == "POST" and path == "/api/logout":
            self._drain_body()
            return self._json(200, {"ok": True}, extra=[
                ("Set-Cookie", "%s=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax"
                 % COOKIE_NAME)])

        if method == "GET" and path == "/api/me":
            return self._json(200, {"ok": True, "data": {
                "app": config.APP_NAME, "version": config.APP_VERSION,
                "github_repo": config.GITHUB_REPO,
                "mail_from": config.MAIL_FROM,
                "tz": tzutil.brief(),      # 前端拿 spec 走 Intl 渲染时间
            }})

        body = {}
        if method in ("POST", "PATCH", "DELETE"):
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._error(413, "请求体过大")
            if length:
                raw = self.rfile.read(length)
                if raw.strip():
                    try:
                        body = json.loads(raw.decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        return self._error(400, "请求体不是合法 JSON")
        if method == "GET" and query.get("_body"):
            # 便于用 GET 传复杂查询（不推荐，仅内部兜底）
            try:
                body = json.loads(query["_body"][0])
            except ValueError:
                body = {}

        ctx = Ctx(method, path, query, body, self._client_ip(), "admin", dict(self.headers))
        result = api.dispatch(ctx)
        if isinstance(result, api.Response):
            # 面板要自定义状态码/响应头（目前只有改口令下发 Set-Cookie）
            return self._json(result.status, {"ok": True, "data": result.data},
                              extra=result.headers)
        if isinstance(result, dict) and "ok" in result:
            return self._json(200, result)
        return self._json(200, {"ok": True, "data": result})

    def _api_login(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._error(413, "请求体过大")
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8") or "{}")
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "请求体不是合法 JSON")

        ip = self._client_ip()
        if not AUTH.check_password(body.get("token")):
            audit.write("login", {"result": "口令错误"}, ip=ip, ok=False)
            time.sleep(1.0)          # 轻微限速，压一压爆破
            return self._error(401, "口令不正确")

        value, max_age = AUTH.issue()
        audit.write("login", {"result": "成功"}, ip=ip, ok=True)
        return self._json(200, {"ok": True}, extra=[
            ("Set-Cookie",
             "%s=%s; Path=/; Max-Age=%d; HttpOnly; Secure; SameSite=Lax"
             % (COOKIE_NAME, value, max_age))])

    # -- 静态 --------------------------------------------------------
    def _handle_static(self, method, path):
        if path in ("/", "/index.html"):
            rel = "index.html"
        else:
            rel = path.lstrip("/")
        target = _safe_join(config.STATIC_DIR, rel)
        if target is None or not os.path.isfile(target):
            return self._send(404, "not found", ctype="text/plain; charset=utf-8")
        ext = os.path.splitext(target)[1].lower()
        ctype = _MIME.get(ext, "application/octet-stream")
        with open(target, "rb") as f:
            data = f.read()
        extra = []
        if rel == "index.html":
            # 静态页不缓存，避免改了前端看不到
            extra.append(("Cache-Control", "no-cache"))
        return self._send(200, data, ctype=ctype, extra=extra)


# ---------------------------------------------------------------- main
def main():
    global AUTH
    os.makedirs(config.DATA_DIR, exist_ok=True)

    # 时区要先初始化：audit.write / 日志前缀都要用它
    spec = tzutil.init(config.DATA_DIR, config.TZ_SPEC)
    audit.init(config.DATA_DIR)

    # 口令来源：DATA_DIR/admin-token 文件 > ADMIN_TOKEN 环境变量（见 auth.py）。
    # 所以这里不能只检查环境变量——UI 改过口令后以文件为准。
    try:
        AUTH = Auth(config.ADMIN_TOKEN, config.DATA_DIR, config.SESSION_TTL)
    except RuntimeError as e:
        sys.stderr.write("致命：%s\n" % e)
        return 2
    auth_mod.set_instance(AUTH)

    load_panels()

    httpd = ThreadingHTTPServer((config.HOST, config.PORT), Handler)
    httpd.daemon_threads = True
    sys.stderr.write(
        "%s v%s 已启动：http://%s:%d/  接口 %d 个  口令来源=%s  时区=%s\n"
        % (config.APP_NAME, config.APP_VERSION, config.HOST, config.PORT,
           len(api.ROUTES), AUTH.source, spec))
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
