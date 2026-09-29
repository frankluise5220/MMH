#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MMH 下载统计：统一事件存储 + 汇总（单一事实来源）。

存储位置
    <data_dir>/mmh-stats.db   —— 刻意与 Go 版 fn-appstores-server 的 stats.db 分开，
    因为那边有 app_ratings 评分表，共用文件会互相破坏。

维度
    channel    渠道：github / fnstore / fndepot / synology / fnos / vps
    client     客户端软件：fnstore-client / fndepot-plugin / synology-dsm /
               browser / curl / wget / powershell / scanner / unknown / other
    date       日期（Asia/Shanghai，YYYY-MM-DD）
    version    版本号，如 0.1.66
    file_type  文件类型：fnos-fpk / synology-spk / win-exe / win-zip / nas-zip / android-apk / other
    arch       架构：x86_64 / arm64 / x64 / any / ''

约定
    - 只记录 status ∈ {200, 206, 302} 的请求；404 扫描探测不入库。
    - 同 (ip, file) 在 DEDUP_WINDOW 秒内只记一次（防 FnDepot 轮询重复计数）。
    - ip_kind 区分 public / loopback / private / unknown。仪表盘默认**只排除
      loopback + private**（= 本机探针 / 内网流量），但内部记录不丢弃，单独展示，
      避免"127.0.0.1 刷屏"。
      注意这里刻意不是"只保留 public"：unknown 是历史聚合导入行（Go 版 stats.db
      只有 (app,date,count)，没有 IP），把它们滤掉会让 0.1.66 这类真实下载重新消失。
"""

import ipaddress
import os
import re
import sqlite3
import threading
import time
from datetime import datetime, timedelta, timezone

CST = timezone(timedelta(hours=8))
DEDUP_WINDOW = 10.0
COUNTED_STATUS = (200, 206, 302)

# ---------------------------------------------------------------- 维度定义

CHANNELS = ["fnstore", "synology", "fndepot", "vps", "github", "fnos"]
CHANNEL_LABELS = {
    "fnstore": "FN软仓专属源",
    "synology": "群晖套件源",
    "fndepot": "FnDepot",
    "vps": "直连 VPS",
    "github": "GitHub Release",
    "fnos": "飞牛应用中心",
}
# 飞牛应用中心从 GitHub 直连下载，VPS 侧不可见，恒为 0（保留列以便对齐口径）
CHANNEL_UNMEASURABLE = {"fnos"}

CLIENTS = [
    "fnstore-client", "fndepot-plugin", "synology-dsm",
    "browser", "curl", "wget", "powershell", "scanner", "other", "unknown",
]
CLIENT_LABELS = {
    "fnstore-client": "FN软仓客户端",
    "fndepot-plugin": "FnDepot 插件",
    "synology-dsm": "群晖 DSM",
    "browser": "浏览器",
    "curl": "curl",
    "wget": "wget",
    "powershell": "PowerShell",
    "scanner": "扫描器/爬虫",
    "other": "其它",
    "unknown": "未知",
}

FILE_TYPE_LABELS = {
    "fnos-fpk": "fnOS FPK",
    "synology-spk": "群晖 SPK",
    "win-exe": "Windows 安装包",
    "win-zip": "Windows 免安装",
    "nas-zip": "NAS ZIP",
    "android-apk": "Android APK",
    "other": "其它",
}

ARCH_LABELS = {"x86_64": "x86_64", "arm64": "arm64", "x64": "x64", "any": "通用", "": "未标注"}

# ---------------------------------------------------------------- 识别函数

_VER_RE = re.compile(r"(\d+\.\d+\.\d+)")
_ARCH_RE = re.compile(r"(x86_64|arm64|x64|aarch64)", re.I)


def parse_file(filename):
    """文件名 -> (version, file_type, arch)。"""
    n = (filename or "").strip()
    low = n.lower()

    m = _VER_RE.search(low)
    version = m.group(1) if m else ""

    arch = ""
    ma = _ARCH_RE.search(low)
    if ma:
        arch = {"aarch64": "arm64"}.get(ma.group(1).lower(), ma.group(1).lower())

    if low.endswith(".spk") or "synology" in low:
        ftype = "synology-spk"
    elif low.endswith(".exe") or "setup" in low:
        ftype = "win-exe"
    elif low.endswith(".apk") or "android" in low:
        ftype = "android-apk"
    elif "nas" in low and low.endswith(".zip"):
        ftype = "nas-zip"
    elif low.endswith(".zip"):
        ftype = "win-zip"
    elif low.endswith(".fpk") or low.endswith(".fpk.tmp"):
        ftype = "fnos-fpk"
    else:
        ftype = "other"

    # 本地直发的 mmh-<ver>.fpk 不带架构，实际只出 x86_64
    if ftype == "fnos-fpk" and not arch:
        arch = "x86_64"
    if ftype == "nas-zip":
        arch = "any"

    return version, ftype, arch


def classify_ip(ip):
    """public / loopback / private / unknown"""
    s = (ip or "").strip()
    if not s:
        return "unknown"
    try:
        addr = ipaddress.ip_address(s)
    except ValueError:
        return "unknown"
    if addr.is_loopback:
        return "loopback"
    if addr.is_private or addr.is_link_local:
        return "private"
    return "public"


def detect_client(ua):
    """User-Agent -> 客户端软件。顺序即优先级。"""
    u = (ua or "").strip()
    if not u:
        return "unknown"
    low = u.lower()

    if "fndepot" in low:
        return "fndepot-plugin"
    if "fn-appstores" in low or "fnappstore" in low or "fnstore" in low or "软仓" in u:
        return "fnstore-client"
    if "synology" in low or "diskstation" in low or "dsm" in low:
        return "synology-dsm"
    if low.startswith("curl"):
        return "curl"
    if low.startswith("wget"):
        return "wget"
    if "powershell" in low:
        return "powershell"
    if any(k in low for k in ("bot", "spider", "crawl", "scanner", "nmap", "zgrab",
                              "masscan", "libredtail", "python-requests", "go-http-client")):
        return "scanner"
    if "mozilla" in low or "applewebkit" in low or "gecko" in low or "firefox" in low:
        return "browser"
    return "other"


def detect_channel(host, forwarded_host):
    """按 Host 判定渠道。

    synology.floatingice.win  -> synology   群晖套件源
    fnapp.floatingice.win     -> fnstore    MMH 专属软件源（含 4001 管理页触发的下载）
    其它 / 直连端口           -> vps         直连 5660
    飞牛应用中心直连 GitHub，不经 VPS，无法在此判定。
    """
    h = (host or "").split(",", 1)[0].strip().lower().split(":", 1)[0]
    fh = (forwarded_host or "").split(",", 1)[0].strip().lower().split(":", 1)[0]
    if h == "synology.floatingice.win" or fh == "synology.floatingice.win":
        return "synology"
    if h == "fnapp.floatingice.win" or fh == "fnapp.floatingice.win":
        return "fnstore"
    return "vps"


# ---------------------------------------------------------------- 存储

SCHEMA = """
CREATE TABLE IF NOT EXISTS download_event (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    ts         INTEGER NOT NULL,
    date       TEXT    NOT NULL,
    version    TEXT    NOT NULL DEFAULT '',
    file       TEXT    NOT NULL,
    file_type  TEXT    NOT NULL DEFAULT 'other',
    arch       TEXT    NOT NULL DEFAULT '',
    channel    TEXT    NOT NULL DEFAULT 'vps',
    client     TEXT    NOT NULL DEFAULT 'unknown',
    ip         TEXT    NOT NULL DEFAULT '',
    ip_kind    TEXT    NOT NULL DEFAULT 'unknown',
    ua         TEXT    NOT NULL DEFAULT '',
    status     INTEGER NOT NULL DEFAULT 200,
    bytes      INTEGER NOT NULL DEFAULT 0,
    origin     TEXT    NOT NULL DEFAULT 'live'
);
CREATE INDEX IF NOT EXISTS idx_ev_date    ON download_event(date);
CREATE INDEX IF NOT EXISTS idx_ev_ver     ON download_event(version);
CREATE INDEX IF NOT EXISTS idx_ev_channel ON download_event(channel);
CREATE INDEX IF NOT EXISTS idx_ev_ipfile  ON download_event(ip, file, ts);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class StatsStore:
    def __init__(self, data_dir):
        self.data_dir = data_dir
        self.path = os.path.join(data_dir, "mmh-stats.db")
        self._lock = threading.Lock()
        os.makedirs(data_dir, exist_ok=True)

    # -- 基础 --------------------------------------------------------

    def _connect(self):
        conn = sqlite3.connect(self.path, timeout=10)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        return conn

    def init_schema(self):
        with self._lock, self._connect() as conn:
            conn.executescript(SCHEMA)

    def _meta_get(self, conn, key):
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return row["value"] if row else None

    def _meta_set(self, conn, key, value):
        conn.execute(
            "INSERT INTO meta(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, str(value)),
        )

    # -- 写入 --------------------------------------------------------

    def record(self, filename, channel, client, ip, ua, status=200,
               size=0, ts=None, origin="live"):
        """记录一次下载。返回 True 表示入库，False 表示被去重/状态码过滤。"""
        if status not in COUNTED_STATUS:
            return False
        now = int(ts if ts is not None else time.time())
        version, ftype, arch = parse_file(filename)
        kind = classify_ip(ip)
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT ts FROM download_event WHERE ip=? AND file=? ORDER BY ts DESC LIMIT 1",
                (ip or "", filename or ""),
            ).fetchone()
            if row and abs(now - row["ts"]) < DEDUP_WINDOW:
                return False
            conn.execute(
                "INSERT INTO download_event"
                " (ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,status,bytes,origin)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    now,
                    datetime.fromtimestamp(now, CST).strftime("%Y-%m-%d"),
                    version, filename, ftype, arch, channel, client,
                    ip or "", kind, (ua or "")[:400], int(status), int(size or 0), origin,
                ),
            )
        return True

    # -- 历史导入 ----------------------------------------------------

    def import_legacy_json(self, path):
        """导入旧版 download-stats.json 的 log[] 数组（一次性、幂等）。"""
        import json
        if not path or not os.path.exists(path):
            return 0
        with self._lock, self._connect() as conn:
            if self._meta_get(conn, "imported_legacy_json") == "1":
                return 0
        try:
            data = json.load(open(path, encoding="utf-8"))
        except Exception:
            return 0
        entries = data.get("log") or []
        # 旧记录没有 UA，按渠道反推一个合理客户端，避免全部落进 unknown
        channel_client = {
            "synology": "synology-dsm",
            "fndepot": "fndepot-plugin",
            "fnstore": "fnstore-client",
            "vps": "unknown",
        }
        n = 0
        for e in entries:
            ts = _parse_legacy_time(e.get("time"))
            if ts is None:
                continue
            ch = e.get("source") or "vps"
            if ch not in CHANNELS:
                ch = "vps"
            fname = e.get("file") or ""
            version, ftype, arch = parse_file(fname)
            ip = e.get("ip") or ""
            with self._lock, self._connect() as conn:
                conn.execute(
                    "INSERT INTO download_event"
                    " (ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,status,bytes,origin)"
                    " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (
                        ts, datetime.fromtimestamp(ts, CST).strftime("%Y-%m-%d"),
                        version, fname, ftype, arch, ch,
                        channel_client.get(ch, "unknown"),
                        ip, classify_ip(ip), "", 200, 0, "legacy-json",
                    ),
                )
            n += 1
        with self._lock, self._connect() as conn:
            self._meta_set(conn, "imported_legacy_json", "1")
        return n

    def import_go_statsdb(self, path, default_version=""):
        """导入 Go 版 stats.db 的 download_daily 聚合（一次性、幂等）。

        Go 版只有 (app_id, date, count) 粒度，没有 IP/UA/版本，因此记为聚合行，
        origin='legacy-go' 以便审计。

        default_version：导入时 fn-appstores.json 里的当前版本。Go 版不记版本，
        但 5660 当时在发的就是那个版本的 FPK，用它标注比留空（仪表盘显示"未标注"）
        更接近事实；这是推断，不是实测，故保留 origin 标记。
        """
        if not path or not os.path.exists(path):
            return 0
        with self._lock, self._connect() as conn:
            if self._meta_get(conn, "imported_go_statsdb") == "1":
                return 0
        rows = []
        try:
            src = sqlite3.connect(path, timeout=10)
            src.row_factory = sqlite3.Row
            for r in src.execute("SELECT date, count FROM download_daily"):
                rows.append((r["date"], int(r["count"] or 0)))
            src.close()
        except Exception:
            return 0
        if default_version:
            fname = "mmh-%s.fpk" % default_version
            ver, ftype, arch = parse_file(fname)
        else:
            fname, ver, ftype, arch = "mmh（Go 版聚合）", "", "fnos-fpk", "x86_64"
        n = 0
        for date, count in rows:
            if count <= 0:
                continue
            try:
                dt = datetime.strptime(date, "%Y-%m-%d").replace(tzinfo=CST)
            except ValueError:
                continue
            for i in range(count):
                ts = int((dt + timedelta(seconds=i)).timestamp())
                with self._lock, self._connect() as conn:
                    conn.execute(
                        "INSERT INTO download_event"
                        " (ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,status,bytes,origin)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (
                            ts, date, ver, fname, ftype, arch,
                            "fnstore", "fnstore-client", "", "unknown", "", 200, 0, "legacy-go",
                        ),
                    )
                n += 1
        with self._lock, self._connect() as conn:
            self._meta_set(conn, "imported_go_statsdb", "1")
        return n

    # -- 查询 --------------------------------------------------------

    def recent(self, limit=200, include_internal=False):
        """最近下载明细。

        默认与 summary() 同口径（排除 loopback / private）。这一点很重要：明细表不过滤、
        汇总数却过滤，就会出现"总数写着 62、明细里却混着一堆本机探针"的观感 bug。
        要看内部流量时传 include_internal=True —— 对应页面上的「含本机 / 内网记录」开关。
        """
        where = "" if include_internal else "WHERE ip_kind NOT IN ('loopback','private')"
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT ts,date,version,file,file_type,arch,channel,client,ip,ip_kind,ua,origin"
                " FROM download_event %s ORDER BY ts DESC LIMIT ?" % where, (limit,)
            ).fetchall()
        out = []
        for r in rows:
            out.append({
                "time": datetime.fromtimestamp(r["ts"], CST).strftime("%Y-%m-%d %H:%M:%S"),
                "date": r["date"], "version": r["version"], "file": r["file"],
                "file_type": r["file_type"], "arch": r["arch"],
                "channel": r["channel"], "client": r["client"],
                "ip": r["ip"], "ip_kind": r["ip_kind"], "origin": r["origin"],
            })
        return out

    def summary(self, days=30, include_internal=False):
        """渠道 × 软件 × 日期 × 版本 汇总。

        默认口径：排除 ip_kind ∈ ('loopback','private')，即本机探针与内网流量；
        public（真实外部）与 unknown（无 IP 的历史聚合导入）都计入。
        """
        where = "" if include_internal else "WHERE ip_kind NOT IN ('loopback','private')"
        not_int = "ip_kind NOT IN ('loopback','private')"
        is_int = "ip_kind IN ('loopback','private')"
        today = datetime.now(CST).strftime("%Y-%m-%d")
        since = (datetime.now(CST) - timedelta(days=days - 1)).strftime("%Y-%m-%d")

        with self._lock, self._connect() as conn:
            def q(sql, *a):
                return conn.execute(sql, a).fetchall()

            total_all = q("SELECT COUNT(*) c FROM download_event")[0]["c"]
            total_ext = q("SELECT COUNT(*) c FROM download_event WHERE %s" % not_int)[0]["c"]
            internal = total_all - total_ext
            by_ip_kind = {r["ip_kind"]: r["c"] for r in
                          q("SELECT ip_kind, COUNT(*) c FROM download_event GROUP BY ip_kind")}
            today_n = q("SELECT COUNT(*) c FROM download_event WHERE date=? AND %s" % not_int, today)[0]["c"]
            last7 = q("SELECT COUNT(*) c FROM download_event WHERE date>=? AND %s" % not_int,
                      (datetime.now(CST) - timedelta(days=6)).strftime("%Y-%m-%d"))[0]["c"]

            ch_rows = q("SELECT channel, COUNT(*) c FROM download_event %s GROUP BY channel" % where)
            by_channel = {r["channel"]: r["c"] for r in ch_rows}
            cl_rows = q("SELECT client, COUNT(*) c FROM download_event %s GROUP BY client" % where)
            by_client = {r["client"]: r["c"] for r in cl_rows}

            cc_rows = q("SELECT channel, client, COUNT(*) c FROM download_event %s "
                        "GROUP BY channel, client" % where)
            channel_client = {}
            for r in cc_rows:
                channel_client.setdefault(r["channel"], {})[r["client"]] = r["c"]

            dc_rows = q("SELECT date, channel, COUNT(*) c FROM download_event "
                        "WHERE date>=? %s GROUP BY date, channel ORDER BY date DESC"
                        % ("AND " + not_int if not include_internal else ""), since)
            date_channel = {}
            for r in dc_rows:
                date_channel.setdefault(r["date"], {})[r["channel"]] = r["c"]

            dv_rows = q("SELECT date, version, COUNT(*) c FROM download_event "
                        "WHERE date>=? %s GROUP BY date, version ORDER BY date DESC"
                        % ("AND " + not_int if not include_internal else ""), since)
            date_version = {}
            for r in dv_rows:
                date_version.setdefault(r["date"], {})[r["version"] or "未标注"] = r["c"]

            vfc_rows = q("SELECT version, file_type, channel, COUNT(*) c FROM download_event %s "
                         "GROUP BY version, file_type, channel" % where)
            version_filetype_channel = {}
            for r in vfc_rows:
                version_filetype_channel.setdefault(r["version"] or "未标注", {}) \
                    .setdefault(r["file_type"], {})[r["channel"]] = r["c"]

            ver_rows = q("SELECT version, COUNT(*) c FROM download_event %s "
                         "GROUP BY version ORDER BY version DESC" % where)
            by_version = {r["version"] or "未标注": r["c"] for r in ver_rows}

        return {
            "totals": {
                "all": total_all,
                "external": total_ext,
                "internal": internal,
                "today": today_n,
                "last7": last7,
                "versions": len([v for v in by_version if v != "未标注"]),
            },
            "channels": CHANNELS,
            "channel_labels": CHANNEL_LABELS,
            "clients": CLIENTS,
            "client_labels": CLIENT_LABELS,
            "file_type_labels": FILE_TYPE_LABELS,
            "arch_labels": ARCH_LABELS,
            "by_channel": by_channel,
            "by_client": by_client,
            "by_ip_kind": by_ip_kind,
            "by_version": by_version,
            "channel_client": channel_client,
            "date_channel": date_channel,
            "date_version": date_version,
            "version_filetype_channel": version_filetype_channel,
            "include_internal": include_internal,
            "days": days,
        }


def _parse_legacy_time(s):
    """旧 JSON 里的 'YYYY-MM-DD HH:MM:SS'（CST 本地时间）-> unix 秒。"""
    if not s:
        return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S"):
        try:
            return int(datetime.strptime(s, fmt).replace(tzinfo=CST).timestamp())
        except ValueError:
            continue
    return None
