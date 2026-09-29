#!/usr/bin/env bash
# FN 软仓自建源自动同步脚本
# 检测 GitHub 最新 release，有新版本时自动：
#   1. 下载 mmh-fnos-v<ver>-x86_64.fpk 到 data/apps/mmh-<ver>.fpk
#   2. 更新 data/fn-appstores.json 的 version
#   3. 下载最新图标到 data/icons/mmh.PNG
#   4. 重启 fn-appstores-server 容器
# 用法：配合 crontab 定时执行，例如每小时一次：
#   0 * * * * /opt/fn-appstores-server/sync.sh >> /opt/fn-appstores-server/sync.log 2>&1
set -uo pipefail

REPO="frankluise5220/MMH"
DATA_DIR="/opt/fn-appstores-server/data"
LOG_TAG="[$(date '+%Y-%m-%d %H:%M:%S')]"

echo "$LOG_TAG ==== FN 软仓自建源同步开始 ===="

# 1. 获取 GitHub 最新 release tag（如 v0.1.30）
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")
LATEST_TAG=$(printf '%s' "$RELEASE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'])" 2>/dev/null)
RELEASE_BODY=$(printf '%s' "$RELEASE_JSON" | python3 -c "import sys,json; print(json.load(sys.stdin).get('body',''))" 2>/dev/null)
if [ -z "$LATEST_TAG" ]; then
  echo "$LOG_TAG 获取 GitHub 最新 release 失败，跳过"
  exit 1
fi
VERSION="${LATEST_TAG#v}"
echo "$LOG_TAG 最新 release: $LATEST_TAG (version=$VERSION)"

# 2. 读取当前源内版本
CURRENT=$(python3 -c "import json; print(json.load(open('${DATA_DIR}/fn-appstores.json'))[0]['version'])" 2>/dev/null)
echo "$LOG_TAG 当前源版本: $CURRENT"

# 3. 版本比较（简单比较 0.1.x）
NEWER=0
if [ "$CURRENT" != "$VERSION" ]; then
  # 用 python 比较数字版本
  NEWER=$(python3 - <<PYEOF
cv = [int(x) for x in "$CURRENT".split('.')]
nv = [int(x) for x in "$VERSION".split('.')]
while len(cv) < 3: cv.append(0)
while len(nv) < 3: nv.append(0)
print(1 if nv > cv else 0)
PYEOF
)
fi

if [ "$NEWER" != "1" ]; then
  echo "$LOG_TAG 无需更新"
  exit 0
fi

echo "$LOG_TAG 检测到新版本 $VERSION，开始同步..."

# 4. 下载 FPK（先下到临时文件，成功后再 mv，避免半截文件）
# 注意：GitHub 资产名带 v 前缀（mmh-fnos-v<ver>-x86_64.fpk），必须用 ${LATEST_TAG} 而不是 ${VERSION}
FPK_SRC="https://github.com/${REPO}/releases/download/${LATEST_TAG}/mmh-fnos-${LATEST_TAG}-x86_64.fpk"
FPK_DST="${DATA_DIR}/apps/mmh-${VERSION}.fpk"
FPK_TMP="${FPK_DST}.tmp"
echo "$LOG_TAG 下载 FPK: $FPK_SRC"
curl -fsSL -o "$FPK_TMP" "$FPK_SRC"
if [ ! -s "$FPK_TMP" ]; then
  echo "$LOG_TAG FPK 下载失败（文件为空）"
  rm -f "$FPK_TMP"
  exit 1
fi
mv -f "$FPK_TMP" "$FPK_DST"
echo "$LOG_TAG FPK 就绪: $FPK_DST ($(du -h "$FPK_DST" | cut -f1))"

# 4.5 可选：同步"本地直发"资产到 data/downloads/
# 配置 EXTRA_ASSETS="mmh-win-v<ver>-x64.zip:dist/mmh-win-x64.zip"（分号分隔，目标:Release内资产名）
# 留空则跳过；用于"只发 VPS 不发 GitHub"的文件（放入 data/downloads/ 即由 VPS 直接发送）
# 示例：EXTRA_ASSETS="mmh-win-v${LATEST_TAG}-x64.zip"
mkdir -p "${DATA_DIR}/downloads"
# 群晖套件源依赖本地 SPK：app.py 的 _synology_package_info() 只扫描 data/downloads/ 中
# 匹配 mmh-synology-v<ver>-<arch>.spk 的文件来生成 catalog；缺文件则 DSM 搜不到 MMH。
EXTRA_ASSETS="${EXTRA_ASSETS:-mmh-synology-v${VERSION}-x86_64.spk;mmh-synology-v${VERSION}-arm64.spk}"
if [ -n "${EXTRA_ASSETS:-}" ]; then
  IFS=';' 
  for name in $EXTRA_ASSETS; do
    name=$(echo "$name" | xargs)
    [ -z "$name" ] && continue
    DST="${DATA_DIR}/downloads/${name}"
    if [ -s "$DST" ]; then
      echo "$LOG_TAG 本地直发文件已存在，跳过: $name"
      continue
    fi
    SRC="https://github.com/${REPO}/releases/download/${LATEST_TAG}/${name}"
    TMP="${DST}.tmp"
    echo "$LOG_TAG 下载本地直发资产: $SRC"
    if curl -fsSL -o "$TMP" "$SRC" && [ -s "$TMP" ]; then
      mv -f "$TMP" "$DST"
      echo "$LOG_TAG 本地直发资产就绪: $DST ($(du -h "$DST" | cut -f1))"
    else
      echo "$LOG_TAG 本地直发资产下载失败（跳过）: $name"
      rm -f "$TMP"
    fi
  done
  unset IFS
fi

# 清理 downloads/ 里的旧群晖 SPK（保留最新 3 个版本 = 最多 6 个文件）
OLD_DL=$(ls -t ${DATA_DIR}/downloads/mmh-synology-v*.spk 2>/dev/null | tail -n +7 || true)
for f in $OLD_DL; do
  echo "$LOG_TAG 删除旧直发资产: $f"
  rm -f "$f"
done
# 清理旧版本包（保留最新 3 个，避免目录无限增长；更早的版本走 302 跳 GitHub，无需本地文件）
OLD_FPK=$(ls -t "${DATA_DIR}/apps/"mmh-*.fpk 2>/dev/null | tail -n +4 || true)
for f in $OLD_FPK; do
  echo "$LOG_TAG 删除旧包: $f"
  rm -f "$f"
done

# 5. 更新 fn-appstores.json version
UPDATED_AT="$(date -u +%Y-%m-%d)"
export RELEASE_BODY UPDATED_AT
python3 - <<PYEOF
import json, os
p = "${DATA_DIR}/fn-appstores.json"
with open(p, 'r', encoding='utf-8') as f:
    apps = json.load(f)
for app in apps:
    if app.get('id') == 'mmh':
        app['version'] = "$VERSION"
        # 下载地址必须是 nginx 入口（端口 80），不能写 :5660。
        # 写 :5660 会绕过 nginx 直连 Go 版容器，下载只进 Go 的 stats.db，
        # 统一的 mmh-stats.db 就统计不到（2026-09-29 修的坑）。
        app['download_url'] = "http://fnapp.floatingice.win/apps/mmh-${VERSION}.fpk"
        app['download_urls'] = {
            "x86_64": "http://fnapp.floatingice.win/apps/mmh-${VERSION}.fpk",
            "arm64": "https://github.com/${REPO}/releases/download/${LATEST_TAG}/mmh-fnos-${LATEST_TAG}-arm64.fpk"
        }
        app['changelog'] = os.environ.get('RELEASE_BODY', '')
        app['updated_at'] = os.environ.get('UPDATED_AT', '')
with open(p, 'w', encoding='utf-8') as f:
    json.dump(apps, f, ensure_ascii=False, indent=2)
print("fn-appstores.json version -> $VERSION")
PYEOF

# 6. 下载最新图标
ICON_SRC="https://raw.githubusercontent.com/${REPO}/main/public/branding/mmh-logo-pageflip-192.png?v=${VERSION}"
echo "$LOG_TAG 下载图标: $ICON_SRC"
curl -fsSL -o "${DATA_DIR}/icons/mmh.PNG" "$ICON_SRC"

# 7. 重启容器
echo "$LOG_TAG 重启容器 fn-appstores-server"
docker restart fn-appstores-server

# Python 版旁路容器（群晖套件源 + /fnstore 管理页）也要重启：
# app.py 的 app 列表缓存 TTL = 24h，不重启会长时间显示旧版本
docker restart mmh-fnstore-admin 2>/dev/null || true

echo "$LOG_TAG 同步完成: mmh ${CURRENT} -> ${VERSION}"
echo "$LOG_TAG ============================================"
