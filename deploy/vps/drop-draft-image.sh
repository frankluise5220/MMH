#!/usr/bin/env bash
# Release 公开后清掉测试通道：删掉 draft/mmh:<ver> 与 draft/mmh-updater:<ver>。
#
# 为什么必须删：draft 仓库只为"公开前真机验证"存在，每版约 1.7 GB（两个镜像的全部
# 层；它与公开源是两个独立 registry 实例，层不能共享），公开之后留在 VPS 根盘上
# 没有任何价值。公开前的遮蔽靠"独立实例 + 公开后删除"，不靠密码。
#
# 用法（fnvps，root；必须显式确认 Release 已公开）：
#   sh drop-draft-image.sh --version 0.1.87 --confirm-published
#   sh drop-draft-image.sh --version 0.1.87 --confirm-published --dry-run
#
# 前置：公开源（127.0.0.1:5000）必须已经有同版本的 mmh 与 mmh-updater，否则
# 删掉测试源等于把还在用它升级的测试机晾在原地（0.1.78 事故的形态）。缺了就
# 先等 sync-mirror.sh 或跑 promote-draft-image.sh。
set -euo pipefail

DOCKER="${DOCKER:-docker}"
DRAFT="http://127.0.0.1:5001"
PUBLIC="http://127.0.0.1:5000"
PUBLIC_NS="frankluise5220"
VERSION=""
CONFIRMED=0
DRY_RUN=0
ACCEPT="application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json"

usage() { sed -n '2,16p' "$0"; exit 2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --confirm-published) CONFIRMED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || usage
[ "$CONFIRMED" = "1" ] || {
  echo "拒绝执行：Release 还没公开就删测试源，测试机将无处可升。" >&2
  echo "确认 Release 已 published 后加 --confirm-published。" >&2
  exit 1
}

digest_of() { # $1 = registry base, $2 = repo path
  curl -fsSI -H "Accept: $ACCEPT" "$1/v2/$2/manifests/$VERSION" 2>/dev/null \
    | tr -d '\r' | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: //p' | head -1
}

echo "drop-draft-image version=$VERSION"

missing=""
for repo in mmh mmh-updater; do
  [ -n "$(digest_of "$PUBLIC" "$PUBLIC_NS/$repo")" ] || missing="$missing $repo"
done
if [ -n "$missing" ]; then
  echo "公开源还没有 $VERSION 的:$missing" >&2
  echo "先等 sync-mirror.sh（每小时第 10 分）或跑 promote-draft-image.sh --version $VERSION --confirm-published" >&2
  exit 1
fi
echo "公开源已就位：$VERSION"

for repo in mmh mmh-updater; do
  digest="$(digest_of "$DRAFT" "draft/$repo")"
  if [ -z "$digest" ]; then
    echo "  $repo: draft 里没有 $VERSION，跳过"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  would: DELETE draft/$repo@$digest"
    continue
  fi
  code="$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$DRAFT/v2/draft/$repo/manifests/$digest")"
  echo "  $repo: DELETE draft/$repo@$digest -> $code"
  [ "$code" = "202" ] || { echo "  [FAIL] 期望 202；registry 未开 REGISTRY_STORAGE_DELETE_ENABLED？" >&2; exit 1; }
done

if [ "$DRY_RUN" = "0" ]; then
  echo
  echo "回收未引用层（registry garbage-collect）："
  "$DOCKER" exec mmh-draft-registry registry garbage-collect --delete-untagged /etc/docker/registry/config.yml 2>&1 \
    | tail -3
  echo
  echo "draft 仓库剩余：$(du -sh /opt/mmh-draft-registry/data 2>/dev/null | cut -f1)"
fi
