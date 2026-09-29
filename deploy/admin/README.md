# MMH 后台管理（mmh-admin）

一个页面管三件事 + 一个盯盘：

| 面板 | 作用 | 数据源 |
|---|---|---|
| **概览** | 一屏看完下面四块 | 聚合 |
| **自动用户注册** | 看/禁用/删除注册用户、登录身份、已注册设备 | `/opt/mmh-registration/data/registration.sqlite3` |
| **下载汇总** | 渠道 × 客户端软件 × 日期 × 版本 | `/opt/fn-appstores-server/data/mmh-stats.db` |
| **邮件盯盘** | 看信、回复、标已读、移回收站 | `/var/vmail/floatingice.win/*/Maildir/` |
| **Issue 盯盘** | 看/评论/关闭/打标签 | GitHub API（`frankluise5220/MMH`） |

入口：**https://admin.floatingice.win/**

---

## 1. 链路

```
浏览器
  │  https://admin.floatingice.win
  ▼
:443  mmh-synology-sni-proxy.service        ← 按 TLS ClientHello 的 SNI 分流（纯 TCP）
  │      发 PROXY protocol v1 头（带真实客户端 IP）
  ▼
127.0.0.1:9444  nginx（admin.floatingice.win.conf，TLS 终结）
  │
  ▼
127.0.0.1:8791  mmh-admin 容器（network_mode: host，Python 3.11 标准库）
  ├── /opt/mmh-registration/data        （读写：要能禁用/删记录）
  ├── /opt/fn-appstores-server/data     （读：mmh-stats.db）
  ├── /var/vmail/floatingice.win        （读写：要能移信）
  ├── /etc/mmh-admin/github-token       （只读，600）
  └── 127.0.0.1:25 Postfix              （发信，由 opendkim 签名）
```

### 为什么 TLS 不直接 listen 443

`:443` 被 SNI 分流器独占——它还要把别的 SNI 转给 xray。所以这里跟群晖套件源
一样，只在回环 `127.0.0.1:9444` 上收 TLS，由分流器按 SNI 送过来。

**分流器是共享组件，不在本包里。** 权威副本在
`deploy/fnstore/sniproxy/mmh-synology-sni-proxy.py`，部署在
`/usr/local/bin/mmh-synology-sni-proxy.py`。本服务依赖它的 `ROUTES` 里有
`admin.floatingice.win -> 127.0.0.1:9444`；`install.sh` 会检查，缺了就直接拒绝安装。

### 为什么容器用 host 网络

要发信就得连本机 Postfix 的 `127.0.0.1:25`。Postfix 的 `mynetworks` 只有
`/32` 主机地址（`127.0.0.1/32 107.175.62.109/32 10.66.66.1/32 172.17.0.1/32 172.18.0.1/32`），
桥接网络里容器是 `172.x.0.2`，不在白名单里，`smtpd_relay_restrictions` 会
`defer_unauth_destination` 直接拒收。走 host 网络源地址就是 `127.0.0.1`，天然放行。

代价是端口不做映射——服务只 bind `127.0.0.1:8791`，外部仍然进不来。

### 为什么零第三方依赖

宿主系统 Python 是 3.6.8（AlmaLinux 8），太老；容器里刻意只用标准库
（`http.server` + `sqlite3` + `urllib` + `smtplib` + `email`），不装
flask/gunicorn。好处是不会再出现"镜像换了、依赖装不上"这类事故，`pip` 挂掉也不影响。

---

## 2. 认证

单口令换签名 cookie，没有用户体系。

- 登录成功下发 `mmh_admin_session`，值为 `<过期时间戳>.<HMAC-SHA256 前 32 字节>`。
- 签名密钥 = `HMAC(口令, DATA_DIR/session.key)`，所以**换口令会自动让所有旧会话失效**，
  不用手工清 cookie。
- cookie 带 `HttpOnly; Secure; SameSite=Lax`，有效期 7 天。
- 口令校验用 `hmac.compare_digest`，失败后 `sleep 1s` 压一压爆破。

### 口令从哪来（两层，文件优先）

| 来源 | 位置 | 说明 |
|---|---|---|
| ① 文件 | `DATA_DIR/admin-token`（600） | **优先**。UI 改过口令就写在这 |
| ② 环境变量 | `.env` 的 `ADMIN_TOKEN` | 出厂值 / 恢复兜底 |

`.env` 只以 `env_file` 注入容器（没有挂载），容器里改不了它，改完还得重启才生效。
所以「改口令」不能靠改 `.env`——那样等于必须 SSH 上 VPS 编辑文件，不叫功能。
改成写 `DATA_DIR/admin-token`（rw 挂载）+ 进程内重建签名密钥，**不用重启容器**。

### 在 UI 里改口令

顶栏「设置」页：填 当前口令 / 新口令 / 确认新口令 → 提交。

- 新口令 16–128 位，首尾与中间都不能有空白字符。
- 校验通过后 `auth.Auth.set_token()` 原子写文件并重建签名密钥，
  **所有已登录设备立即掉线**；同时给当前这位操作者补发一张新 cookie，
  所以他自己的会话不中断（这需要下发 `Set-Cookie`，因此 `panels/settings.py`
  返回 `api.Response` 而不是普通 dict）。
- 落一条 `auth.password.change` 审计（含来源 IP，不记口令本身）。

### 忘了口令怎么办

```bash
rm /opt/mmh-admin/data/admin-token      # 删掉文件口令
docker compose restart mmh-admin        # 回落 .env 的 ADMIN_TOKEN
./install.sh status                     # 确认"口令来源"变成 .env
```

`./install.sh verify` 也会自动判断该用哪一层：有 `admin-token` 文件就用文件里的口令
登录，否则用 `.env`。否则 UI 改过口令后自检会误报"登录失败"。

> ⚠️ cookie 带 `Secure`，所以**不能**用 `curl -c/-b` 去探 `http://127.0.0.1:8791`
> ——curl 会拒绝把 Secure cookie 发回明文连接（浏览器走 https 不受影响）。
> `install.sh verify` 已经改成自己抠 `Set-Cookie` 再手动带 `Cookie:` 头。

---

## 3. 时区（时间显示口径）

**默认 `Asia/Shanghai`（北京时间）**，可在「设置」页改，**不用重启**。

```
来源（后者优先）：
  ① DATA_DIR/tz        ← UI 改过就写这，以这份为准
  ② TZ_SPEC / TZ 环境变量（docker-compose 里默认 Asia/Shanghai）
  ③ 默认 Asia/Shanghai
```

spec 支持两种写法：IANA 名（`Asia/Shanghai` / `America/New_York`，走 `zoneinfo`，**含夏令时**）
或固定偏移（`UTC+8` / `+08:00` / `-0500`）。

### 哪些时间跟着变

| 位置 | 说明 |
|---|---|
| `audit.jsonl` 的 `time` 字段 | 同时记 `ts`（epoch）和 `tz`，换算法不用依赖字符串 |
| 服务日志前缀（`docker logs`） | 与页面一致，方便对着日志排查 |
| 概览「数据生成于」 | |
| 邮件 `Date` 头（回复/发信） | 带本时区偏移，收件人不会看到一串 UTC |
| 前端所有时间 | `/api/me` 带回 `tz`，前端用 `Intl.DateTimeFormat` 渲染 |

> **审计页是按 `ts` 在前端换算的，不是直接显示服务端存的字符串。**
> 所以改时区之后，**历史条目也会一起按新时区显示**——不会出现"旧记录是 UTC、
> 新记录是北京"的割裂。存的字符串只给 `grep` / `journalctl` 看。

### 哪些时间**不**跟着变

- **下载明细的时间**：`stats_store.py` 里写死 `CST`，必须和 `fnstore.floatingice.win:4001/fnstore/`
  页面口径一致。那是**业务口径**，不是显示偏好，别动。
- **注册库的 `created_at` / `updated_at` / `last_seen_at`**：存的是带 `Z` 的 UTC ISO 串，
  是数据库格式；显示时由前端换算。

### 缺 tzdata 怎么办

容器是 `python:3.11-slim`，自带 `/usr/share/zoneinfo`，`zoneinfo` 可用（线上实测 `degraded=False`）。
本地 Windows 的 Python 没有 tzdata，此时预设时区会退化成**固定偏移**，并置 `degraded` 标记、
在设置页显示一行提醒（夏令时不会自动调整）——**不会静默算错**。

配置写错（比如 `bogus/zone`）不会让服务起不来：启动时回落到默认，并在设置页显示错误。
UI 里保存非法值时直接 400，不动现有设置。

---

## 4. 部署

```bash
cd /opt/mmh-admin
./install.sh install      # 前置检查 + 起容器 + 装 nginx + 自检
./install.sh cert         # 用 acme.sh DNS-01(Cloudflare) 签发/续期证书
./install.sh verify       # 端到端自检（含登录后逐个接口探活）
./install.sh status       # 容器 / nginx / SNI / postfix 状态一览
./install.sh uninstall    # 停容器、摘 nginx 配置（不动数据）
```

顺序上 `cert` 要在 `install` 之前（`install` 发现没证书会跳过 nginx，只起容器）。

`.env` 从 `.env.example` 生成，**宿主路径**（`HOST_*`）是挂载源，按实际部署改；
**容器内路径**（`DATA_DIR` / `STATS_DB_DIR` / …）一般不用动。

GitHub token：

```bash
install -d -m 700 /etc/mmh-admin
printf '%s' 'gho_xxx' > /etc/mmh-admin/github-token
chmod 600 /etc/mmh-admin/github-token
```

刻意不放进环境变量——否则 token 会出现在 `docker inspect`、`ps e`、systemd unit 里。

---

## 5. 目录

```
deploy/admin/
├── app/
│   ├── server.py            HTTP 入口：路由/认证/静态/错误处理
│   ├── api.py               @route 注册表 + 请求上下文 + Response
│   ├── auth.py              口令 -> 签名 cookie；口令可在 UI 里改（文件覆盖环境变量）
│   ├── tzutil.py            时区解析/落盘；时间显示口径（文件覆盖环境变量）
│   ├── audit.py             审计日志（append-only JSONL）
│   ├── config.py            全部配置（读环境变量）
│   ├── stats_store.py       ← 逐字拷贝自 deploy/fnstore/app/stats_store.py
│   ├── panels/
│   │   ├── overview.py      概览（复用各面板取数函数，不另写 SQL）
│   │   ├── registrations.py 自动用户注册
│   │   ├── downloads.py     下载汇总
│   │   ├── mail.py          邮件盯盘
│   │   ├── issues.py        GitHub issue 盯盘
│   │   └── settings.py      设置：改口令、改时区（+ 只读的服务信息）
│   └── static/              index.html / app.js / style.css（原生 JS，无构建）
├── nginx/admin.floatingice.win.conf
├── docker-compose.yml
├── .env.example
├── install.sh
├── backup.sh
└── README.md
```

### `stats_store.py` 是拷贝，不是引用

下载口径必须和 `fnapp.floatingice.win:4001/fnstore/` 完全一致，所以直接拷过来复用
同一份实现（而不是重写 SQL）。**改了一边必须同步另一边**：

```bash
diff app/stats_store.py ../fnstore/app/stats_store.py   # 应该没有输出
```

口径：排除 `ip_kind ∈ ('loopback','private')`，保留 `public` 与 `unknown`
（`unknown` 是 Go 版只记 `(app,date,count)` 的历史聚合导入行）。
把 `unknown` 也滤掉，`0.1.66` 这类真实下载会重新"消失"——这个坑踩过一次。

**汇总数与「最近下载明细」必须是同一套口径。** 一开始 `summary()` 过滤了 `loopback/private`，
`recent()` 却一行都没滤，于是页面出现「总数写着 62、明细里却混着一堆 `127.0.0.1` /
`172.17.0.1` / `107.175.62.109`」的观感 bug。现在 `recent()` 也有 `include_internal`
（默认 `False`），页面上的「含本机 / 内网记录」复选框同时作用于汇总与明细；
每行 IP 后面还会标出归属（`公网` / `本机` / `内网` / `无 IP`）——
`107.175.62.109` 是 VPS 自己的公网 IP，`ip_kind` 是 `public`，不标出来就看不穿。

另外 `live` 行（应用侧实时写）**优先于** `legacy-nginx` 回填行，
去重规则见 `deploy/fnstore/README.md` 的「历史回填」。

---

## 6. 写操作与审计

所有写操作都会落 `DATA_DIR/audit.jsonl`（一行一条 JSON，append-only，不轮转）。

| action | 说明 |
|---|---|
| `login` | 登录成功/失败（含来源 IP） |
| `auth.password.change` | 改口令（记来源 IP 与新口令长度，**不记口令本身**） |
| `settings.timezone` | 改时区（记 from / to） |
| `registration.principal.status` | 启用/禁用用户（禁用会级联禁用其全部设备） |
| `registration.principal.delete` | 删除用户及其身份、设备 |
| `registration.installation.status` / `.delete` | 单台设备启用/禁用/删除 |
| `registration.identity.delete` | 删除某个登录身份 |
| `mail.flag` / `mail.move` / `mail.delete` | 标记已读、移回收站、彻底删除 |
| `mail.reply` / `mail.send` | 回复 / 发信（含 Message-ID） |
| `issue.comment` / `issue.state` / `issue.labels` | 评论 / 关闭重开 / 改标签 |

几个刻意的安全边界：

- **彻底删除邮件只允许对回收站里的邮件**——直接删收件箱太容易误操作。
- **禁用 principal 会级联禁用其全部设备**。否则设备照常工作，"禁用账号"就是假的。
- **邮件正文在 iframe `sandbox=""` 里渲染**（HTML 邮件），脚本跑不起来。
- **文件名白名单**：Maildir 文件名必须匹配 `[A-Za-z0-9._:@+=,-]`，且 `realpath`
  必须落在 `VMAIL_ROOT` 内；消息 key 用 `base64url(JSON([account,folder,name]))`
  编码，前端拿不到裸路径。
- **GitHub 仓库受 `GITHUB_ALLOWED_REPOS` 白名单约束**，token 不会被拿去改别的仓库；
  token 本身永不回传前端，只回 `present / kind / len`。
- **未登录的 POST 也要把请求体读掉**再回 401。HTTP/1.1 是 keep-alive，提前返回而
  不读 body，残留字节会被当成下一个请求行，服务端刷 `Bad request syntax`、连接错位
  （客户端仍能拿到 401，但这条连接废了）。见 `server.py` 的 `_drain_body()`。

> 文件名白名单里的 **逗号不能少**：Maildir 的信息后缀是 `:2,<flags>`
> （如 `1759…M1P1.mx:2,RS`）。少了逗号，凡是已读过的邮件都会 400。
> 这个 bug 在 Windows 上测不出来——Windows 文件名不允许 `:`，测试邮件被写成了
> NTFS 备用数据流，文件名看起来是干净的。**必须在 Linux 上测。**

---

## 7. 排障

| 现象 | 原因 / 处理 |
|---|---|
| 浏览器打不开，`curl -4` 通 | zone 里有通配 `*.floatingice.win` AAAA 指向别处。`fnapp` / `synology` 同样只有 A 记录，实践上没问题 |
| https 不通但 http 通 | SNI 分流器没重启或没加 `admin.floatingice.win` 路由；`./install.sh sni` 检查 |
| 接口全 401，但登录返回 200 | 用 curl 探 `http://` 时会这样（Secure cookie 不回传明文）。换成 https，或手动带 `Cookie:` 头 |
| 邮件面板 502 / 发信失败 | `./install.sh verify` 看 `smtp_ok`；确认 postfix 在跑、`mynetworks` 含 `127.0.0.1/32` |
| 邮件列表里已读邮件打不开 | 检查 `panels/mail.py` 的 `_NAME_RE` 是否还允许 `,` |
| Issue 面板 401 | `/etc/mmh-admin/github-token` 过期或没装；`./install.sh status` 看权限 |
| 下载数字和 fnstore 页面不一致 | `diff app/stats_store.py ../fnstore/app/stats_store.py`，口径分叉了 |
| 改了 `app/` 但页面没变 | 代码是只读挂载，`docker compose restart mmh-admin` 即可；静态页本身不缓存 |
| 改 `app/static/` 后 404 | 静态目录是 `app/static`，不是 `app/admin`（那是 fnstore 的） |
| 忘了后台口令 | 删 `/opt/mmh-admin/data/admin-token` 再 `docker compose restart mmh-admin`，回落 `.env` 的 `ADMIN_TOKEN` |
| `./install.sh verify` 报登录失败 | UI 改过口令后 `.env` 的口令就作废了；verify 会自动优先读 `data/admin-token`，若仍失败说明该文件权限/内容不对 |
| 改口令后自己也被踢下线 | 不该发生——改口令时会同时补发新 cookie。若出现，检查 `panels/settings.py` 是否还返回 `api.Response`（普通 dict 带不了 `Set-Cookie`） |
| 页面时间是 UTC，差 8 小时 | 容器没拿到时区。查 `docker exec mmh-admin date`、`echo $TZ_SPEC`；「设置」页的时区卡会显示当前来源与偏移 |
| 改了时区但审计页历史记录没跟着变 | 不该发生——审计页按 `ts` 在前端换算，历史条目也会一起变。若没变，检查 `app.js` 的 `fmtTime` 是否还在直接显示 `r.time` |
| 时区卡出现「没有 tzdata」提醒 | 该环境缺 zoneinfo 数据，时区退化成固定偏移（夏令时不准）。生产镜像自带 tzdata，正常不会出现 |
| 下载明细的时间不跟时区变 | **正确**：那是 `stats_store.py` 里写死的 CST 业务口径，要和 fnstore 页面一致 |

---

## 8. 备份

```bash
./backup.sh [输出目录]     # 默认 ./backups
```

备份 `data/`（审计日志 + 会话密钥）、`.env`、站点配置、SNI 分流器、nginx 配置；
token 单独放 `secrets/`。**不备**下载库 / 注册库 / Maildir——那是别的服务的资产。

---

## 9. 变更记录

- **2026-09-29 首版**
  - 四个面板 + 概览，全部支持写操作并落审计。
  - `admin.floatingice.win` DNS A 记录（Cloudflare，DNS-only，与 fnapp/synology 一致）。
  - acme.sh DNS-01 签发 ECC 证书，装到 `/etc/nginx/certs/admin.floatingice.win/`。
  - SNI 分流器从"只认群晖 + 其余给 xray"改成路由表（`ROUTES`），新增
    `admin.floatingice.win -> 127.0.0.1:9444`。群晖链路已回归验证。
  - GitHub token 落到 `/etc/mmh-admin/github-token`（600）。
  - 修掉 Maildir 文件名白名单漏逗号的 bug（`:2,S` 打不开）。
  - 在真实生产镜像（`python:3.11-slim`，host 网络）里跑过 35 项自检全绿。
- **2026-09-29 加「设置」页：在 UI 里改口令**
  - `auth.py` 重写：口令来源变成「`DATA_DIR/admin-token` 文件 > `ADMIN_TOKEN` 环境变量」，
    新增 `set_token()`（原子写 + 重建签名密钥）/ `token_changed_at()` / `reset_to_env()`。
  - 新增 `panels/settings.py`：`GET /api/settings`（口令状态 + 只读服务信息）、
    `POST /api/settings/password`（校验 → 改口令 → **补发新 cookie** → 落审计）。
  - `api.py` 加 `Response`，让面板能自定义状态码/响应头（改口令要下发 `Set-Cookie`）。
  - 前端加「设置」标签页；`install.sh verify` 改成按实际口令来源登录，并探 `/api/settings`。
  - 顺手修掉一个 keep-alive 连接错位 bug：未登录的 POST 提前 401 时不读请求体，
    残留字节被当成下一个请求行，服务端刷 `Bad request syntax`。加 `_drain_body()`。
  - 自检扩到 45 项（新增 14 项覆盖改口令：错口令/太短/含空格/两次不一致/与原口令相同/
    缺参数/未登录/旧 cookie 失效/新 cookie 可用/新旧口令登录/改回原口令），本地与
    VPS 真实镜像全绿。测试 fixture 抽成 `fixtures.py`，本地与彩排共用。
- **2026-09-29 加时区设置（默认北京时间）**
  - 新增 `app/tzutil.py`：时区来源「`DATA_DIR/tz` 文件 > `TZ_SPEC`/`TZ` 环境变量 > 默认
    `Asia/Shanghai`」，支持 IANA 名（含夏令时）与固定偏移（`UTC+8`）；改完立即生效，不重启。
  - 原来审计/概览/日志用的是**容器 UTC 时钟**，而下载明细用的是 CST —— 一屏里两种口径。
    现在统一到 `tzutil`，默认北京时间。
  - `docker-compose.yml` / `.env.example` 增加 `TZ_SPEC`（并同步设容器 `TZ`）。
- **2026-09-29 修下载明细口径 + 清重复行**
  - `stats_store.recent()` 补 `include_internal`（默认 `False`），与 `summary()` 同口径。
    之前 `recent()` 零过滤、`summary()` 过滤，导致「总数 62 / 明细 90 条」。
  - `/api/downloads/recent` 接受 `include_internal`，前端复选框同时作用于汇总与明细；
    明细表每行加 IP 归属徽标（公网 / 本机 / 内网 / 无 IP），卡片标题显示条数与当前口径。
  - `deploy/fnstore/bin/backfill-nginx.py`：`live` 行改为优先于 `legacy-nginx`，
    回填时跳过已被 `live` 覆盖的日志行；新增 `--dedupe-live`（幂等）清理历史遗留。
  - 生产实测：清掉 6 条重复行，`download_event` 90 → 84 行，汇总口径 62 → 56，
    明细默认 56 条（只含 `public` + `unknown`），勾选后 84 条。
  - 自检扩到 62 项：`fixtures.py` 新增**确定性**统计库 fixture（5 行覆盖四种 `ip_kind`），
    断言「明细默认条数 == 汇总 `totals.external`」「`include_internal=1` 时 == `totals.all`」；
    `shot.js` 增加浏览器实测（切换开关断言 56 → 84、默认明细不含本机/内网）。
    本地 62/62 全绿，生产 `install.sh verify` 全绿。
  - 「设置」页新增时区卡（下拉常用时区 + 自定义输入 + 恢复默认）；
    `POST /api/settings/timezone`，落 `settings.timezone` 审计。
  - 前端 `fmtTime` 改成按配置时区渲染（IANA 名交给 `Intl`，固定偏移自己算）；
    **审计页改成从 `ts` 换算**，所以改时区后历史条目也一起变，不会新旧割裂。
  - 缺 tzdata 的环境退化成固定偏移并置 `degraded` 标记 + 页面提醒，不静默算错。
  - 自检扩到 63 项（新增 8 项覆盖时区：401/空值/非法名/超范围偏移/改成 UTC+8 后
    核对审计 `time` 与 `ts+8h` 一致/审计记 tz/Linux 不降级/reset 回落），
    本地 56/56、VPS 真实镜像 63/63 全绿；浏览器验证时区往返（含夏令时 `EDT`）。
