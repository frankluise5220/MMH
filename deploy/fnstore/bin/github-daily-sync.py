#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 GitHub Release 下载量按天同步进 mmh-stats.db 的 github 渠道。

为什么需要它
    GitHub 的下载请求打到 GitHub CDN，不经 VPS，nginx / live 记录永远看不到，
    所以 admin 后台的「下载汇总」里 github 渠道列一直是 0（与 fnos 同理，
    但 fnos 在 stats_store.py 里被标成不可测，而 github 是预留了渠道、缺采集器）。

    GitHub API 只给每个 asset 的「累计」download_count，没有按天/按 IP 的明细。
    因此这里用日差估算：每次拉一次累计数，与上次基线之差 = 这段区间增量，
    以 channel='github'、ip=''（=> ip_kind='unknown'，按 stats_store 口径计入汇总）
    写入，origin='github-api' 以便审计/重跑。

归账口径（务必知道）
    GitHub 不提供真实下载日期，增量只能全部记到「本次抓取当天」。所以这是估算，
    不是实测——某天没跑、某天跑两次，增量的归属日会漂。这是 GitHub API 的硬限制。

首次运行
    只建立基线、不产生事件，从第二次起才有每日数据，避免把历史累计全算到启用当天。
    想要「启用当日就开始有数」，可加 --seed-first-day 把首次差量（当前累计）也写进
    当天 —— 但那会把历史下载全算成一天，默认不这么做。

用法
    python3 github-daily-sync.py                          # 只打印将写入的增量（dry-run）
    python3 github-daily-sync.py --apply                  # 真正写入
    python3 github-daily-sync.py --repo owner/repo --data-dir /opt/fn-appstores-server/data
    python3 github-daily-sync.py --token-file /etc/mmh-admin/github-token   # 可选，放宽限速
    python3 github-daily-sync.py --mock-json test.json --date 2026-10-07    # 本地验证用

建议 crontab（Asia/Shanghai 每天 02:05）
    5 2 * * * cd /opt/fn-appstores-server && python3 bin/github-daily-sync.py --apply \
        >> /var/log/github-daily-sync.log 2>&1
"""

import argparse
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))
ORIGIN = "github-api"
GITHUB_API = "https://api.github.com"

# stats_store.py 的位置随部署方式不同：包内是 app/stats_store.py，
# 线上是 /opt/fn-appstores-server/stats_store.py（与 app.py 同级）。都试一遍。
_HERE = os.path.dirname(os.path.abspath(__file__))
for _cand in (os.path.dirname(_HERE), _HERE, os.path.join(os.path.dirname(_HERE), "app")):
    if os.path.isfile(os.path.join(_cand, "stats_store.py")):
        sys.path.insert(0, _cand)
        break

import stats_store  # noqa: E402

BASE_KEY = "gh_base:"          # meta key 前缀：gh_base:<asset_id> -> 上次累计数
LAST_KEY = "gh_last_sync"      # 最近一次抓取时间


def fetch_releases(repo, token=None, mock_json=None):
    """-> [{tag, assets: [{id, name, download_count}]}]。

    真实模式：分页拉全量 releases（per_page=100），只取有 assets 的。
    mock 模式：直接读一个 {releases: [...]} 的 JSON 文件，便于本地验证。
    """
    if mock_json:
        with open(mock_json, encoding="utf-8") as fh:
            return json.load(fh)["releases"]
    out, page = [], 1
    while True:
        url = "%s/repos/%s/releases?per_page=100&page=%d" % (GITHUB_API, repo, page)
        req = urllib.request.Request(url, headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "mmh-github-daily-sync",
        })
        if token:
            req.add_header("Authorization", "Bearer %s" % token)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = json.load(resp)
        except Exception as e:
            print("拉取 GitHub 失败: %s" % e, file=sys.stderr)
            raise
        if not body:
            break
        for rel in body:
            assets = [{
                "id": a.get("id"), "name": a.get("name"),
                "download_count": int(a.get("download_count") or 0),
            } for a in (rel.get("assets") or []) if a.get("name")]
            if assets:
                out.append({"tag": rel.get("tag_name") or "", "assets": assets})
        if len(body) < 100:
            break
        page += 1
    return out


def load_base(conn):
    return {r["key"][len(BASE_KEY):]: int(r["value"])
            for r in conn.execute(
                "SELECT key,value FROM meta WHERE key LIKE ?", (BASE_KEY + "%",))}


def save_base(conn, asset_id, cur):
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (BASE_KEY + str(asset_id), str(cur)),
    )


def collect_deltas(store, releases):
    """计算每个 asset 的增量；同时更新基线。返回 [(asset, prev, cur, delta)]。"""
    with store._lock, store._connect() as conn:
        base = load_base(conn)
        deltas = []
        for rel in releases:
            for a in rel["assets"]:
                cur = a["download_count"]
                key = str(a["id"])
                prev = base.get(key)
                if prev is None:
                    # 首次见到该 asset：只建基线，不产生事件
                    save_base(conn, a["id"], cur)
                    deltas.append((a, None, cur, None))
                    continue
                save_base(conn, a["id"], cur)
                delta = cur - prev
                if delta > 0:
                    deltas.append((a, prev, cur, delta))
        return deltas


def write_events(store, deltas, target_date):
    """把增量写入 download_event（channel='github'，ip='' -> unknown，计入汇总）。"""
    if not deltas:
        return 0
    # 锚到当天 00:00:00 CST，增量按秒递增，避免同 file 撞进 10 秒去重窗口。
    base_ts = int(datetime.strptime(target_date, "%Y-%m-%d")
                  .replace(tzinfo=CST).timestamp())
    n = 0
    with store._lock, store._connect() as conn:
        for a, _prev, _cur, delta in deltas:
            for i in range(delta):
                ts = base_ts + i
                version, ftype, arch = stats_store.parse_file(a["name"])
                conn.execute(
                    "INSERT INTO download_event"
                    " (ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,status,bytes,origin)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (ts, target_date, version, a["name"], ftype, arch,
                     "github", "unknown", "", "unknown", "", 200, 0, ORIGIN),
                )
                n += 1
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (LAST_KEY, datetime.now(CST).strftime("%Y-%m-%d %H:%M:%S")),
        )
    return n


def main():
    ap = argparse.ArgumentParser(description="把 GitHub Release 下载量按天同步进 mmh-stats.db")
    ap.add_argument("--repo", default="frankluise5220/MMH")
    ap.add_argument("--data-dir", default="/opt/fn-appstores-server/data")
    ap.add_argument("--token-file", default="")
    ap.add_argument("--date", default="", help="归账日期 YYYY-MM-DD，默认当天（CST）")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只 dry-run）")
    ap.add_argument("--mock-json", default="", help="本地验证用：读 mock releases JSON")
    args = ap.parse_args()

    target_date = args.date or datetime.now(CST).strftime("%Y-%m-%d")

    token = ""
    if args.token_file and os.path.isfile(args.token_file):
        with open(args.token_file, encoding="utf-8") as fh:
            token = fh.read().strip()

    store = stats_store.StatsStore(args.data_dir)
    store.init_schema()

    releases = fetch_releases(args.repo, token=token, mock_json=args.mock_json)
    total = sum(a["download_count"] for rel in releases for a in rel["assets"])
    print("仓库 %s：%d 个 release，%d 个 asset，GitHub 累计下载合计 %d"
          % (args.repo, len(releases),
             sum(len(r["assets"]) for r in releases), total))

    # 收集增量（副作用：更新基线，无论 dry-run 与否——基线与事件分离，可安全预演）
    deltas = collect_deltas(store, releases)
    new_only = [d for d in deltas if d[3] is None]
    with_inc = [d for d in deltas if d[3]]
    print("  新 asset（仅建基线）: %d 个" % len(new_only))
    for a, _p, cur, _d in new_only:
        print("    - %s  累计=%d" % (a["name"], cur))
    print("  有增量: %d 个，合计 %d 次（归账到 %s）"
          % (len(with_inc), sum(d[3] for d in with_inc), target_date))
    for a, prev, cur, delta in with_inc:
        print("    + %d  %-34s 基线=%d -> 当前=%d" % (delta, a["name"], prev, cur))

    if not args.apply:
        print("\n[dry-run] 基线已更新，但未写入事件。确认无误后加 --apply。")
        return 0

    n = write_events(store, with_inc, target_date)
    print("\n已写入 %d 条 github 渠道事件（origin=%s，归账 %s）" % (n, ORIGIN, target_date))
    return 0


if __name__ == "__main__":
    sys.exit(main())
