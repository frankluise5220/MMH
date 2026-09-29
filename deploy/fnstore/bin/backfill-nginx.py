#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 nginx access log 回填进 mmh-stats.db。

为什么需要它
    2026-09-27 服务端从 Python 版换成 Go 版之后，下载统计分裂成两个互不相通的库：
    Go 写 stats.db（只有 app 级日聚合），Python 写 download-stats.json（有 IP/渠道但
    没有 UA，且渠道判定有 bug）。统一成 mmh-stats.db 时，历史只能靠旧 JSON 和
    Go 聚合导入，粒度差、且缺客户端软件维度。
    nginx 的 access.log 保留了真实 IP / UA / 状态码 / 时间，是唯一能重建
    "渠道 × 软件 × 日期" 的原始数据，所以用它回填。

局限（务必知道）
    - log_format 里没有 $host，渠道只能按"路径 + UA"推断，规则见 infer_channel()。
      因此 fnapp 域名下手动下载 synology SPK 的记录会被算进 synology 渠道。
    - 回填行 origin='legacy-nginx'，与 legacy-json 可能重复（两者数据源重叠）。
      默认只打印统计不落库；确认后再 --apply。--apply 会先删掉旧的 legacy-nginx 行，
      所以可以反复跑。
    - live 行优先：origin='live' 是应用侧实时写的，渠道按 Host 判定（比日志的
      "路径 + UA" 推断准），IP 也来自 X-Real-IP。日志行只是它的低配复制品。
      所以日志行一旦被同 IP + 同文件的 live 行覆盖就整条跳过；否则同一笔下载会被
      记两次。2026-09-29 live 启用当天实测留下 6 条这样的重复行，
      用 --dedupe-live 清理。

用法
    python3 bin/backfill-nginx.py                 # dry-run，打印将要写入的汇总
    python3 bin/backfill-nginx.py --apply         # 真正写入
    python3 bin/backfill-nginx.py --dedupe-live --apply   # 只清理被 live 覆盖的重复行
    python3 bin/backfill-nginx.py --log-dir /var/log/nginx --data-dir /opt/mmh-fnstore/data
"""

import argparse
import collections
import gzip
import glob
import os
import re
import sys
from datetime import datetime, timedelta, timezone

# stats_store.py 的位置随部署方式不同：包内是 app/stats_store.py，
# 线上是 /opt/fn-appstores-server/stats_store.py（与 app.py 同级）。都试一遍。
_HERE = os.path.dirname(os.path.abspath(__file__))
for _cand in (os.path.dirname(_HERE), _HERE, os.path.join(os.path.dirname(_HERE), "app")):
    if os.path.isfile(os.path.join(_cand, "stats_store.py")):
        sys.path.insert(0, _cand)
        break

import stats_store  # noqa: E402

CST = timezone(timedelta(hours=8))
ORIGIN = "legacy-nginx"
LIVE_ORIGIN = "live"
# 同 IP + 同文件、时间差落在此窗口内 → 认定为同一笔下载（去重与"取代"判定共用）。
SUPERSEDE_WINDOW = 120

# 判断"是否已有某 origin 的同 IP+同文件+相近时间行"，回填跳过与去重共用。
_COVERED_SQL = ("SELECT 1 FROM download_event WHERE origin=? AND ip=? AND file=? "
                "AND ABS(ts-?)<=? LIMIT 1")


def _covered_by(conn, origin, ts, ip, fname):
    return conn.execute(
        _COVERED_SQL, (origin, ip, fname, ts, SUPERSEDE_WINDOW)
    ).fetchone() is not None

# 自检/探针用的 UA 标记：这些是人工验证流量，不该进统计。
# 注意 nginx 日志里也有它们，所以过滤必须放在回填这一层，否则每次重跑都会把它们捞回来。
SKIP_UA_MARKERS = ("MMH-STATS-SELFTEST",)

# log_format main  '$remote_addr - $remote_user [$time_local] "$request" '
#                   '$status $body_bytes_sent "$http_referer" '
#                   '"$http_user_agent" "$http_x_forwarded_for"';
LINE_RE = re.compile(
    r'^(?P<ip>\S+) - (?P<user>\S+) \[(?P<time>[^\]]+)\] '
    r'"(?P<request>[^"]*)" (?P<status>\d{3}) (?P<bytes>\d+) '
    r'"(?P<referer>[^"]*)" "(?P<ua>[^"]*)" "(?P<xff>[^"]*)"'
)


def infer_channel(path, ua):
    """无 $host 时的渠道推断。顺序即优先级。"""
    low = (ua or "").lower()
    if "fndepot" in low:
        return "fndepot"
    if "synology" in (path or "").lower():
        return "synology"
    if (path or "").startswith("/apps/"):
        return "fnstore"
    return "vps"


def iter_lines(log_dir):
    for f in sorted(glob.glob(os.path.join(log_dir, "access.log*"))):
        try:
            if f.endswith(".gz"):
                text = gzip.open(f, "rb").read().decode("utf-8", "replace")
            else:
                with open(f, encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
        except OSError as e:
            print("跳过 %s: %s" % (f, e), file=sys.stderr)
            continue
        for line in text.splitlines():
            yield f, line


def collect(log_dir):
    """-> [(ts, ip, file, status, ua, channel, client)]，按时间升序、已按 10s 去重。"""
    rows = []
    for src, line in iter_lines(log_dir):
        m = LINE_RE.match(line)
        if not m:
            continue
        parts = m.group("request").split()
        if len(parts) < 2:
            continue
        method, path = parts[0], parts[1]
        if method not in ("GET", "HEAD"):
            continue
        if not (path.startswith("/apps/") or path.startswith("/downloads/")):
            continue
        status = int(m.group("status"))
        if status not in stats_store.COUNTED_STATUS:
            continue
        fname = path.split("?", 1)[0].rsplit("/", 1)[-1]
        if not fname:
            continue
        try:
            dt = datetime.strptime(m.group("time"), "%d/%b/%Y:%H:%M:%S %z")
        except ValueError:
            continue
        ts = int(dt.timestamp())
        ua = m.group("ua")
        if any(mark in ua for mark in SKIP_UA_MARKERS):
            continue
        rows.append((ts, m.group("ip"), fname, status, ua,
                     infer_channel(path, ua), stats_store.detect_client(ua)))

    rows.sort(key=lambda r: r[0])
    deduped, seen = [], {}
    for r in rows:
        key = (r[1], r[2])
        if key in seen and r[0] - seen[key] < stats_store.DEDUP_WINDOW:
            continue
        seen[key] = r[0]
        deduped.append(r)
    return deduped, len(rows)


def report(rows):
    by_date = collections.defaultdict(collections.Counter)
    by_cc = collections.defaultdict(collections.Counter)
    for ts, ip, fname, status, ua, ch, cl in rows:
        date = datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d")
        by_date[date][ch] += 1
        by_cc[ch][cl] += 1
    print("  按日期 × 渠道")
    for date in sorted(by_date):
        c = by_date[date]
        print("    %s  %s  合计 %d" % (date, dict(c), sum(c.values())))
    print("  按渠道 × 客户端软件")
    for ch in sorted(by_cc):
        print("    %-9s %s" % (ch, dict(by_cc[ch])))
    kinds = collections.Counter(stats_store.classify_ip(r[1]) for r in rows)
    print("  IP 分类:", dict(kinds))


def apply_rows(data_dir, rows, merge_legacy_json=True):
    """写入 legacy-nginx 行；可选地把被它覆盖的 legacy-json 行"升级"掉。

    为什么是"升级"而不是"叠加"
        legacy-json 和 nginx 日志描述的是同一批 HTTP 请求（JSON 是应用侧记的，
        日志是 nginx 侧记的）。直接叠加等于同一笔下载数两次。JSON 行唯一的优势是
        渠道是应用判定的；日志行的优势是有真实 UA（=> 真正的客户端软件维度）、
        真实状态码、且做了 10 秒去重。
        所以：能在日志里找到同 IP+同文件+相近时间的 JSON 行，就用日志行取代它；
        找不到的（说明该请求绕过了 nginx，直连 :5660）才保留 JSON 行。

    live 行优先
        与上面相反：origin='live' 是应用侧实时写的，渠道按 Host 判定、IP 来自
        X-Real-IP，比日志行的"路径+UA 推断"更准。日志行一旦被同 IP+同文件的 live 行
        覆盖就整条跳过，否则同一笔下载会被记两次。
    """
    store = stats_store.StatsStore(data_dir)
    store.init_schema()
    with store._lock, store._connect() as conn:
        n = conn.execute("DELETE FROM download_event WHERE origin=?", (ORIGIN,)).rowcount
    if n:
        print("  先清理旧的 %s 行: %d" % (ORIGIN, n))
    written = skipped = 0
    for ts, ip, fname, status, ua, ch, cl in rows:
        version, ftype, arch = stats_store.parse_file(fname)
        with store._lock, store._connect() as conn:
            if _covered_by(conn, LIVE_ORIGIN, ts, ip, fname):
                skipped += 1
                continue
            conn.execute(
                "INSERT INTO download_event"
                " (ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,status,bytes,origin)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (ts, datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d"),
                 version, fname, ftype, arch, ch, cl,
                 ip, stats_store.classify_ip(ip), ua[:400], status, 0, ORIGIN),
            )
        written += 1
    if skipped:
        print("  跳过已被 live 行覆盖的日志行: %d（实时记录优先，避免同一笔数两次）" % skipped)
    print("  已写入 %d 行 (origin=%s)" % (written, ORIGIN))

    if merge_legacy_json:
        with store._lock, store._connect() as conn:
            superseded = conn.execute(
                "DELETE FROM download_event WHERE origin='legacy-json' AND EXISTS ("
                "  SELECT 1 FROM download_event b WHERE b.origin IN (?, ?) "
                "    AND b.ip=download_event.ip AND b.file=download_event.file "
                "    AND ABS(b.ts-download_event.ts)<=?)",
                (ORIGIN, LIVE_ORIGIN, SUPERSEDE_WINDOW),
            ).rowcount
            left = conn.execute(
                "SELECT COUNT(*) FROM download_event WHERE origin='legacy-json'"
            ).fetchone()[0]
        print("  被日志/live 行取代的 legacy-json 行: %d（剩余 %d 行，多为绕过 nginx 的直连请求）"
              % (superseded, left))
    return written


def dedupe_live(data_dir, apply=False):
    """删掉被 live 行覆盖的 legacy-nginx 行（同 IP + 同文件 + 120 秒内）。

    回填时已经会跳过这些行，这里只用来清理历史遗留：live 是 2026-09-29 才启用的，
    启用后有人跑过一次回填，就留下了 6 条重复行。
    """
    store = stats_store.StatsStore(data_dir)
    store.init_schema()
    cond = ("origin=? AND EXISTS ("
            "  SELECT 1 FROM download_event b WHERE b.origin=? "
            "    AND b.ip=download_event.ip AND b.file=download_event.file "
            "    AND ABS(b.ts-download_event.ts)<=?)")
    args = (ORIGIN, LIVE_ORIGIN, SUPERSEDE_WINDOW)
    with store._lock, store._connect() as conn:
        if not apply:
            n = conn.execute(
                "SELECT COUNT(*) FROM download_event WHERE " + cond, args).fetchone()[0]
            print("  [dry-run] 将被删除的 legacy-nginx 重复行: %d" % n)
            return n
        n = conn.execute("DELETE FROM download_event WHERE " + cond, args).rowcount
    print("  已删除被 live 覆盖的 legacy-nginx 重复行: %d" % n)
    return n


def main():
    ap = argparse.ArgumentParser(description="把 nginx access log 回填进 mmh-stats.db")
    ap.add_argument("--log-dir", default="/var/log/nginx")
    ap.add_argument("--data-dir", default="/opt/fn-appstores-server/data")
    ap.add_argument("--apply", action="store_true", help="真正写入（默认只 dry-run）")
    ap.add_argument("--no-merge", action="store_true",
                    help="不把被覆盖的 legacy-json 行升级掉（会与日志行重复计数）")
    ap.add_argument("--dedupe-live", action="store_true",
                    help="只清理被 live 行覆盖的 legacy-nginx 重复行，不重扫日志")
    args = ap.parse_args()

    if args.dedupe_live:
        dedupe_live(args.data_dir, apply=args.apply)
        if not args.apply:
            print("\n[dry-run] 未写入。确认无误后加 --apply。")
        return 0

    if not os.path.isdir(args.log_dir):
        print("日志目录不存在: %s" % args.log_dir, file=sys.stderr)
        return 1
    rows, raw = collect(args.log_dir)
    print("扫描 %s：命中下载请求 %d 条，10 秒去重后 %d 条" % (args.log_dir, raw, len(rows)))
    report(rows)
    if not args.apply:
        print("\n[dry-run] 未写入。确认无误后加 --apply。")
        print("默认会把被日志行覆盖的 legacy-json 行升级掉（同 IP+同文件+120 秒内），")
        print("避免同一笔下载数两次；绕过 nginx 直连 :5660 的 JSON 行会保留。")
        print("已被 live 行覆盖的日志行会跳过（live 是实时记录，渠道判定更准）。")
        return 0
    print()
    apply_rows(args.data_dir, rows, merge_legacy_json=not args.no_merge)
    return 0


if __name__ == "__main__":
    sys.exit(main())
