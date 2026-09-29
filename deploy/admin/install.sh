#!/usr/bin/env bash
# MMH 后台管理 —— 安装 / 校验 / 卸载
#
#   ./install.sh install     部署（幂等，可重复执行）
#   ./install.sh cert        用 acme.sh 申请/续期 admin.floatingice.win 证书并部署到 nginx
#   ./install.sh verify      端到端自检（含登录后逐个接口探活）
#   ./install.sh status      看容器 / nginx / SNI 分流器状态
#   ./install.sh uninstall   停容器、摘 nginx 配置（不动数据）
#
# 前置依赖：docker + docker compose v2、nginx、acme.sh（仅 cert 需要）
# 共享组件：443 端口由 mmh-synology-sni-proxy.service 独占，本服务需要它把
#           admin.floatingice.win 的 SNI 转到 127.0.0.1:9444。见 README「SNI 分流」。

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

DOMAIN="admin.floatingice.win"
NGINX_CONF_SRC="nginx/admin.floatingice.win.conf"
NGINX_CONF_DST="/etc/nginx/conf.d/admin.floatingice.win.conf"
CERT_DIR="/etc/nginx/certs/$DOMAIN"
ADMIN_PORT="${ADMIN_PORT:-8791}"
SNI_PROXY_DST="/usr/local/bin/mmh-synology-sni-proxy.py"

c_ok()   { printf '\033[32m  ✓\033[0m %s\n' "$*"; }
c_bad()  { printf '\033[31m  ✗\033[0m %s\n' "$*"; }
c_warn() { printf '\033[33m  !\033[0m %s\n' "$*"; }
c_step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die()    { c_bad "$*"; exit 1; }

need_root() {
  [ "$(id -u)" = "0" ] || die "需要 root 运行（nginx / systemd / docker 都要）"
}

# ---------------------------------------------------------------- env
gen_token() {
  # 32 字节 hex；不用 openssl 以免依赖差异
  python3 - <<'PY'
import secrets
print(secrets.token_hex(32))
PY
}

ensure_env() {
  if [ ! -f .env ]; then
    cp .env.example .env
    local tok; tok="$(gen_token)"
    sed -i "s|^ADMIN_TOKEN=.*|ADMIN_TOKEN=${tok}|" .env
    c_ok "已生成 .env（含随机 ADMIN_TOKEN）"
  else
    c_ok ".env 已存在，保持不变"
  fi
  chmod 600 .env
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  [ -n "${ADMIN_TOKEN:-}" ] || die ".env 里 ADMIN_TOKEN 为空"
}

ensure_dirs() {
  mkdir -p "${HOST_DATA_DIR:-/opt/mmh-admin/data}"
  chmod 700 "${HOST_DATA_DIR:-/opt/mmh-admin/data}"
  mkdir -p "${HOST_GITHUB_TOKEN_DIR:-/etc/mmh-admin}"
  chmod 700 "${HOST_GITHUB_TOKEN_DIR:-/etc/mmh-admin}"
}

# ---------------------------------------------------------------- 依赖检查
preflight() {
  c_step "0/7 前置检查"
  need_root
  command -v docker >/dev/null || die "没有 docker"
  docker compose version >/dev/null 2>&1 || die "没有 docker compose v2（docker compose ...）"
  command -v nginx >/dev/null || die "没有 nginx"

  local fail=0
  for p in "${HOST_FNSTORE_DATA:-/opt/fn-appstores-server/data}" \
           "${HOST_REGISTRATION_DATA:-/opt/mmh-registration/data}" \
           "${HOST_VMAIL_ROOT:-/var/vmail/floatingice.win}"; do
    if [ -d "$p" ]; then c_ok "数据目录存在：$p"; else c_bad "数据目录缺失：$p"; fail=1; fi
  done
  [ "$fail" = 0 ] || die "先补齐上面的数据目录，或在 .env 里改对宿主路径"

  if [ -f "$SNI_PROXY_DST" ] && grep -q "$DOMAIN" "$SNI_PROXY_DST"; then
    c_ok "SNI 分流器已包含 $DOMAIN 路由"
  else
    c_warn "SNI 分流器尚未包含 $DOMAIN —— 请先执行 ./install.sh sni（否则 https 不通）"
  fi
}

# ---------------------------------------------------------------- SNI 分流
install_sni() {
  c_step "SNI 分流器：确认 $DOMAIN 路由"
  [ -f "$SNI_PROXY_DST" ] || die "找不到 $SNI_PROXY_DST，请先部署 mmh-synology-sni-proxy"

  if grep -q "\"$DOMAIN\"" "$SNI_PROXY_DST"; then
    c_ok "已有 $DOMAIN 路由，跳过"
  else
    c_warn "当前分流器没有 $DOMAIN 路由。"
    c_warn "分流器的权威副本在 deploy/fnstore/sniproxy/mmh-synology-sni-proxy.py，"
    c_warn "请用那份覆盖 $SNI_PROXY_DST 后重启 mmh-synology-sni-proxy.service。"
    die "分流器未就绪"
  fi

  systemctl is-active --quiet mmh-synology-sni-proxy.service \
    && c_ok "mmh-synology-sni-proxy.service 运行中" \
    || die "mmh-synology-sni-proxy.service 未运行"
}

# ---------------------------------------------------------------- 证书
issue_cert() {
  c_step "证书：$DOMAIN"
  local acme="/root/.acme.sh/acme.sh"
  [ -x "$acme" ] || die "找不到 $acme"

  if [ -d "/root/.acme.sh/${DOMAIN}_ecc" ]; then
    c_ok "证书已存在，尝试续期"
    "$acme" --renew -d "$DOMAIN" --ecc || c_warn "续期跳过（未到期属正常）"
  else
    c_ok "用 DNS-01（Cloudflare）签发"
    "$acme" --issue -d "$DOMAIN" --dns dns_cf --keylength ec-256
  fi

  mkdir -p "$CERT_DIR"
  "$acme" --install-cert -d "$DOMAIN" --ecc \
    --fullchain-file "$CERT_DIR/fullchain.cer" \
    --key-file       "$CERT_DIR/${DOMAIN}.key" \
    --reloadcmd      "nginx -s reload"
  chmod 600 "$CERT_DIR/${DOMAIN}.key"
  c_ok "证书已部署到 $CERT_DIR"
}

deploy_nginx() {
  c_step "nginx：安装站点配置"
  [ -f "$CERT_DIR/fullchain.cer" ] || die "证书不存在：$CERT_DIR/fullchain.cer（先跑 ./install.sh cert）"

  if [ -f "$NGINX_CONF_DST" ] && ! cmp -s "$NGINX_CONF_SRC" "$NGINX_CONF_DST"; then
    cp -a "$NGINX_CONF_DST" "${NGINX_CONF_DST}.bak-$(date +%Y%m%d%H%M%S)"
    c_ok "已备份旧配置"
  fi
  install -m 0644 "$NGINX_CONF_SRC" "$NGINX_CONF_DST"

  nginx -t || die "nginx 配置校验失败，已保留原文件，请手动回滚"
  systemctl reload nginx
  c_ok "nginx 已加载 $DOMAIN"
}

# ---------------------------------------------------------------- 容器
deploy_container() {
  c_step "容器：构建并启动"
  docker compose pull --quiet || c_warn "镜像拉取有告警，继续"
  docker compose up -d --force-recreate
  c_ok "docker compose up 完成"

  printf '  等待健康检查'
  local i
  for i in $(seq 1 40); do
    if curl -fsS --max-time 3 "http://127.0.0.1:${ADMIN_PORT}/api/health" >/dev/null 2>&1; then
      printf '\n'; c_ok "服务已就绪：http://127.0.0.1:${ADMIN_PORT}/"
      return 0
    fi
    printf '.'; sleep 1.5
  done
  printf '\n'
  c_bad "等待超时，最近日志："
  docker compose logs --tail 40 mmh-admin || true
  return 1
}

# ---------------------------------------------------------------- 校验
verify() {
  c_step "端到端自检"
  # shellcheck disable=SC1091
  set -a; . ./.env; set +a
  local base="http://127.0.0.1:${ADMIN_PORT}"
  local fail=0

  probe() { # probe <desc> <expected-status> <curl args...>
    local desc="$1"; shift
    local want="$1"; shift
    local got
    got="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@" || echo 000)"
    if [ "$got" = "$want" ]; then c_ok "$desc → $got"; else c_bad "$desc → $got（期望 $want）"; fail=1; fi
  }

  probe "容器 /api/health" 200 "$base/api/health"
  probe "未登录访问 /api/overview 应 401" 401 "$base/api/overview"
  probe "静态首页" 200 "$base/"

  # 口令可能已经在 UI 里改过 —— 那种情况下以 DATA_DIR/admin-token 文件为准，
  # 它优先于 .env 的 ADMIN_TOKEN（见 app/auth.py）。用错了会误报"登录失败"。
  local token_file="${HOST_DATA_DIR:-/opt/mmh-admin/data}/admin-token"
  local login_token="$ADMIN_TOKEN" token_src=".env 的 ADMIN_TOKEN"
  if [ -s "$token_file" ]; then
    login_token="$(cat "$token_file")"
    token_src="$token_file（UI 改过口令）"
  fi
  c_ok "口令来源：$token_src"

  # 登录。注意：会话 cookie 带 Secure 属性，而这里是 http://127.0.0.1 明文探测，
  # curl 会拒绝把 Secure cookie 发回明文连接（浏览器走 https 不受影响）。
  # 所以不能靠 -c/-b cookie jar，必须自己把 Set-Cookie 抠出来手动带上。
  local login_headers cookie
  login_headers="$(curl -s -D - -o /dev/null --max-time 20 \
      -H 'Content-Type: application/json' \
      -d "{\"token\":\"${login_token}\"}" "$base/api/login" || true)"
  cookie="$(printf '%s' "$login_headers" | tr -d '\r' \
      | awk -F': ' 'tolower($1)=="set-cookie"{print $2}' | cut -d';' -f1)"
  if [ -n "$cookie" ]; then c_ok "登录 → 拿到会话 cookie"
  else c_bad "登录失败：没拿到 Set-Cookie"; fail=1; fi

  local hdr=(-H "Cookie: $cookie")
  for ep in "/api/me" "/api/overview" "/api/registrations/overview" \
            "/api/downloads/summary?days=30" "/api/mail/accounts" \
            "/api/mail/whoami" "/api/issues/status" "/api/audit?limit=5" \
            "/api/settings"; do
    probe "已登录 GET ${ep%%\?*}" 200 "${hdr[@]}" "$base$ep"
  done

  c_step "对外链路"
  local https_code
  https_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "https://$DOMAIN/" || echo 000)"
  if [ "$https_code" = "200" ]; then c_ok "https://$DOMAIN/ → 200"
  else c_bad "https://$DOMAIN/ → $https_code"; fail=1; fi

  echo
  if [ "$fail" = 0 ]; then c_ok "全部检查通过"; else c_bad "有检查未通过"; fi
  return "$fail"
}

status() {
  c_step "服务状态"
  docker compose ps || true
  echo
  printf '  nginx            : %s\n' "$(systemctl is-active nginx || true)"
  printf '  SNI 分流器       : %s\n' "$(systemctl is-active mmh-synology-sni-proxy.service || true)"
  printf '  postfix          : %s\n' "$(systemctl is-active postfix || true)"
  printf '  opendkim         : %s\n' "$(systemctl is-active opendkim || true)"
  printf '  监听 %s      : %s\n' "$ADMIN_PORT" "$(ss -lntp 2>/dev/null | grep -c ":${ADMIN_PORT}" || echo 0)"
  printf '  监听 9444        : %s\n' "$(ss -lntp 2>/dev/null | grep -c ':9444' || echo 0)"
  echo
  printf '  审计日志         : %s 行\n' "$(wc -l < "${HOST_DATA_DIR:-/opt/mmh-admin/data}/audit.jsonl" 2>/dev/null || echo 0)"
  printf '  口令来源         : %s\n' "$([ -s "${HOST_DATA_DIR:-/opt/mmh-admin/data}/admin-token" ] && echo 'UI 设置（data/admin-token，优先）' || echo '.env 的 ADMIN_TOKEN')"
  printf '  时区             : %s\n' "$([ -s "${HOST_DATA_DIR:-/opt/mmh-admin/data}/tz" ] && echo "UI 设置（$(cat "${HOST_DATA_DIR:-/opt/mmh-admin/data}/tz" | tr -d '\n')）" || echo ".env 的 TZ_SPEC / 默认 Asia/Shanghai")"
  printf '  GitHub token     : %s\n' "$([ -f "${HOST_GITHUB_TOKEN_DIR:-/etc/mmh-admin}/github-token" ] && stat -c '%A %n' "${HOST_GITHUB_TOKEN_DIR:-/etc/mmh-admin}/github-token" || echo '缺失')"
}

uninstall() {
  c_step "卸载"
  docker compose down || true
  c_ok "容器已停止"
  if [ -f "$NGINX_CONF_DST" ]; then
    mv "$NGINX_CONF_DST" "${NGINX_CONF_DST}.removed-$(date +%Y%m%d%H%M%S)"
    nginx -t && systemctl reload nginx
    c_ok "nginx 站点配置已摘除"
  fi
  c_warn "数据目录保留：${HOST_DATA_DIR:-/opt/mmh-admin/data}"
}

# ---------------------------------------------------------------- main
case "${1:-install}" in
  install)
    preflight
    ensure_dirs
    ensure_env
    install_sni
    deploy_container
    if [ -f "$CERT_DIR/fullchain.cer" ]; then deploy_nginx; else
      c_warn "证书还没就绪，跳过 nginx。跑 ./install.sh cert 后再 ./install.sh nginx"
    fi
    verify || true
    echo
    c_ok "完成。浏览器打开 https://$DOMAIN/"
    ;;
  cert)   need_root; ensure_env; issue_cert ;;
  nginx)  need_root; deploy_nginx ;;
  sni)    need_root; ensure_env; install_sni ;;
  verify) need_root; verify ;;
  status) status ;;
  uninstall) need_root; uninstall ;;
  *) sed -n '2,14p' "$0"; exit 1 ;;
esac
