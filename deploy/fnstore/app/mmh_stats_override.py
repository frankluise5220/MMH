#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""MMH 下载统计覆盖层。

为什么用"覆盖"而不是就地改写 app.py
    app.py 是一份 36 KB、被多次手工补丁过的上游文件，就地做字符串替换风险高、
    且下次上游更新会丢失。这里改为在 app.py 末尾调用一次 install(globals())：
      - record_download 通过模块全局查找被调用，重新绑定即可生效；
      - api_stats 是 Flask 端点，直接替换 flask_app.view_functions['api_stats']
        就能同时覆盖 /api/stats 与 /fnstore/api/stats 两个路由。
    因此 app.py 只需两行改动。

统计口径见 stats_store.py 的模块文档。
"""

import json
import os
from datetime import datetime

import stats_store

_store = None


def _current_app_version(data_dir):
    """读 fn-appstores.json 里当前在发的版本号（用于给 Go 版无版本的聚合行打标）。"""
    try:
        with open(os.path.join(data_dir, "fn-appstores.json"), encoding="utf-8") as f:
            apps = json.load(f)
        if isinstance(apps, list) and apps:
            return str(apps[0].get("version") or "")
    except Exception:
        pass
    return ""


def install(ns):
    """在 app.py 的模块命名空间里安装覆盖层。"""
    global _store

    flask_app = ns["flask_app"]
    DATA_DIR = ns["DATA_DIR"]
    LOCAL_DOWNLOADS_DIR = ns["LOCAL_DOWNLOADS_DIR"]
    DOWNLOADS_PATH = ns["DOWNLOADS_PATH"]
    SERVE_LOCAL_DOWNLOADS = ns["SERVE_LOCAL_DOWNLOADS"]
    GITHUB_REPO = ns["GITHUB_REPO"]
    CST = ns["CST"]
    request = ns["request"]
    jsonify = ns["jsonify"]
    _github_releases_raw = ns["_github_releases_raw"]
    _get_local_fpk_versions = ns["_get_local_fpk_versions"]
    get_all_apps = ns["get_all_apps"]

    # ---- 初始化存储 + 一次性历史导入 --------------------------------
    _store = stats_store.StatsStore(DATA_DIR)
    _store.init_schema()
    try:
        n_json = _store.import_legacy_json(DOWNLOADS_PATH)
        n_go = _store.import_go_statsdb(
            os.path.join(DATA_DIR, "stats.db"),
            default_version=_current_app_version(DATA_DIR),
        )
        if n_json or n_go:
            print(f"📊 历史统计导入完成: download-stats.json {n_json} 条, Go stats.db {n_go} 条")
    except Exception as e:
        print(f"⚠️ 历史统计导入失败: {e}")

    # ---- 覆盖 record_download -------------------------------------
    def record_download(filename):
        """记录一次下载：同 IP + 同文件 10 秒内去重（在 stats_store 内实现）。"""
        try:
            ua = request.headers.get("User-Agent", "")
            channel = stats_store.detect_channel(
                request.host, request.headers.get("X-Forwarded-Host")
            )
            client = stats_store.detect_client(ua)
            # nginx 已通过 X-Real-IP 传真实客户端 IP；SNI 代理那层走 PROXY protocol
            ip = request.headers.get("X-Real-IP") or request.remote_addr or ""
            local = os.path.exists(os.path.join(DATA_DIR, "apps", filename)) or \
                os.path.exists(os.path.join(LOCAL_DOWNLOADS_DIR, filename))
            ok = _store.record(filename, channel, client, ip, ua,
                               status=200 if local else 302)
            if ok:
                print(f"📥 下载统计: {filename} channel={channel} client={client} ip={ip}")
        except Exception as e:
            print(f"⚠️ 记录下载统计失败: {e}")

    ns["record_download"] = record_download

    # ---- 覆盖 api_stats -------------------------------------------
    def api_stats():
        try:
            try:
                days = int(request.args.get("days", 30))
            except (TypeError, ValueError):
                days = 30
            days = max(1, min(days, 365))
            include_internal = request.args.get("internal", "").lower() in ("1", "true", "yes")

            payload = _store.summary(days=days, include_internal=include_internal)
            payload["success"] = True
            payload["time"] = datetime.now(CST).isoformat(timespec="seconds")
            payload["mode"] = "local" if SERVE_LOCAL_DOWNLOADS else "redirect"
            payload["github_repo"] = GITHUB_REPO
            # 明细同样跟随 internal 开关，避免"汇总数排除了本机/内网、明细里却全是"
            payload["recent"] = _store.recent(limit=200, include_internal=include_internal)

            # GitHub Release 资产下载量：VPS 侧看不到，由 GitHub API 补齐
            github = {"releases": []}
            try:
                _github_releases_raw(force_refresh=False)
                cache = getattr(flask_app, "_gh_cache", None) or {}
                local_versions = set(_get_local_fpk_versions())
                for rel in cache.get("raw", []):
                    tag = rel.get("tag_name", "") or ""
                    ver = tag.lstrip("v")
                    if local_versions and ver not in local_versions:
                        continue
                    github["releases"].append({
                        "tag": tag,
                        "published_at": (rel.get("published_at") or "")[:10],
                        "assets": [
                            {
                                "name": a.get("name"),
                                "size": a.get("size"),
                                "download_count": a.get("download_count") or 0,
                            }
                            for a in rel.get("assets", [])
                        ],
                    })
            except Exception as e:
                print(f"⚠️ 获取 GitHub Release 失败: {e}")
            payload["github"] = github

            # 本地文件清单（apps/ 与 downloads/）
            files, local_downloads = [], []
            for base, bucket in ((os.path.join(DATA_DIR, "apps"), files),
                                 (LOCAL_DOWNLOADS_DIR, local_downloads)):
                if not os.path.isdir(base):
                    continue
                for fn in sorted(os.listdir(base)):
                    fp = os.path.join(base, fn)
                    if os.path.isfile(fp):
                        bucket.append({
                            "name": fn,
                            "size": os.path.getsize(fp),
                            "mtime": datetime.fromtimestamp(
                                os.path.getmtime(fp), tz=CST
                            ).strftime("%Y-%m-%d %H:%M:%S"),
                        })
            payload["files"] = files
            payload["local_downloads"] = local_downloads
            try:
                payload["apps"] = get_all_apps()
            except Exception:
                payload["apps"] = []
            return jsonify(payload)
        except Exception as e:
            print(f"获取下载统计失败: {e}")
            return jsonify({"success": False, "message": str(e)}), 500

    flask_app.view_functions["api_stats"] = api_stats
    print("📊 MMH 下载统计覆盖层已安装（stats_store → mmh-stats.db）")
