#!/usr/bin/env bash
# 备份 MMH fnVPS 服务端：数据目录 + 配置 + crontab
#
#   ./backup.sh                备份到 ./backups/
#   ./backup.sh /path/to/dir   备份到指定目录
#   SKIP_BINARIES=1 ./backup.sh   跳过 apps/ 与 downloads/（安装包可从 GitHub 重下）
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PKG_DIR"

DATA_DIR="${MMH_FNSTORE_DATA:-$PKG_DIR/data}"
OUT_DIR="${1:-$PKG_DIR/backups}"
TS="$(date +%Y%m%d-%H%M%S)"
NAME="mmh-fnstore-$TS.tar.gz"

mkdir -p "$OUT_DIR"

EXCLUDES=()
if [ "${SKIP_BINARIES:-0}" = "1" ]; then
  EXCLUDES+=(--exclude='./data/apps' --exclude='./data/downloads')
fi

echo "==> 备份到 $OUT_DIR/$NAME"
tar -czf "$OUT_DIR/$NAME" \
  "${EXCLUDES[@]}" \
  --exclude='./backups' \
  --exclude='./.git' \
  -C "$PKG_DIR" \
  $( [ -d "$DATA_DIR" ] && echo data ) \
  $( [ -f .env ] && echo .env ) \
  app nginx sniproxy bin \
  $( [ -f sync.log ] && echo sync.log )

# 顺带留一份 nginx 与 crontab，便于换机器
{
  echo "# nginx conf.d (MMH 相关)"
  for f in fnapp-floatingice.conf synology.floatingice.win.conf; do
    [ -f "/etc/nginx/conf.d/$f" ] && { echo "### $f"; cat "/etc/nginx/conf.d/$f"; }
  done
  echo
  echo "# crontab -l"
  crontab -l 2>/dev/null || true
} > "$OUT_DIR/mmh-fnstore-$TS.config.txt"

echo "==> 完成"
ls -lh "$OUT_DIR/$NAME" "$OUT_DIR/mmh-fnstore-$TS.config.txt"
echo
echo "恢复到新机器："
echo "  tar -xzf $NAME -C /目标目录"
echo "  cd /目标目录 && ./install.sh"
