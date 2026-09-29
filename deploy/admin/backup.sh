#!/usr/bin/env bash
# MMH 后台管理 —— 备份
#
# 备份内容：审计日志 + 会话密钥（data/）、.env（含 ADMIN_TOKEN）、
#           站点配置、SNI 分流器、nginx 站点配置。
# 不备份：下载统计库、注册库、Maildir —— 那些是别的服务的资产，
#         各自有自己的备份；这里只备"后台管理自己产生的东西"。
#
#   ./backup.sh [输出目录]     默认 ./backups

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

OUT_DIR="${1:-$HERE/backups}"
mkdir -p "$OUT_DIR"
TS="$(date +%Y%m%d-%H%M%S)"
ARCHIVE="$OUT_DIR/mmh-admin-$TS.tar.gz"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }
DATA="${HOST_DATA_DIR:-/opt/mmh-admin/data}"
TOKDIR="${HOST_GITHUB_TOKEN_DIR:-/etc/mmh-admin}"

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/admin"
cp -a app nginx docker-compose.yml install.sh backup.sh README.md .env.example "$STAGE/admin/" 2>/dev/null || true
[ -f .env ] && cp -a .env "$STAGE/admin/.env"
[ -d "$DATA" ] && { mkdir -p "$STAGE/admin/data"; cp -a "$DATA"/. "$STAGE/admin/data/" 2>/dev/null || true; }

# token 单独放，打上权限提示；恢复时记得 chmod 600
if [ -f "$TOKDIR/github-token" ]; then
  mkdir -p "$STAGE/admin/secrets"
  cp -a "$TOKDIR/github-token" "$STAGE/admin/secrets/github-token"
  chmod 600 "$STAGE/admin/secrets/github-token"
fi

[ -f /usr/local/bin/mmh-synology-sni-proxy.py ] && \
  { mkdir -p "$STAGE/shared"; cp -a /usr/local/bin/mmh-synology-sni-proxy.py "$STAGE/shared/"; }
[ -f /etc/nginx/conf.d/admin.floatingice.win.conf ] && \
  { mkdir -p "$STAGE/shared/nginx"; cp -a /etc/nginx/conf.d/admin.floatingice.win.conf "$STAGE/shared/nginx/"; }

tar -czf "$ARCHIVE" -C "$STAGE" .
chmod 600 "$ARCHIVE"

echo "已备份：$ARCHIVE"
echo "  $(du -h "$ARCHIVE" | cut -f1)"
echo
echo "恢复要点："
echo "  1) 解开后把 admin/.env 放回包目录，chmod 600"
echo "  2) secrets/github-token -> $TOKDIR/github-token，chmod 600"
echo "  3) shared/mmh-synology-sni-proxy.py -> /usr/local/bin/，重启 mmh-synology-sni-proxy.service"
echo "  4) shared/nginx/*.conf -> /etc/nginx/conf.d/，nginx -t && systemctl reload nginx"
echo "  5) ./install.sh install"
