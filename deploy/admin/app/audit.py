#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""审计日志：所有写操作落盘，append-only JSONL。

路径 DATA_DIR/audit.jsonl，一行一条。刻意不做轮转删除——后台管理的写操作
量很小（人工点击级），保留全量才叫审计。

`time` 字段按当前配置的时区渲染（见 tzutil），`ts` 永远是 epoch ——
想换算法就自己拿 ts 算，不用依赖这个字符串。
"""

import json
import os
import threading
import time

import tzutil

_lock = threading.Lock()
_path = None


def init(data_dir):
    global _path
    os.makedirs(data_dir, exist_ok=True)
    _path = os.path.join(data_dir, "audit.jsonl")


def write(action, detail=None, actor="", ip="", ok=True, error=""):
    """记录一条审计。detail 里禁止放 token / 正文全文以外的敏感串。"""
    if _path is None:
        return
    ts = int(time.time())
    rec = {
        "ts": ts,
        "time": tzutil.fmt(ts),
        "tz": tzutil.brief()["spec"],
        "action": action,
        "actor": actor or "-",
        "ip": ip or "-",
        "ok": bool(ok),
        "detail": detail if isinstance(detail, (dict, list)) else (detail or ""),
    }
    if error:
        rec["error"] = error
    line = json.dumps(rec, ensure_ascii=False, default=str)
    with _lock:
        with open(_path, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def tail(limit=200):
    """读最近 limit 条。"""
    if _path is None or not os.path.exists(_path):
        return []
    limit = max(1, min(int(limit), 2000))
    with _lock:
        with open(_path, "rb") as f:
            try:
                f.seek(0, os.SEEK_END)
                size = f.tell()
                block = min(size, 256 * 1024)
                f.seek(size - block)
                raw = f.read().decode("utf-8", "replace")
            except OSError:
                return []
    lines = [ln for ln in raw.splitlines() if ln.strip()]
    out = []
    for ln in lines[-limit:]:
        try:
            out.append(json.loads(ln))
        except ValueError:
            continue
    out.reverse()
    return out
