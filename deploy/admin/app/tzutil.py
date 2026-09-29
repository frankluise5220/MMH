#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""时区：后台所有时间显示的口径，可在「设置」页改，不用重启。

来源（后者优先）
    1. 环境变量 TZ_SPEC，其次 TZ
    2. DATA_DIR/tz          —— UI 改过就写这，以这份为准
默认 Asia/Shanghai（北京时间）。

spec 支持两种写法
    - IANA 名    Asia/Shanghai / UTC / America/New_York   （走 zoneinfo，含夏令时）
    - 固定偏移   UTC+8 / +08:00 / +0800 / UTC-5

容器是 python:3.11-slim，自带 /usr/share/zoneinfo，所以 zoneinfo 可用；
万一以后换了不带 tzdata 的镜像，自动退化成固定偏移，不让整个面板崩掉。

为什么不让前端"跟着浏览器时区走"
    审计要的是**一个确定的、可复现的口径**：audit.jsonl 里的 12:45 和页面上显示的
    12:45 必须是同一个时刻，换台电脑打开也得一样。所以服务端渲染和前端渲染
    统一用这里解析出来的时区（前端拿 spec 走 Intl，浏览器自带 tzdata）。

注意 stats_store.py 里的下载时间用的是写死的 CST（要和 fnstore 页面口径一致），
**不要**改成这里 —— 那是业务口径，不是显示偏好。
"""

import datetime
import os
import re
import threading

DEFAULT_SPEC = "Asia/Shanghai"

# 「设置」页下拉里的常用时区。北京时间放第一个，因为这是默认。
PRESETS = [
    ("Asia/Shanghai", "北京时间 (UTC+8)"),
    ("UTC", "UTC"),
    ("Asia/Tokyo", "东京 (UTC+9)"),
    ("Asia/Kolkata", "印度 (UTC+5:30)"),
    ("Europe/London", "伦敦"),
    ("Europe/Berlin", "柏林"),
    ("America/New_York", "纽约"),
    ("America/Los_Angeles", "洛杉矶"),
    ("Australia/Sydney", "悉尼"),
]

_OFFSET_RE = re.compile(r"^(?:UTC|GMT)?\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$", re.I)

# 万一镜像里没有 tzdata（本地 Windows 的 Python 就没有），预设时区靠这张表退化成
# 固定偏移，服务至少能起来。表里填的是**标准时**偏移；有夏令时的地区在夏令时期间
# 会差 1 小时 —— 所以会置 degraded 标记并在设置页提示，不装作正常。
# 生产用的 python:3.11-slim 自带 /usr/share/zoneinfo，走不到这张表。
_FALLBACK_OFFSETS = {
    "Asia/Shanghai": 8, "Asia/Hong_Kong": 8, "Asia/Singapore": 8,
    "Asia/Tokyo": 9, "Asia/Kolkata": 5.5,
    "Europe/London": 0, "Europe/Berlin": 1,
    "America/New_York": -5, "America/Los_Angeles": -8,
    "Australia/Sydney": 10,
}

_lock = threading.Lock()
_degraded = False       # 上一次 _build 是否用了固定偏移兜底
_state = {
    "spec": DEFAULT_SPEC,
    "source": "default",
    "path": "",
    "env_spec": "",
    "tz": None,
    "offset": "UTC+00:00",
    "abbr": "",
    "degraded": False,
    "error": "",
}


# ---------------------------------------------------------------- 解析
def _parse_offset(spec):
    """UTC+8 / +08:00 / -0500 -> 固定偏移 tzinfo；不是这种写法返回 None。"""
    m = _OFFSET_RE.match((spec or "").strip())
    if not m:
        return None
    sign = 1 if m.group(1) == "+" else -1
    hours = int(m.group(2))
    minutes = int(m.group(3) or 0)
    if hours > 14 or minutes > 59:
        return None
    delta = datetime.timedelta(hours=hours, minutes=minutes) * sign
    if not (-datetime.timedelta(hours=12) <= delta <= datetime.timedelta(hours=14)):
        return None
    return datetime.timezone(delta)


def _build(spec):
    """spec -> tzinfo。认不出来抛 ValueError（消息直接给用户看）。"""
    global _degraded
    _degraded = False
    spec = (spec or "").strip()
    if not spec:
        raise ValueError("时区不能为空")
    if spec.upper() in ("UTC", "GMT", "Z"):
        return datetime.timezone.utc
    tz = _parse_offset(spec)
    if tz is not None:
        return tz
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(spec)
    except Exception:
        pass
    if spec in _FALLBACK_OFFSETS:
        _degraded = True
        return datetime.timezone(datetime.timedelta(hours=_FALLBACK_OFFSETS[spec]))
    raise ValueError(
        "认不出的时区：%s（填 Asia/Shanghai 这类 IANA 名，或 UTC+8 这类固定偏移）" % spec)


def validate(spec):
    """返回错误信息字符串；合法则 None。"""
    try:
        _build(spec)
    except ValueError as e:
        return str(e)
    return None


def _describe(tz):
    """该时区**当前**的偏移与缩写（夏令时下会变，所以只在应用时算一次快照）。"""
    now = datetime.datetime.now(tz)
    off = now.utcoffset() or datetime.timedelta(0)
    total = int(off.total_seconds())
    sign = "+" if total >= 0 else "-"
    total = abs(total)
    return ("UTC%s%02d:%02d" % (sign, total // 3600, (total % 3600) // 60),
            now.tzname() or "")


# ---------------------------------------------------------------- 落盘
def _atomic_write(path, content):
    """先写临时文件再 replace，避免读到写了一半的内容。
    时区不是密钥，用 0644；口令那份在 auth.py 里是 0600。"""
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)


def _read():
    path = _state["path"]
    if path and os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                s = f.read().strip()
            if s:
                return s, "file"
        except OSError:
            pass
    if _state["env_spec"]:
        return _state["env_spec"], "env"
    return DEFAULT_SPEC, "default"


def _apply(spec, source):
    tz = _build(spec)
    degraded = _degraded
    offset, abbr = _describe(tz)
    with _lock:
        _state.update(spec=spec, source=source, tz=tz, degraded=degraded,
                      offset=offset, abbr=abbr, error="")


# ---------------------------------------------------------------- 对外
def init(data_dir, env_spec=""):
    """启动时调一次。配置写错了也不能让服务起不来——回落到默认并记下错误。"""
    with _lock:
        _state["path"] = os.path.join(data_dir, "tz") if data_dir else ""
        _state["env_spec"] = (env_spec or "").strip()
    spec, source = _read()
    try:
        _apply(spec, source)
    except ValueError as e:
        _apply(DEFAULT_SPEC, "default")
        with _lock:
            _state["error"] = "%s —— 已回落到 %s" % (e, DEFAULT_SPEC)
    return _state["spec"]


def tz():
    t = _state["tz"]
    return t if t is not None else datetime.timezone.utc


def now():
    return datetime.datetime.now(tz())


def fmt(ts=None, with_sec=True):
    d = datetime.datetime.fromtimestamp(ts, tz()) if ts is not None else now()
    return d.strftime("%Y-%m-%d %H:%M:%S" if with_sec else "%Y-%m-%d %H:%M")


def today():
    return now().strftime("%Y-%m-%d")


def rfc2822(ts=None):
    """邮件 Date 头：带本时区偏移，收件人那边不会看到一串 UTC。"""
    import email.utils
    d = now() if ts is None else datetime.datetime.fromtimestamp(ts, tz())
    return email.utils.format_datetime(d)


def brief():
    """塞进 /api/me 给前端用的小块（前端拿 spec 走 Intl 渲染）。"""
    with _lock:
        return {"spec": _state["spec"], "offset": _state["offset"],
                "abbr": _state["abbr"]}


def info():
    """给「设置」页看的完整状态。"""
    with _lock:
        st = dict(_state)
    return {
        "spec": st["spec"],
        "source": st["source"],
        "source_label": {
            "file": "UI 设置（%s）" % st["path"],
            "env": "环境变量 TZ_SPEC / TZ",
            "default": "默认（%s）" % DEFAULT_SPEC,
        }.get(st["source"], st["source"]),
        "offset": st["offset"],
        "abbr": st["abbr"],
        "now": fmt(),
        "error": st["error"],
        "degraded": st["degraded"],
        "note": ("这个环境里没有 tzdata，该时区退化成了固定偏移，夏令时不会自动调整"
                 if st["degraded"] else ""),
        "default": DEFAULT_SPEC,
        "presets": [{"spec": s, "label": l} for s, l in PRESETS],
    }


def set_spec(spec):
    """改时区并立即生效（不重启）。"""
    spec = (spec or "").strip()
    _build(spec)                      # 先校验，坏值不落盘
    path = _state["path"]
    if not path:
        raise RuntimeError("时区文件路径未初始化")
    _atomic_write(path, spec + "\n")
    _apply(spec, "file")
    return info()


def reset():
    """删掉文件覆盖，回落到环境变量 / 默认。"""
    path = _state["path"]
    if path and os.path.exists(path):
        os.remove(path)
    spec, source = _read()
    _apply(spec, source)
    return info()
