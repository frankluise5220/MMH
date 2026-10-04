#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板：邮件模板。

认证服务器（deploy/registration，容器名 mmh-registration）发出的两类验证码邮件，
文案原本硬编码在它的 src/templates.ts 里 —— 改一句话就得改代码、重建镜像、重启
容器。现在模板存在注册库的一张表里，本面板直接读写：

    mail_templates(purpose PK, subject, text, html, updated_at)

数据源：REG_DB（与「自动注册」面板同一个 sqlite）。
    注册服务发信时读这张表；**没有行就用它内置的默认文案**，所以
    「恢复默认」= 删掉这一行，而不是把默认文案再写一遍。

写入方式：直接改 sqlite。理由同 registrations.py —— 注册服务没有暴露任何管理
接口，为这个后台去改 Node 服务、重建镜像，代价和风险都更大。该库由 Node 侧以
WAL 模式持有，多读一写，写前 busy_timeout。

占位符：{{email}} / {{code}} / {{expiresMinutes}}，由注册服务在发送时替换。
预览也在服务端渲染（同一套替换规则），保证「页面看到的」就是「实际发出的」。

安全边界
    - 表不存在（注册服务还没跑 005 迁移）时只读不写，并明确提示先重启注册服务。
    - 只写 subject / text / html 三列，绝不碰 principals / identities / installations。
    - 审计只记 purpose 与各字段长度，不记全文。
"""

import contextlib
import os
import re
import sqlite3
import time

import audit
import config
from api import ApiError, route

PURPOSES = (
    {"key": "registration", "label": "注册验证码", "audience": "新注册 MMH 会员时发出"},
    {"key": "password-reset", "label": "密码找回验证码", "audience": "MMH 会员找回密码时发出"},
)

PLACEHOLDERS = (
    {"name": "email", "desc": "收件邮箱"},
    {"name": "code", "desc": "6 位验证码"},
    {"name": "expiresMinutes", "desc": "有效期分钟数"},
)

# 字段长度上限：防手滑贴进来一整封邮件。正常文案远小于这些值。
MAX_SUBJECT = 300
MAX_TEXT = 20000
MAX_HTML = 40000

# 预览用的样例值（与真实发送时的变量一一对应）。
SAMPLE_VARS = {"email": "user@example.com", "code": "123456", "expiresMinutes": 15}

# ---------------------------------------------------------------------------
# 内置默认文案。
#
# ⚠️ **必须与 deploy/registration/src/templates.ts 的 DEFAULT_MAIL_TEMPLATES 逐字一致。**
#    注册服务在「表里没有该 purpose 的行」时用的就是那一份，本面板在同样情况下
#    展示的是这一份。两边一旦分叉，页面显示的和实际发出的就会不同。
#    改一边务必同步另一边 —— 注册服务的测试 `src/tests/mail-template.test.ts`
#    会读取本文件并核对这几段字符串，分叉了会红。
#
#    这里刻意用三引号原样写（不做拼接），测试才能用「子串包含」直接比对。
# ---------------------------------------------------------------------------
DEFAULT_TEMPLATES = {
    "registration": {
        "subject": "MMH account registration verification code",
        "text": """You are registering an MMH account (email: {{email}}).

Verification code: {{code}}
Valid for {{expiresMinutes}} minutes.

If you did not request this, please ignore this email.""",
        "html": """<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0f172a;"><h2 style="margin:0 0 12px;">MMH account registration</h2><p>You are registering an MMH account (email: {{email}}).</p><p style="font-size:24px;letter-spacing:6px;font-weight:700;margin:18px 0;">{{code}}</p><p>This code is valid for {{expiresMinutes}} minutes.</p><p style="color:#64748b;font-size:13px;">If you did not request this, please ignore this email.</p></div>""",
    },
    "password-reset": {
        "subject": "MMH 会员密码找回验证码",
        "text": """你正在找回 MMH 会员密码（账号：{{email}}）。

验证码：{{code}}
有效期：{{expiresMinutes}} 分钟

说明：这是 MMH 会员密码（跨账簿的中央身份密码），不是某个账簿内的本地账户密码。
如果不是你本人操作，请忽略本邮件。""",
        "html": """<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#0f172a;"><h2 style="margin:0 0 12px;">MMH 会员密码找回验证码</h2><p>你正在找回 MMH 会员密码（账号：{{email}}）。</p><p style="font-size:24px;letter-spacing:6px;font-weight:700;margin:18px 0;">{{code}}</p><p>验证码有效期：{{expiresMinutes}} 分钟。</p><p style="color:#64748b;font-size:13px;">这是 MMH 会员密码（跨账簿的中央身份密码），不是某个账簿内的本地账户密码。如果不是你本人操作，请忽略本邮件。</p></div>""",
    },
}

_PLACEHOLDER_RE = {
    "email": re.compile(r"\{\{\s*email\s*\}\}"),
    "code": re.compile(r"\{\{\s*code\s*\}\}"),
    "expiresMinutes": re.compile(r"\{\{\s*expiresMinutes\s*\}\}"),
}


# ---------------------------------------------------------------- 数据库
def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def _conn():
    if not os.path.exists(config.REG_DB):
        raise ApiError(503, "注册数据库不存在：%s" % config.REG_DB)
    conn = sqlite3.connect(config.REG_DB, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout=8000")
    return conn


@contextlib.contextmanager
def _db():
    """同 registrations.py：sqlite3 连接不是上下文管理器（with conn 只提交事务、
    不关连接），显式关掉，避免每请求泄漏一个文件描述符。"""
    conn = _conn()
    try:
        yield conn
    finally:
        conn.close()


def _table_exists(conn):
    row = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='mail_templates'"
    ).fetchone()
    return row is not None


def _stored_rows(conn):
    if not _table_exists(conn):
        return {}
    out = {}
    for row in conn.execute(
        "SELECT purpose, subject, text, html, updated_at FROM mail_templates"
    ):
        out[row["purpose"]] = dict(row)
    return out


def _purpose_or_400(key):
    if key not in DEFAULT_TEMPLATES:
        raise ApiError(400, "未知的邮件用途：%s" % key)
    return key


# ---------------------------------------------------------------- 渲染
def _render(template, variables):
    """替换占位符。与注册服务 src/templates.ts 的规则一致（允许 {{ name }} 空格）。"""
    out = {}
    for field in ("subject", "text", "html"):
        s = template.get(field) or ""
        for name, rx in _PLACEHOLDER_RE.items():
            s = rx.sub(lambda _m, v=str(variables[name]): v, s)
        out[field] = s
    return out


def _clean_text(value, field, limit):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ApiError(400, "%s 必须是字符串" % field)
    if len(value) > limit:
        raise ApiError(400, "%s 超过 %d 字上限" % (field, limit))
    return value


# ---------------------------------------------------------------- 接口
@route("GET", "/api/mail-templates")
def list_templates(ctx):
    """返回两类模板的「生效内容」：库里改过就用库里的，否则是内置默认。"""
    with _db() as conn:
        table_ok = _table_exists(conn)
        stored = _stored_rows(conn) if table_ok else {}

    items = []
    for purpose in PURPOSES:
        key = purpose["key"]
        default = DEFAULT_TEMPLATES[key]
        row = stored.get(key)
        effective = row or default
        items.append({
            "key": key,
            "label": purpose["label"],
            "audience": purpose["audience"],
            "subject": effective["subject"],
            "text": effective["text"],
            "html": effective.get("html") or "",
            "is_custom": row is not None,
            "updated_at": (row or {}).get("updated_at"),
            "default": default,
        })

    return {
        "db_path": config.REG_DB,
        "table_ok": table_ok,
        "placeholders": list(PLACEHOLDERS),
        "sample": SAMPLE_VARS,
        "limits": {"subject": MAX_SUBJECT, "text": MAX_TEXT, "html": MAX_HTML},
        "items": items,
    }


@route("POST", "/api/mail-templates/<purpose>")
def save_template(ctx):
    """保存某一类模板。写库即生效：注册服务下次发信就会用新文案。"""
    key = _purpose_or_400(ctx.params["purpose"])

    subject = str(ctx.need("subject")).strip()
    if len(subject) > MAX_SUBJECT:
        raise ApiError(400, "主题超过 %d 字上限" % MAX_SUBJECT)
    text = _clean_text(ctx.opt("text"), "纯文本正文", MAX_TEXT)
    html = _clean_text(ctx.opt("html"), "HTML 正文", MAX_HTML)
    if not text.strip():
        raise ApiError(400, "纯文本正文不能为空（HTML 客户端不可用时它才是正文）")

    now = _now()
    with _db() as conn:
        if not _table_exists(conn):
            raise ApiError(
                503,
                "注册库里还没有 mail_templates 表：请先重启 mmh-registration "
                "（它会应用 005 迁移），再回来保存",
            )
        # INSERT OR REPLACE 在这个「只有主键 + 三列内容」的表上就是 upsert。
        conn.execute(
            "INSERT OR REPLACE INTO mail_templates "
            "(purpose, subject, text, html, updated_at) VALUES (?, ?, ?, ?, ?)",
            (key, subject, text, html, now),
        )
        conn.commit()

    audit.write("mail_template.save", {
        "purpose": key, "subject_len": len(subject),
        "text_len": len(text), "html_len": len(html),
    }, ip=ctx.client_ip)
    return {"purpose": key, "updated_at": now}


@route("POST", "/api/mail-templates/<purpose>/reset")
def reset_template(ctx):
    """恢复内置默认：删掉这一行（注册服务随后回落到它自己的默认文案）。"""
    key = _purpose_or_400(ctx.params["purpose"])
    with _db() as conn:
        if not _table_exists(conn):
            raise ApiError(
                503,
                "注册库里还没有 mail_templates 表：请先重启 mmh-registration "
                "（它会应用 005 迁移）",
            )
        cur = conn.execute("DELETE FROM mail_templates WHERE purpose = ?", (key,))
        removed = cur.rowcount
        conn.commit()

    audit.write("mail_template.reset", {"purpose": key, "removed": removed},
                ip=ctx.client_ip)
    return {"purpose": key, "reset": True, "removed": removed}


@route("POST", "/api/mail-templates/<purpose>/preview")
def preview_template(ctx):
    """用样例值渲染一份草稿（不落库），让「看到的」和「发出的」是同一套替换。"""
    key = _purpose_or_400(ctx.params["purpose"])
    default = DEFAULT_TEMPLATES[key]
    draft = {
        "subject": str(ctx.opt("subject", default["subject"])),
        "text": str(ctx.opt("text", default["text"])),
        "html": str(ctx.opt("html", default.get("html") or "")),
    }
    return {"purpose": key, "sample": SAMPLE_VARS,
            "rendered": _render(draft, SAMPLE_VARS)}
