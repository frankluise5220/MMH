#!/usr/bin/env bash
# 把某个 commit 的 CI 镜像取进 VPS 的私有 draft 仓库（127.0.0.1:5001）。
#
# 为什么是"搬运"而不是"在 VPS 上构建"：VPS 只有 1.9 GB 内存，`npm run build`
# 直接 exit 134 (core dumped)——/opt/mmh-test-build/build.log 就是那次失败的记录。
# 镜像仍由 GitHub Actions 构建（push main 时产出 `sha-<短 sha>`），VPS 只负责把
# 它放进一个**公开 catalog 里看不到的**独立 registry。
#
# 用法（在 fnvps 上，root）：
#   sh /opt/mmh-draft-registry/sync-draft-image.sh --version 0.1.87 --sha d894e9c
#   sh /opt/mmh-draft-registry/sync-draft-image.sh --version 0.1.87 --tag sha-d894e9c
#
# 拉取端（你自己的测试实例）：
#   docker login fnapp.floatingice.win -u mmh          # 口令见 /etc/nginx/mmh-draft.htpasswd
#   MMH_IMAGE_SOURCE=custom
#   CUSTOM_MMH_APP_IMAGE=fnapp.floatingice.win/draft/mmh:<ver>
#   CUSTOM_MMH_UPDATER_IMAGE=fnapp.floatingice.win/draft/mmh-updater:<ver>
set -euo pipefail

DOCKER="${DOCKER:-docker}"
GHCR_OWNER="${GHCR_OWNER:-frankluise5220}"
LOCAL_REGISTRY="127.0.0.1:5001"
NAMESPACE="draft"
PUBLIC_REGISTRY="fnapp.floatingice.win"
VERSION=""
SHA=""
TAG=""
DRY_RUN=0

usage() {
  sed -n '2,24p' "$0"
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

[ -n "$VERSION" ] || usage
[ -n "$TAG" ] || { [ -n "$SHA" ] || usage; TAG="sha-$SHA"; }

run() {
  if [ "$DRY_RUN" = "1" ]; then echo "  would: $*"; else echo "  $*"; "$@"; fi
}

# 镜像里烤进了构建期的 APP_COMMIT / APP_VERSION，用它证明放进来的是这版代码，
# 而不是某个更早的 sha（GHCR 上的 tag 一旦打错，draft 通道就会悄悄发错版本）。
assert_env() {
  local image="$1" field="$2" expected="$3" actual
  actual="$("$DOCKER" image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" \
    | sed -n "s/^${field}=//p" | head -1)"
  case "$actual" in
    "$expected"*) echo "  ${field}=${actual}" ;;
    *) echo "  [FAIL] $image 的 ${field}=${actual:-<空>}，期望 ${expected}" >&2; return 1 ;;
  esac
}

echo "sync-draft-image version=$VERSION tag=$TAG -> $LOCAL_REGISTRY/$NAMESPACE"

for repo in mmh mmh-updater; do
  src="ghcr.io/$GHCR_OWNER/$repo:$TAG"
  dst="$LOCAL_REGISTRY/$NAMESPACE/$repo:$VERSION"
  echo "== $repo =="
  run "$DOCKER" pull "$src"
  if [ "$repo" = "mmh" ] && [ "$DRY_RUN" = "0" ]; then
    assert_env "$src" APP_COMMIT "$(echo "$TAG" | sed 's/^sha-//')"
    assert_env "$src" APP_VERSION "$VERSION"
  fi
  run "$DOCKER" tag "$src" "$dst"
  run "$DOCKER" push "$dst"
done

if [ "$DRY_RUN" = "0" ]; then
  echo
  echo "已就绪（仅需登录可见）："
  echo "  docker login $PUBLIC_REGISTRY -u mmh"
  echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh:$VERSION"
  echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh-updater:$VERSION"
  echo
  echo "占用的存储：$(du -sh /opt/mmh-draft-registry 2>/dev/null | cut -f1)"
fi
