#!/usr/bin/env bash
# 发布confirmed后，把 draft 仓库里的当版镜像"转移"到公开源（fnapp.floatingice.win:5000）。
#
# 注意：常规发布**不需要**跑它。`release: published` 会触发 CI 推 GHCR 的 latest +
# 版本号，VPS 上的 sync-mirror.sh 每小时（10 分）从 GHCR 同步到 5000。本脚本是给
# "想让公开源立刻生效"或"CI 没跑/跑失败"的场合用的，代价是要在 VPS 本地重新上传
# 1.6 GB blob（两个 registry 实例存储独立，不能共享层）。
#
# 用法（fnvps，root；必须显式确认 Release 已公开）：
#   sh promote-draft-image.sh --version 0.1.87 --confirm-published
set -euo pipefail

DOCKER="${DOCKER:-docker}"
DRAFT_REGISTRY="127.0.0.1:5001"
PUBLIC_REGISTRY="127.0.0.1:5000"
NAMESPACE="frankluise5220"
VERSION=""
CONFIRMED=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --confirm-published) CONFIRMED=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || { echo "用法: $0 --version 0.1.87 --confirm-published" >&2; exit 2; }
[ "$CONFIRMED" = "1" ] || {
  echo "拒绝执行：Release 还没公开时把镜像推到公开源，就是 0.1.78 事故的形态。" >&2
  echo "确认 Release 已 published 后加 --confirm-published。" >&2
  exit 1
}

for repo in mmh mmh-updater; do
  echo "== $repo =="
  "$DOCKER" pull "$DRAFT_REGISTRY/draft/$repo:$VERSION"
  for tag in "$VERSION" latest; do
    "$DOCKER" tag "$DRAFT_REGISTRY/draft/$repo:$VERSION" "$PUBLIC_REGISTRY/$NAMESPACE/$repo:$tag"
    "$DOCKER" push "$PUBLIC_REGISTRY/$NAMESPACE/$repo:$tag"
  done
done

echo
echo "公开源已更新："
echo "  fnapp.floatingice.win:5000/$NAMESPACE/mmh:$VERSION  (latest 同 digest)"
