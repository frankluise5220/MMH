#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""面板二：下载汇总。

直接读 fnstore Python 版写的 mmh-stats.db（STATS_DB_DIR/mmh-stats.db），
复用 deploy/fnstore/app/stats_store.py —— 本目录下的 stats_store.py 是它的
逐字拷贝，口径必须完全一致：

    渠道(channel) × 客户端软件(client) × 日期(date) × 版本(version)
    默认排除 ip_kind ∈ ('loopback','private')（本机探针 / 内网流量），
    public 与 unknown（无 IP 的历史聚合导入行）都计入。

注意不要在这里另写一套统计 SQL：口径一旦分叉，就会出现"两个页面数字不一样"。
"""

import csv
import io
import os

import config
from api import ApiError, route
from stats_store import StatsStore

_STORE = None


def store():
    global _STORE
    if _STORE is None:
        if not os.path.isdir(config.STATS_DB_DIR):
            raise ApiError(503, "统计目录不存在：%s" % config.STATS_DB_DIR)
        _STORE = StatsStore(config.STATS_DB_DIR)
    return _STORE


@route("GET", "/api/downloads/summary")
def summary(ctx):
    days = max(1, min(ctx.q_int("days", config.STATS_DEFAULT_DAYS), 365))
    include_internal = ctx.q_bool("include_internal", False)
    return summary_data(days, include_internal)


def summary_data(days=None, include_internal=False):
    """供本面板和 /api/overview 共用，保证口径一致。"""
    days = max(1, min(int(days or config.STATS_DEFAULT_DAYS), 365))
    data = store().summary(days=days, include_internal=include_internal)
    data["db_path"] = os.path.join(config.STATS_DB_DIR, "mmh-stats.db")
    return data


@route("GET", "/api/downloads/recent")
def recent(ctx):
    limit = max(1, min(ctx.q_int("limit", 200), 2000))
    # 明细必须跟 summary 同口径，否则"总数 62、明细里一堆本机探针"。
    include_internal = ctx.q_bool("include_internal", False)
    return {"items": store().recent(limit=limit, include_internal=include_internal),
            "include_internal": include_internal}


@route("GET", "/api/downloads/export.csv")
def export_csv(ctx):
    """把汇总导成 CSV：日期 × 渠道 明细 + 版本 × 渠道 明细两张表。"""
    days = max(1, min(ctx.q_int("days", config.STATS_DEFAULT_DAYS), 365))
    include_internal = ctx.q_bool("include_internal", False)
    s = summary_data(days, include_internal)

    ch_labels = s["channel_labels"]
    channels = s["channels"]
    buf = io.StringIO()
    w = csv.writer(buf)

    w.writerow(["# 下载汇总", "天数=%d" % days,
                "含本机/内网=%s" % ("是" if include_internal else "否")])
    w.writerow([])
    w.writerow(["日期"] + [ch_labels.get(c, c) for c in channels] + ["合计"])
    for date in sorted(s["date_channel"], reverse=True):
        row = s["date_channel"][date]
        vals = [row.get(c, 0) for c in channels]
        w.writerow([date] + vals + [sum(vals)])

    w.writerow([])
    w.writerow(["版本"] + [ch_labels.get(c, c) for c in channels] + ["合计"])
    for ver, ftypes in sorted(s["version_filetype_channel"].items(), reverse=True):
        merged = {}
        for _ft, chs in ftypes.items():
            for c, n in chs.items():
                merged[c] = merged.get(c, 0) + n
        vals = [merged.get(c, 0) for c in channels]
        w.writerow([ver] + vals + [sum(vals)])

    return {"csv": buf.getvalue(), "filename": "mmh-downloads-%dd.csv" % days}
