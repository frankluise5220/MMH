#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MMH 验证码邮件中继。

背景
    MMH 应用（wiseme）本机出站到 api.resend.com 的 TLS/代理链路常被重置，
    导致验证码发不出去。本机 Postfix 是可信的出站通道，所以让 MMH 把
    「收件邮箱 + 验证码 + 过期分钟数」送到这个窄接口，由本服务内部发信。

安全边界（必须严格守住）
    - 只允许「验证码」这一种用途。发件人 / 主题 / 正文全部由服务端固定生成，
      调用方不能传任何标题、正文、发件人或 HTML。
    - 鉴权用独立的 MMH_RELAY_TOKEN（HMAC 常数时间比较），绝不复用后台管理员
      口令，也不走后台 Cookie 会话。
    - 不接收、不存储、不记录任何密码。请求体里出现密码字段直接拒绝。
    - 审计只记收件邮箱和结果，不记验证码、不记正文。

接口契约
    POST /api/mmh/relay/send-code
      Header: Authorization: Bearer <MMH_RELAY_TOKEN>
      Body:   { "to": "user@example.com", "code": "123456",
                "expiresMinutes": 15 }
      -> 200 { "ok": true, "sent": true, "to": "..." }
      -> 401 中继 token 缺失/错误
      -> 403 中继未启用 / 用途被拒
      -> 400 参数非法
      -> 429 频率限制
      -> 502 Postfix 投递失败
"""

import hmac
import re
import time

import audit
import config
from api import ApiError, route
from panels.mail import _send

# 收件邮箱：单个邮箱地址，不做过于严苛的 RFC 全量校验，但必须「看起来像邮箱」
# 且不含换行/逗号（防止 SMTP 头注入）。最终仍由 Postfix 决定能否投递。
_EMAIL_RE = re.compile(r"^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")
_CODE_RE = re.compile(r"^[A-Za-z0-9]{4,20}$")

# 进程内频率限制：to -> [timestamp, ...]
_WINDOW_START = 0
_SENT = {}


def _now():
    return int(time.time())


def _relay_authorized(header_value):
    """常数时间比较中继 token。token 未配置时视为关闭。"""
    token = (config.MMH_RELAY_TOKEN or "").strip()
    if not token:
        return False
    got = (header_value or "")
    # 去掉 "Bearer " 前缀（若有），容忍大小写。
    if got.lower().startswith("bearer "):
        got = got[7:]
    got = got.strip()
    if not got:
        return False
    return hmac.compare_digest(got.encode("utf-8"), token.encode("utf-8"))


def _rate_limited(to):
    """同一收件邮箱在时间窗内限流。进程内计数，重启即清零（可接受）。"""
    global _WINDOW_START, _SENT
    now = _now()
    window = max(1, config.MMH_RELAY_WINDOW_SECONDS)
    if now - _WINDOW_START > window:
        # 时间窗滚动，重置全部计数
        _WINDOW_START = now
        _SENT = {}
    stamps = [t for t in _SENT.get(to, []) if now - t < window]
    _SENT[to] = stamps
    return len(stamps) >= max(1, config.MMH_RELAY_MAX_PER_WINDOW)


def _bump(to):
    _SENT.setdefault(to, []).append(_now())


@route("POST", "/api/mmh/relay/send-code")
def relay_send_code(ctx):
    # 这个接口不要求后台会话，但要求独立中继 token。鉴权失败统一 401，
    # 不泄露「未启用」和「token 错误」的区别。
    auth_header = ctx.headers.get("Authorization") or ctx.headers.get("authorization")
    if not _relay_authorized(auth_header):
        audit.write("relay.send-code", {"result": "unauthorized"}, ip=ctx.client_ip, ok=False)
        raise ApiError(401, "中继凭证缺失或错误")

    to = str(ctx.need("to")).strip().lower()
    code = str(ctx.need("code")).strip()
    expires = ctx.opt("expiresMinutes", 15)

    # 任何密码字段一律拒绝——中继永远不该见到密码。
    for forbidden in ("password", "pass", "pwd", "secret", "credential"):
        if forbidden in ctx.body:
            audit.write("relay.send-code", {"result": "rejected_credential"},
                        ip=ctx.client_ip, ok=False)
            raise ApiError(400, "本接口不接受密码或凭据字段")

    if not _EMAIL_RE.match(to):
        raise ApiError(400, "收件邮箱非法")
    if not _CODE_RE.match(code):
        raise ApiError(400, "验证码非法")
    try:
        expires = int(expires)
    except (TypeError, ValueError):
        expires = 15
    expires = max(1, min(expires, 60))

    if _rate_limited(to):
        audit.write("relay.send-code", {"to": to, "result": "rate_limited"},
                    ip=ctx.client_ip, ok=False)
        raise ApiError(429, "该邮箱验证码发送过于频繁，请稍后再试")

    subject = "MMH account registration verification code"
    text = (
        "You are registering an MMH account (email: %s).\n\n"
        "Verification code: %s\n"
        "Valid for %d minutes.\n\n"
        "If you did not request this, please ignore this email." % (to, code, expires)
    )

    try:
        _send([to], subject, text)
    except ApiError as e:
        audit.write("relay.send-code", {"to": to, "result": "delivery_failed"},
                    ip=ctx.client_ip, ok=False, error=str(e))
        raise

    _bump(to)
    audit.write("relay.send-code", {"to": to, "result": "sent"}, ip=ctx.client_ip, ok=True)
    return {"sent": True, "to": to}
