#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板六：设置。

目前只有一件事：**在 UI 里改访问口令**。

为什么要做这个
    口令最初来自 .env 的 ADMIN_TOKEN。但 .env 只以 env_file 注入容器（没有挂载），
    容器里既改不了它，改完还得重启容器才生效 —— 等于"改口令必须 SSH 上 VPS 编辑
    文件"。这不是一个能用的功能。

怎么做
    auth.Auth 支持一层文件覆盖：DATA_DIR/admin-token（DATA_DIR 是 rw 挂载）。
    改口令 = 原子写这个文件 + 进程内重建签名密钥，不用重启容器。
    口令来源优先级：admin-token 文件 > ADMIN_TOKEN 环境变量。
    忘记口令 = 删掉该文件再重启容器，回落 .env（见 README）。

注意
    改口令会让**所有**旧会话立即失效（签名密钥变了）。所以改完必须给当前这位
    操作者补发一个新 cookie，否则他自己会被踢出去。这需要下发 Set-Cookie，
    因此这里返回 api.Response 而不是普通 dict。
"""

import time

import audit
import auth as auth_mod
import config
import tzutil
from api import ApiError, Response, route


def _auth():
    a = auth_mod.get_instance()
    if a is None:
        raise ApiError(503, "认证模块尚未初始化")
    return a


@route("GET", "/api/settings")
def read_settings(ctx):
    """口令状态 + 只读的服务信息，供设置页展示。"""
    a = _auth()
    changed = a.token_changed_at()
    return {
        "auth": {
            # source: file（UI 改过）| env（还在用 .env 的出厂口令）
            "source": a.source,
            "source_label": "UI 设置（%s）" % a.token_path if a.source == "file"
                            else "环境变量 ADMIN_TOKEN（.env）",
            "changed_at": changed,
            "has_env_fallback": bool(a.env_token),
            "token_min": auth_mod.TOKEN_MIN,
            "token_max": auth_mod.TOKEN_MAX,
            "session_ttl": a.ttl,
            "cookie_name": auth_mod.COOKIE_NAME,
            "token_path": a.token_path,
            "session_key_path": a.data_dir + "/session.key",
        },
        "tz": tzutil.info(),
        "env": {
            "app": config.APP_NAME,
            "version": config.APP_VERSION,
            "bind": "%s:%d" % (config.HOST, config.PORT),
            "data_dir": config.DATA_DIR,
            "stats_db_dir": config.STATS_DB_DIR,
            "reg_db": config.REG_DB,
            "vmail_root": config.VMAIL_ROOT,
            "mail_accounts": config.MAIL_ACCOUNTS,
            "mail_from": config.MAIL_FROM,
            "smtp": "%s:%d" % (config.SMTP_HOST, config.SMTP_PORT),
            "github_repo": config.GITHUB_REPO,
            "github_allowed_repos": config.GITHUB_ALLOWED_REPOS,
            "github_token_file": config.GITHUB_TOKEN_FILE,
        },
    }


@route("POST", "/api/settings/password")
def change_password(ctx):
    """改口令。成功则同时补发新 cookie，操作者不被打断。"""
    a = _auth()

    current = ctx.opt("current", "")
    new = ctx.opt("new", "")
    confirm = ctx.opt("confirm", None)

    if not isinstance(current, str) or not current:
        raise ApiError(400, "请输入当前口令")
    if not isinstance(new, str) or not new:
        raise ApiError(400, "请输入新口令")

    # 先校验新口令格式，再验当前口令 —— 格式错就别浪费一次口令比较
    err = auth_mod.validate_token(new)
    if err:
        raise ApiError(400, err)
    if confirm is not None and confirm != new:
        raise ApiError(400, "两次输入的新口令不一致")
    if a.check_password(new):
        raise ApiError(400, "新口令与当前口令相同，无需修改")

    if not a.check_password(current):
        audit.write("auth.password.change", {"result": "当前口令错误"},
                    ip=ctx.client_ip, ok=False)
        time.sleep(1.0)          # 与登录一致的轻微限速
        raise ApiError(401, "当前口令不正确")

    source = a.set_token(new)                     # 旧会话就此全部失效
    value, max_age = a.issue()                    # 给当前操作者补一张票
    audit.write("auth.password.change",
                {"result": "成功", "source": source, "length": len(new)},
                ip=ctx.client_ip, ok=True)

    return Response(
        data={"source": source, "changed_at": a.token_changed_at()},
        headers=[("Set-Cookie", a.cookie_header(value, max_age))],
    )


@route("POST", "/api/settings/timezone")
def set_timezone(ctx):
    """改时区。写 DATA_DIR/tz，立即生效，不用重启容器。

    影响范围：audit.jsonl 的 time 字段、服务日志前缀、概览的"数据生成于"、
    邮件 Date 头，以及前端所有用 fmtTime 渲染的时间（前端拿 spec 走 Intl）。

    **不影响** stats_store.py 里的下载时间——那里写死 CST，是业务口径，
    必须和 :4001/fnstore/ 页面一致。
    """
    if ctx.opt("reset"):
        tzutil.reset()
        audit.write("settings.timezone", {"result": "恢复默认", "spec": tzutil.info()["spec"]},
                    ip=ctx.client_ip, ok=True)
        return {"tz": tzutil.info()}

    spec = (ctx.opt("spec") or "").strip()
    if not spec:
        raise ApiError(400, "缺少参数 spec")
    err = tzutil.validate(spec)
    if err:
        audit.write("settings.timezone", {"result": "参数不合法", "spec": spec},
                    ip=ctx.client_ip, ok=False)
        raise ApiError(400, err)

    before = tzutil.info()["spec"]
    tzutil.set_spec(spec)
    audit.write("settings.timezone",
                {"result": "成功", "from": before, "to": spec}, ip=ctx.client_ip, ok=True)
    return {"tz": tzutil.info()}
