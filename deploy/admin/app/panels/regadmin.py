#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""认证服务管理端：验证码日志 / 服务健康与配置 / 发测试邮件。

背景
    后台既是「认证服务器管理端」：除了邮件模板面板，还要能看到验证码发送日志、
    服务健康与配置，并能通过真实通道发一封测试邮件验证模板 + SMTP 链路。

数据来源（两条路径）
    1. 验证码日志：直接读 mmh-registration 的 SQLite（config.REG_DB），与
       panels/registrations.py 同一套连接方式。verification_codes 表只存
       code_hash（不存明文），日志面板只展示邮箱 / 用途 / 发送时间 / 是否已用 /
       尝试次数，绝不展示或允许还原验证码。
    2. 服务健康 / 配置 + 发测试邮件：代理到认证服务的管理接口
       GET  /v1/admin/info        （bearer 鉴权）
       POST /v1/admin/test-mail   （bearer 鉴权）
       由 config.REGISTRATION_API_URL / REGISTRATION_API_TOKEN 决定可达性。
       token 留空时这两个子功能降级为「未配置」，面板只显示本地可读的部分。

安全边界
    - 本面板所有路由都在后台会话之后（server.py 统一鉴权），无需额外鉴权。
    - 发测试邮件把测试模板渲染 + SMTP 投递完全交给认证服务，本面板不持有
      SMTP 凭据，也不记录验证码明文。
    - 审计只记「发了测试邮件到哪个邮箱 + 结果」，不记模板正文。
"""

import json
import sqlite3
import urllib.request
import urllib.error

import audit
import config
from api import ApiError, route


def _conn():
    conn = sqlite3.connect(config.REG_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    return conn


def _codes_purpose(value):
    """用途白名单：registration / password-reset。"""
    if value not in ("registration", "password-reset"):
        raise ApiError(400, "purpose 必须是 registration 或 password-reset")
    return value


def _reg_api(path, token, body=None, method=None):
    """调用认证服务管理接口，返回 (status, json)。token 缺失视为未配置。"""
    if not token:
        raise ApiError(503, "认证服务管理未配置（缺少 REGISTRATION_API_TOKEN）")
    url = config.REGISTRATION_API_URL.rstrip("/") + path
    headers = {
        "Authorization": "Bearer " + token,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except ValueError:
                return resp.status, {"ok": False, "raw": raw}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"ok": False, "error": raw or str(e)}
    except urllib.error.URLError as e:
        raise ApiError(502, "认证服务不可达：%s" % (e.reason or e))


@route("GET", "/api/regadmin/info")
def regadmin_info(ctx):
    """服务健康 / 配置。token 配置了就代理，否则降级只报本地可读部分。"""
    token = (config.REGISTRATION_API_TOKEN or "").strip()
    if not token:
        return {
            "configured": False,
            "service": "mmh-registration",
            "note": "未配置 REGISTRATION_API_TOKEN，健康/配置与测试邮件不可用；验证码日志仍可用。",
            "mail": {"configured": None, "host": None, "port": None, "from": None},
            "policy": None,
            "templates": None,
        }
    status, body = _reg_api("/v1/admin/info", token, method="GET")
    if status != 200 or not body.get("ok"):
        raise ApiError(status if status >= 500 else 502,
                       "认证服务返回异常：%s" % body.get("error", status))
    data = body.get("data", {})
    return {
        "configured": True,
        "service": data.get("service"),
        "time": data.get("time"),
        "mail": data.get("mail"),
        "policy": data.get("policy"),
        "templates": data.get("templates"),
        "tables": data.get("tables"),
    }


@route("GET", "/api/regadmin/codes")
def regadmin_codes(ctx):
    """验证码发送日志。分页 + 可选 purpose / email 过滤。"""
    purpose = ctx.q("purpose")
    email = ctx.q("email", "").strip().lower()
    offset = max(0, ctx.q_int("offset", 0))
    limit = max(1, min(ctx.q_int("limit", 100), 500))

    where = []
    args = []
    if purpose:
        where.append("purpose = ?")
        args.append(_codes_purpose(purpose))
    if email:
        where.append("LOWER(email) LIKE ?")
        args.append("%" + email + "%")

    conn = _conn()
    try:
        cond = ("WHERE " + " AND ".join(where)) if where else ""
        total = conn.execute(
            "SELECT COUNT(*) AS n FROM verification_codes " + cond, args
        ).fetchone()["n"]

        rows = conn.execute(
            "SELECT id, email, purpose, expires_at, used_at, attempts, created_at "
            "FROM verification_codes " + cond +
            " ORDER BY created_at DESC LIMIT ? OFFSET ?",
            args + [limit, offset],
        ).fetchall()

        recent = conn.execute(
            "SELECT purpose, COUNT(*) AS n FROM verification_codes "
            "WHERE created_at >= datetime('now', '-1 hour') "
            "GROUP BY purpose"
        ).fetchall()
    finally:
        conn.close()

    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "items": [
            {
                "id": r["id"],
                "email": r["email"],
                "purpose": r["purpose"],
                "expires_at": r["expires_at"],
                "used": bool(r["used_at"]),
                "used_at": r["used_at"],
                "attempts": r["attempts"],
                "created_at": r["created_at"],
            }
            for r in rows
        ],
        "last_hour": {r["purpose"]: r["n"] for r in recent},
    }


@route("POST", "/api/regadmin/test-mail")
def regadmin_test_mail(ctx):
    """通过真实通道发一封测试邮件（代理到认证服务）。"""
    token = (config.REGISTRATION_API_TOKEN or "").strip()
    to = str(ctx.need("to")).strip().lower()
    purpose = _codes_purpose(str(ctx.need("purpose")).strip())
    lang = ctx.opt("lang")
    if lang not in (None, "zh", "en"):
        raise ApiError(400, "lang 必须是 zh 或 en")

    body = {"to": to, "purpose": purpose}
    if lang:
        body["lang"] = lang
    status, resp = _reg_api("/v1/admin/test-mail", token, body=body, method="POST")
    if status != 200 or not resp.get("ok"):
        raise ApiError(status if status >= 500 else 502,
                       "测试邮件失败：%s" % resp.get("error", status))

    audit.write("regadmin.test-mail", {"to": to, "purpose": purpose, "lang": lang},
                actor=ctx.user, ip=ctx.client_ip, ok=True)
    return {"sent": True, "to": to, "purpose": purpose, "lang": lang}
