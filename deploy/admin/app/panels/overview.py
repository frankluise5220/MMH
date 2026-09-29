#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""概览：一屏看完三块 + issue。

刻意复用各面板自己的取数函数（registrations.overview / downloads.summary_data /
mail.mail_stats），不在这里另写 SQL —— 概览和详情页数字不一致是最容易被
当成 bug 的一类问题。

任何一块出错都不影响其它块：每块单独 try，失败就在该块里回一个 error 字段。
"""

import time

import config
import tzutil
from api import route

from . import downloads, issues, mail, registrations


@route("GET", "/api/overview")
def overview(ctx):
    out = {"ts": int(time.time()),
           "time": tzutil.fmt(),
           "tz": tzutil.brief()}

    # 自动用户注册
    try:
        reg = registrations.overview(ctx)
        out["registrations"] = {"ok": True, "totals": reg["totals"],
                                "db_present": reg["db_present"],
                                "by_provider": reg["by_provider"],
                                "by_platform": reg["by_platform"],
                                "recent": reg["recent"][:5]}
    except Exception as e:
        out["registrations"] = {"ok": False, "error": str(e)}

    # 下载汇总
    try:
        days = max(1, min(ctx.q_int("days", 30), 365))
        s = downloads.summary_data(days, ctx.q_bool("include_internal", False))
        out["downloads"] = {
            "ok": True, "days": days,
            "totals": s["totals"], "by_channel": s["by_channel"],
            "by_client": s["by_client"], "by_version": s["by_version"],
            "by_ip_kind": s["by_ip_kind"],
            "channel_labels": s["channel_labels"],
            "client_labels": s["client_labels"],
            "date_channel": dict(list(sorted(s["date_channel"].items(),
                                             reverse=True))[:7]),
        }
    except Exception as e:
        out["downloads"] = {"ok": False, "error": str(e)}

    # 邮件盯盘
    try:
        m = mail.mail_stats()
        out["mail"] = {
            "ok": True, "root": m["root"], "accounts": m["accounts"],
            "new": m["new"], "cur": m["cur"], "trash": m["trash"],
            "latest_ts": m["latest_ts"], "latest_subject": m["latest_subject"],
            "latest_from": m["latest_from"], "latest_account": m["latest_account"],
            "smtp_ok": None,
        }
        try:
            st = mail.mail_whoami(ctx)
            out["mail"]["smtp_ok"] = st["smtp_ok"]
            out["mail"]["smtp_detail"] = st["smtp_detail"]
        except Exception as e:
            out["mail"]["smtp_ok"] = False
            out["mail"]["smtp_detail"] = str(e)
    except Exception as e:
        out["mail"] = {"ok": False, "error": str(e)}

    # issue 盯盘（需要外网，单独兜底）
    try:
        data = issues.issues_list(_fake_ctx(ctx, {"state": "open", "kind": "issue",
                                                  "limit": "30"}))
        items = data.get("items") or []
        out["issues"] = {
            "ok": True, "repo": config.GITHUB_REPO,
            "open_issues": len([i for i in items if not i["is_pr"]]),
            "open_prs": len([i for i in items if i["is_pr"]]),
            "items": items[:10],
            "rate_remaining": data.get("rate_remaining"),
        }
    except Exception as e:
        out["issues"] = {"ok": False, "error": str(e), "repo": config.GITHUB_REPO}

    return out


def _fake_ctx(ctx, query):
    """构造一个只改了 query 的上下文副本，用来复用小面板的入口函数。"""
    import api
    return api.Ctx("GET", ctx.path, {k: [v] for k, v in query.items()},
                   {}, ctx.client_ip, ctx.user, ctx.headers)
