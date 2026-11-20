#!/usr/bin/env bash
# 在 fnvps 上把 mmh-draft-v2.conf 挂进 fnapp.floatingice.win 的 443 站点。
#
# 幂等：重复执行只在缺少 include 时插入一次。改前留 .bak-<时间戳>，改完先 nginx -t
# 再 reload，配置不合法时不会把线上站点带下去。
set -euo pipefail

CONF=/etc/nginx/conf.d/fnapp-https.conf
SNIPPET=/etc/nginx/snippets/mmh-draft-v2.conf

[ -f "$SNIPPET" ] || { echo "缺少 $SNIPPET" >&2; exit 1; }

cp "$CONF" "$CONF.bak-$(date +%Y%m%d%H%M)"

if ! grep -q 'mmh-draft-v2' "$CONF"; then
  python3 - "$CONF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
needle = "    location /fnstore/ {"
if needle not in text:
    sys.exit("锚点 location /fnstore/ 不存在，人工检查该文件")
addition = "    include /etc/nginx/snippets/mmh-draft-v2.conf;\n\n"
open(path, 'w', encoding='utf-8').write(text.replace(needle, addition + needle, 1))
PY
  echo "已插入 include"
else
  echo "include 已存在，跳过"
fi

nginx -t
systemctl reload nginx
echo RELOADED
