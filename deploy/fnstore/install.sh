#!/usr/bin/env bash
# MMH fnVPS 服务端一键部署 / 迁移
#
#   ./install.sh           部署或更新（幂等）
#   ./install.sh verify    只做健康检查
#   ./install.sh uninstall 停止容器（不删数据）
#
# 设计成"整个目录即部署单元"：把 deploy/fnstore/ 整个拷到目标机器上跑本脚本即可，
# 数据目录默认放在同目录下的 data/（可用 MMH_FNSTORE_DATA 覆盖）。
set -euo pipefail

PKG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PKG_DIR"

DATA_DIR="${MMH_FNSTORE_DATA:-$PKG_DIR/data}"
ENV_FILE="$PKG_DIR/.env"
NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
SNI_PROXY_DST="${SNI_PROXY_DST:-/usr/local/bin/mmh-synology-sni-proxy.py}"
SNI_UNIT="mmh-synology-sni-proxy.service"
TS="$(date +%Y%m%d-%H%M%S)"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[!]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

need() { command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1"; }

# ---------------------------------------------------------------- 检查
cmd_verify() {
  log "健康检查"
  local fail=0
  check() { # url expect_desc
    local url="$1" desc="$2"
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url" || echo 000)"
    if [ "$code" = "200" ] || [ "$code" = "206" ]; then
      printf '  \033[32mOK\033[0m   %-52s %s\n' "$url" "$code"
    else
      printf '  \033[31mFAIL\033[0m %-52s %s  (%s)\n' "$url" "$code" "$desc"; fail=1
    fi
  }
  check "http://127.0.0.1:5660/api/apps" "Go 版应用列表"
  check "http://127.0.0.1:5661/fnstore/api/stats" "Python 版统计接口"
  check "http://127.0.0.1:5661/health" "Python 版存活"

  echo
  log "群晖套件源（走公网域名）"
  local body
  body="$(curl -s --max-time 20 'https://synology.floatingice.win/?arch=x86_64&build=64570&language=chs' || true)"
  case "$body" in
    *'"packages":[]'*|*'"packages": []'*)
      warn "协议正常，但 data/downloads/ 里没有匹配的 SPK —— DSM 会搜不到 MMH"
      warn "  修复：把 mmh-synology-v<ver>-{x86_64,arm64}.spk 放进 $DATA_DIR/downloads/"
      fail=1 ;;
    *'"package":"mmh"'*|*'"package": "mmh"'*)
      printf '  \033[32mOK\033[0m   群晖源已返回 mmh 包\n' ;;
    *'FN软仓服务端'*)
      die "  请求落到了 5660（Go 版）—— nginx 里 synology.floatingice.win 的 proxy_pass 必须指向 5661" ;;
    '')
      warn "  HTTPS 无响应。若 http://synology.floatingice.win 正常而 https 不通，"
      warn "  几乎一定是 PROXY protocol 两端不一致：SNI 代理发头 ⇄ nginx 的 9443 必须带 proxy_protocol"
      fail=1 ;;
    *)
      warn "  返回内容非预期: $(printf '%s' "$body" | head -c 160)" ;;
  esac
  # 下载统计的写入方必须是 5661：/apps/ 打到 5660 就等于统计丢失
  local dl_code
  dl_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -r 0-100 \
    "http://fnapp.floatingice.win/apps/mmh-$(python3 -c "
import json,sys
try: print(json.load(open('$DATA_DIR/fn-appstores.json'))[0]['version'])
except Exception: print('0.0.0')
" 2>/dev/null || echo 0.0.0).fpk" || echo 000)"
  case "$dl_code" in
    200|206) printf '  \033[32mOK\033[0m   fnapp /apps/*.fpk 可达（下载计入 5661）\n' ;;
    *) warn "  fnapp /apps/*.fpk 返回 $dl_code —— 检查 nginx 是否把 /apps/ 指到了 5661"; fail=1 ;;
  esac

  log "/fnstore/ 管理页"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 'http://fnapp.floatingice.win:4001/fnstore/' || echo 000)"
  [ "$code" = "200" ] && printf '  \033[32mOK\033[0m   /fnstore/ 200\n' \
    || { printf '  \033[31mFAIL\033[0m /fnstore/ %s —— 检查 nginx 里 /fnstore/ 是否指向 5661\n' "$code"; fail=1; }

  echo
  log "容器"
  docker ps --format '  {{.Names}}  {{.Status}}  {{.Ports}}' \
    | grep -E 'fn-appstores-server|mmh-fnstore-admin' || warn "  两个容器没都在跑"

  echo
  [ "$fail" = "0" ] && log "全部检查通过" || warn "有检查未通过（见上）"
  return "$fail"
}

# ---------------------------------------------------------------- 卸载
cmd_uninstall() {
  log "停止容器（数据目录 $DATA_DIR 保留不动）"
  docker compose down || true
  log "如需彻底清理：rm -rf $DATA_DIR $PKG_DIR/.env"
}

# ---------------------------------------------------------------- 部署
cmd_install() {
  need docker
  need curl
  docker compose version >/dev/null 2>&1 || die "需要 docker compose v2"

  # 0) 预检：同名容器冲突
  #
  # 线上 fnVPS 目前是两个手工 `docker run` 起的容器（见 README「线上实际布局」），
  # 名字与 compose 里的 container_name 相同。直接 compose up 会因名字占用失败，
  # 更糟的是有人可能顺手 `docker rm -f` 掉正在服务的容器。
  # 所以这里拦住，并把"接管"的命令原样打印出来。
  local conflict=""
  for c in fn-appstores-server mmh-fnstore-admin; do
    docker inspect "$c" >/dev/null 2>&1 && conflict="$conflict $c"
  done
  if [ -n "$conflict" ]; then
    if [ "${MMH_FNSTORE_ADOPT:-0}" = "1" ]; then
      warn "接管现有容器:$conflict（data 是 bind mount，删容器不丢数据）"
      docker rm -f $conflict >/dev/null
    else
      warn "已存在同名容器:$conflict"
      warn "  compose 会因 container_name 冲突启动失败。先确认 data 目录位置，然后："
      warn "    docker inspect fn-appstores-server --format '{{range .Mounts}}{{.Source}}{{println}}{{end}}'"
      warn "    sed -i 's#^DATA_DIR=.*#DATA_DIR=<上一步的 data 目录>#' $ENV_FILE"
      warn "    MMH_FNSTORE_ADOPT=1 ./install.sh     # 删旧容器并按 compose 重建"
      warn "  只想体检不改动：./install.sh verify"
      die "已中止，避免误删正在服务的容器"
    fi
  fi

  # 1) 数据目录 + .env + 管理页
  mkdir -p "$DATA_DIR"/{apps,downloads,icons,previews,admin}
  if [ ! -f "$ENV_FILE" ]; then
    cp .env.example "$ENV_FILE"
    sed -i "s#^DATA_DIR=.*#DATA_DIR=$DATA_DIR#" "$ENV_FILE"
    log "已生成 $ENV_FILE（按需修改 BASE_URL / SYNOLOGY_BASE_URL）"
  fi
  grep -q "^DATA_DIR=$DATA_DIR\$" "$ENV_FILE" \
    || warn ".env 里的 DATA_DIR 与本次使用的 $DATA_DIR 不一致，请核对 $ENV_FILE"

  # 管理页必须落在 $DATA_DIR/admin/index.html —— app.py 的 ADMIN_HTML_PATH 指向那里。
  # 不要用 docker 挂载 app/admin 去遮它，否则"改了页面容器里还是旧的"。
  if [ -f "$DATA_DIR/admin/index.html" ] && ! cmp -s app/admin/index.html "$DATA_DIR/admin/index.html"; then
    cp -a "$DATA_DIR/admin/index.html" "$DATA_DIR/admin/index.html.bak-$TS"
    log "  已备份旧管理页 -> index.html.bak-$TS"
  fi
  install -m 0644 app/admin/index.html "$DATA_DIR/admin/index.html"
  log "  管理页已安装 -> $DATA_DIR/admin/index.html"

  # 2) 容器
  log "启动容器（Go 版 5660 + Python 版 5661）"
  docker compose up -d --remove-orphans
  sleep 3
  docker compose ps

  # 3) SNI 代理（443 按 SNI 分流；群晖后端带 PROXY protocol 传真实 IP）
  #
  # 必须先于 nginx 重载执行。nginx 的 9443 监听带 proxy_protocol，要求对端先发
  # PROXY 头；若先 reload nginx 再换代理，中间这段 HTTPS 群晖源是断的。
  # 反过来的顺序最坏也只是"代理发了头但 nginx 还没要求"，nginx 会直接拒掉明文
  # TLS 前的那行头……所以两边都不能单独上线，脚本里连着做，窗口在毫秒级。
  if [ -f "$SNI_PROXY_DST" ] || [ -w "$(dirname "$SNI_PROXY_DST")" ]; then
    log "安装 SNI 代理 -> $SNI_PROXY_DST"
    python3 -m py_compile sniproxy/mmh-synology-sni-proxy.py \
      || die "  SNI 代理语法错误，已中止（不会覆盖线上文件）"
    [ -f "$SNI_PROXY_DST" ] && cp -a "$SNI_PROXY_DST" "$SNI_PROXY_DST.bak-$TS"
    install -m 0755 sniproxy/mmh-synology-sni-proxy.py "$SNI_PROXY_DST"
    cat > "/etc/systemd/system/$SNI_UNIT" <<EOF
[Unit]
Description=MMH Synology HTTPS SNI proxy
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 $SNI_PROXY_DST
Restart=always
RestartSec=2
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
EOF
    systemctl daemon-reload
    systemctl enable "$SNI_UNIT" >/dev/null 2>&1 || true
    systemctl restart "$SNI_UNIT"
    log "  SNI 代理已重启"
  else
    warn "跳过 SNI 代理安装（$SNI_PROXY_DST 不可写）"
  fi

  # 4) nginx（含 9443 的 proxy_protocol；与上一步成对，缺一不可）
  if [ -d "$NGINX_CONF_DIR" ]; then
    log "安装 nginx 站点配置到 $NGINX_CONF_DIR"
    mkdir -p "/root/nginx-bak-$TS"
    for f in fnapp-floatingice.conf synology.floatingice.win.conf; do
      [ -f "$NGINX_CONF_DIR/$f" ] && cp -a "$NGINX_CONF_DIR/$f" "/root/nginx-bak-$TS/" && log "  已备份 $f"
      cp -a "nginx/$f" "$NGINX_CONF_DIR/$f"
      log "  已安装 $f"
    done
    if nginx -t 2>/dev/null; then
      systemctl reload nginx && log "  nginx 已重载"
    else
      warn "  nginx -t 失败，已回滚"
      cp -a "/root/nginx-bak-$TS/"*.conf "$NGINX_CONF_DIR/" 2>/dev/null || true
      die "  nginx 配置有误，请检查"
    fi
    if ! grep -qs 'fnstore/' "$NGINX_CONF_DIR/new-api-gateway.conf" 2>/dev/null; then
      warn "  未在 new-api-gateway.conf 里找到 /fnstore/，请手动加入："
      warn "    cat nginx/fnstore-location.snippet.conf"
    fi
  else
    warn "未发现 $NGINX_CONF_DIR，跳过 nginx 配置"
  fi

  # 5) sync.sh + cron
  log "安装同步脚本 -> $PKG_DIR/bin/sync.sh"
  chmod +x bin/sync.sh backup.sh
  if crontab -l 2>/dev/null | grep -q '/opt/fn-appstores-server/sync.sh'; then
    warn "  crontab 里还有旧路径 /opt/fn-appstores-server/sync.sh，请更新为 $PKG_DIR/bin/sync.sh"
    crontab -l 2>/dev/null | grep 'sync.sh'
  fi
  if ! crontab -l 2>/dev/null | grep -q "$PKG_DIR/bin/sync.sh"; then
    warn "  尚未加入 crontab，建议执行："
    warn "    (crontab -l 2>/dev/null; echo '0 * * * * $PKG_DIR/bin/sync.sh >> $PKG_DIR/sync.log 2>&1') | crontab -"
  fi

  echo
  cmd_verify || true
}

case "${1:-install}" in
  install)   cmd_install ;;
  verify)    cmd_verify ;;
  uninstall) cmd_uninstall ;;
  *)         die "用法: $0 [install|verify|uninstall]" ;;
esac
