#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MMH 后台管理：集中配置。

全部从环境变量读取，便于 docker-compose / systemd 注入。
"""

import os

APP_NAME = "MMH 后台管理"
APP_VERSION = "0.1.0"


def _env(key, default=""):
    v = os.environ.get(key)
    return default if v is None or v == "" else v


def _env_int(key, default):
    try:
        return int(_env(key, str(default)))
    except ValueError:
        return default


# ---------------------------------------------------------------- 服务
HOST = _env("BIND_HOST", "127.0.0.1")
PORT = _env_int("BIND_PORT", 8791)
DATA_DIR = _env("DATA_DIR", "/data")
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")

# 登录口令（出厂值）。可在 UI 里改；改过之后以 DATA_DIR/admin-token 文件为准，
# 这个环境变量只作为兜底/恢复用。两者都没有时服务拒绝启动（见 auth.py / server.py）。
ADMIN_TOKEN = _env("ADMIN_TOKEN")
SESSION_TTL = _env_int("SESSION_TTL", 7 * 24 * 3600)

# ---------------------------------------------------------------- 时区
# 后台时间显示的口径。可在「设置」页改（写 DATA_DIR/tz，不用重启）。
# 优先级：DATA_DIR/tz 文件 > TZ_SPEC > TZ > 默认 Asia/Shanghai。
# 注意：这只管**显示**；stats_store.py 里下载时间写死 CST，是业务口径，不要动。
TZ_SPEC = _env("TZ_SPEC") or _env("TZ") or "Asia/Shanghai"

# ---------------------------------------------------------------- 数据源
# 下载统计（mmh-stats.db 所在目录，由 fnstore 的 Python 版写入）
STATS_DB_DIR = _env("STATS_DB_DIR", "/var/lib/mmh-fnstore")

# 自动注册（mmh-registration 的 sqlite）
REG_DB = _env("REG_DB", "/var/lib/mmh-registration/registration.sqlite3")

# 邮件（Postfix virtual_mailbox_base）
VMAIL_ROOT = _env("VMAIL_ROOT", "/var/vmail/floatingice.win")
# 要盯的信箱，逗号分隔；留空 = 自动发现 VMAIL_ROOT 下所有信箱
MAIL_ACCOUNTS = [x.strip() for x in _env("MAIL_ACCOUNTS", "mmh,sink").split(",") if x.strip()]
# 回复邮件时的发件人
MAIL_FROM = _env("MAIL_FROM", "mmh@floatingice.win")
MAIL_FROM_NAME = _env("MAIL_FROM_NAME", "MMH")
# 本机 Postfix（容器用 network_mode: host，所以是 127.0.0.1）
SMTP_HOST = _env("SMTP_HOST", "127.0.0.1")
SMTP_PORT = _env_int("SMTP_PORT", 25)

# GitHub issue 盯盘
GITHUB_REPO = _env("GITHUB_REPO", "frankluise5220/MMH")
GITHUB_TOKEN_FILE = _env("GITHUB_TOKEN_FILE", "/etc/mmh-admin/github-token")
GITHUB_API = "https://api.github.com"
# 允许在本面板里操作的仓库白名单（防止 token 被拿去改别的仓库）
GITHUB_ALLOWED_REPOS = [x.strip() for x in
                        _env("GITHUB_ALLOWED_REPOS", GITHUB_REPO).split(",") if x.strip()]

# ---------------------------------------------------------------- 邮件中继
# MMH 应用把「收件邮箱 + 验证码 + 过期分钟数」送到这里，由本服务内部经 Postfix
# 发验证码邮件。这是给 MMH 注册/绑定流程的专用窄接口：
#   - 只允许「验证码」这一种用途，发件人/主题/正文由服务端固定生成；
#   - 用独立中继 Token 鉴权，绝不复用后台管理员口令 / 后台 Cookie；
#   - 不接收、不存储、不记录任何密码。
# 留空则中继关闭（接口直接 403）。
MMH_RELAY_TOKEN = _env("MMH_RELAY_TOKEN")
# 同一收件邮箱在时间窗内的最大发送次数（防滥用）。默认 6 次 / 15 分钟。
MMH_RELAY_MAX_PER_WINDOW = _env_int("MMH_RELAY_MAX_PER_WINDOW", 6)
MMH_RELAY_WINDOW_SECONDS = _env_int("MMH_RELAY_WINDOW_SECONDS", 15 * 60)

# ---------------------------------------------------------------- 业务常量
STATS_DEFAULT_DAYS = _env_int("STATS_DEFAULT_DAYS", 30)

# ---------------------------------------------------------------- 认证服务管理
# 本面板通过 mmh-registration 的管理接口（/v1/admin/*，Bearer 鉴权）展示服务健康/配置
# 并发送测试邮件。REGISTRATION_API_URL 指向该服务的回环地址；
# REGISTRATION_API_TOKEN 是它的 REGISTRATION_API_TOKEN（独立于后台管理员口令）。
# 留空则该面板降级为「未配置」，只展示本地可读的信息（验证码日志仍可用）。
REGISTRATION_API_URL = _env("REGISTRATION_API_URL", "http://127.0.0.1:8790")
REGISTRATION_API_TOKEN = _env("REGISTRATION_API_TOKEN")
