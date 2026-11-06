#!/bin/sh
# 执行器镜像的分块 node 运行时合并脚本。
#
# 背景：node 运行时被打成 tar.gz 再切成 8 块，每块单独成一个镜像层，这样镜像站
# 不会遇到「单层 24 MB」这种必然失败的 blob（详见 Dockerfile.updater 顶部注释）。
# 代价是 node 在镜像里不是一个可直接执行的完整的文件，必须在使用前合并一次。
#
# 合并结果写进容器的可写层：
#   - `docker restart` / 容器内 `exec node` 都保留，不会重复解压；
#   - `docker compose up -d` 重建容器时会重放一次（约 1–2 秒），之后照常启动。
#
# 这个脚本是镜像的 ENTRYPOINT。存量用户的 compose 文件里 `command:` 是
# `sh -lc "... exec node /updater/mmh-updater-server.mjs"`，command 只覆盖 CMD，
# 所以它会作为 `"$@"` 被本脚本 exec，node 此时已经就位。
set -eu

NODE_RUNTIME_DIR=/opt/mmh/node-runtime

is_ready() {
  [ -x /usr/bin/node ] && /usr/bin/node --version >/dev/null 2>&1
}

if ! is_ready; then
  parts_glob="$NODE_RUNTIME_DIR/part.??"
  # shellcheck disable=SC2086
  if [ -z "$(ls $parts_glob 2>/dev/null)" ]; then
    echo "ERROR: 镜像内缺少分块的 node 运行时（$NODE_RUNTIME_DIR），执行器无法启动。" >&2
    exit 1
  fi
  tmp_tgz=/tmp/mmh-node-runtime.tgz
  # busybox 的 mktemp 只接受尾部 XXXX 模板（`mktemp foo.XXXXXX.tgz` 会报
  # "Invalid argument"），容器内没有并发写这个路径的进程，固定名足够。
  rm -f "$tmp_tgz"
  # 分块按文件名排序拼接，顺序必须与 split 时一致（part.00 … part.07）。
  cat $parts_glob > "$tmp_tgz"
  tar -xzf "$tmp_tgz" -C /
  rm -f "$tmp_tgz"
fi

if ! is_ready; then
  echo "ERROR: node 运行时合并后仍不可用，执行器无法启动。" >&2
  exit 1
fi

# 没有参数时（纯 `docker run <image>`）退回到镜像的默认启动方式。
if [ "$#" -eq 0 ]; then
  set -- sh -lc 'exec node /updater/mmh-updater-server.mjs'
fi

exec "$@"
