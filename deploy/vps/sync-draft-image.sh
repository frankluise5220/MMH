#!/usr/bin/env bash
# 把某个 commit 的 CI 镜像取进 VPS 的私有 draft 仓库（127.0.0.1:5001）。
#
# 为什么是"搬运"而不是"在 VPS 上构建"：VPS 只有 1.9 GB 内存，`npm run build`
# 直接 exit 134 (core dumped)——/opt/mmh-test-build/build.log 就是那次失败的记录。
# 镜像仍由 GitHub Actions 构建（push main 时产出 `sha-<短 sha>`），VPS 只负责把
# 它放进一个**公开 catalog 里看不到的**独立 registry。
#
# 搬运走 crane：VPS 上 `docker pull` 会 `failed to register layer: max depth exceeded`。
#
# 用法（在 fnvps 上，root）：
#   sh /opt/mmh-draft-registry/sync-draft-image.sh --version 0.1.90 --sha 7be681b
#   sh /opt/mmh-draft-registry/sync-draft-image.sh --version 0.1.90 --tag sha-7be681b
#
# 每次同步顺带把 `latest` 指到本版，供"一直跟最新草稿"的测试机使用；版本号 tag
# 本身依旧不可变，钉版本号才能复现与回滚。`--no-alias` 可跳过 latest。
#
# 拉取端（测试实例，不用登录、不用改 compose）：
#   MMH_IMAGE_SOURCE=custom
#   CUSTOM_MMH_APP_IMAGE=fnapp.floatingice.win/draft/mmh:<ver>
#   CUSTOM_MMH_UPDATER_IMAGE=fnapp.floatingice.win/draft/mmh-updater:<ver>
#   443 反代对 /v2/ 匿名只读（auth_basic off），push 只走本机 127.0.0.1:5001。
set -euo pipefail

CRANE="${CRANE:-crane}"
GHCR_OWNER="${GHCR_OWNER:-frankluise5220}"
LOCAL_REGISTRY="127.0.0.1:5001"
NAMESPACE="draft"
PUBLIC_REGISTRY="fnapp.floatingice.win"
ALIAS="latest"
VERSION=""
SHA=""
TAG=""
DRY_RUN=0

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed '$d'
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="${2:-}"; shift 2 ;;
    --sha) SHA="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --no-alias) ALIAS=""; shift ;;
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

# index 没有 config blob，先取 amd64 子 manifest 再读它的 config；单 manifest 直接用。
config_ref() {
  local ref="$1" digest
  digest="$("$CRANE" manifest "$ref" --insecure 2>/dev/null \
    | grep -o '"digest": *"sha256:[0-9a-f]*"' | head -1 | grep -o 'sha256:[0-9a-f]*')"
  if [ -n "$digest" ]; then echo "$ref@$digest"; else echo "$ref"; fi
}

# 镜像里烤进了构建期的 APP_COMMIT / APP_VERSION，用它证明放进来的是这版代码，
# 而不是某个更早的 sha（GHCR 上的 tag 一旦打错，draft 通道就会悄悄发错版本）。
assert_env() {
  local image="$1" field="$2" expected="$3" actual
  actual="$("$CRANE" config "$(config_ref "$image")" --insecure 2>/dev/null \
    | grep -o "${field}=[^\"]*" | head -1 | cut -d= -f2-)"
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
  run "$CRANE" copy "$src" "$dst" --insecure
  if [ "$repo" = "mmh" ] && [ "$DRY_RUN" = "0" ]; then
    assert_env "$dst" APP_COMMIT "$(echo "$TAG" | sed 's/^sha-//')"
    assert_env "$dst" APP_VERSION "$VERSION"
  fi
  if [ -n "$ALIAS" ]; then
    run "$CRANE" tag "$dst" "$ALIAS" --insecure
  fi
done

if [ "$DRY_RUN" = "0" ]; then
  echo
  echo "已就绪（匿名可拉，公开后删除）："
  echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh:$VERSION"
  echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh-updater:$VERSION"
  if [ -n "$ALIAS" ]; then
    echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh:$ALIAS（浮动标签，指向本版）"
    echo "  $PUBLIC_REGISTRY/$NAMESPACE/mmh-updater:$ALIAS（浮动标签，指向本版）"
  fi
  echo
  echo "占用的存储：$(du -sh /opt/mmh-draft-registry 2>/dev/null | cut -f1)"
fi
