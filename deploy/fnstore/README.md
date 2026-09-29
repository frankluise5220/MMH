# MMH fnVPS 服务端

MMH 在飞牛 NAS 生态里的自建软件源服务端，跑在 `fnvps`（`mx.floatingice.win:2222`）上。
对外提供两个入口：

| 入口 | 地址 | 用途 |
| --- | --- | --- |
| FN 软仓专属源 | `http://fnapp.floatingice.win/` | FN 软仓客户端 / FnDepot 插件查询、下载 fnOS FPK |
| 群晖套件源 | `https://synology.floatingice.win` | DSM「套件中心 → 设置 → 套件来源」添加后安装 SPK |
| 源管理页 | `http://fnapp.floatingice.win:4001/fnstore/` | 下载统计仪表盘 |

本目录既是**部署单元**也是**文档**：把整个 `deploy/fnstore/` 拷到目标机器上执行 `./install.sh` 即可复现，
数据目录默认在同级的 `data/`。

---

## 架构

```
DSM / FN软仓客户端 / FnDepot插件 / 浏览器
        │
        ├── 443 ──> mmh-synology-sni-proxy.service（按 SNI 分流，纯 TCP 转发）
        │              ├─ SNI = synology.floatingice.win ──> 127.0.0.1:9443
        │              │      （转发前发 PROXY protocol v1 头，传真实客户端 IP）
        │              ├─ SNI = admin.floatingice.win ────> 127.0.0.1:9444（MMH 后台管理）
        │              │      （同样发 PROXY protocol v1 头）
        │              └─ 其它 SNI ─────────────────────> 127.0.0.1:8444（xray）
        │
        ├── 80  ──> nginx: server_name synology.floatingice.win ──> 127.0.0.1:5661
        ├── 80  ──> nginx: server_name fnapp.floatingice.win
        │              ├─ /apps/、/downloads/ ──> 127.0.0.1:5661
        │              └─ 其余 ───────────────> 127.0.0.1:5660
        └── 4001 ─> nginx: /fnstore/ ──────────> 127.0.0.1:5661
                          其余 ───────────────> 127.0.0.1:3000（new-api）

5660  fn-appstores-server    官方 Go 版 2.8.4
      /api/apps、/api/rating/*、/admin、/health、/api/notice

5661  mmh-fnstore-admin      Python 版 2.2.0 + app/app.py（MMH 补丁版）
      /（群晖套件源协议）、/catalog.json、/downloads/*、/fnstore 管理页、
      /icons/*、/api/stats、/apps/*（下载统计的唯一写入方）
```

### 为什么必须两个容器并存

上游把 FN 软仓服务端从 Python 重写成了 Go。这次切换在 2026-09-27 发生，一次性弄坏了三件事：

| 症状 | 原因 |
| --- | --- |
| DSM 源加得上但搜不到 MMH | Go 版没有群晖协议（`/` 返回自己的首页 JSON、无 `/catalog.json`） |
| `/downloads/*.spk` 404 | `/downloads/<file>` 是 `app.py` 的路由 |
| `:4001/fnstore/` 404 | `/fnstore` 也是 `app.py` 的路由 |

但**不能简单回退**：迁移到 Go 版本身是为了修评分功能（Python 版没有 `/api/rating/*`，
评分时客户端拿到 404 HTML 报 `Unexpected token '<'`）。详见
[docs/rating-failure-2026-09-28.md](docs/rating-failure-2026-09-28.md)。

所以结论是**并存 + 按 host/path 分流**：Go 版留在 5660 负责评分与应用列表，
Python 版另起 5661 补齐群晖源、`/downloads/`、管理页与统计。

---

## 下载统计

### 存储

单一事实来源是 **`data/mmh-stats.db` 的 `download_event` 表**（SQLite，一行 = 一次成功下载）。

刻意与 Go 版的 `data/stats.db` **分文件存放**——那边有 `app_ratings` 评分表，共用文件会互相破坏。
Go 版历史上的 `download_daily` 聚合已在首次启动时一次性导入（`origin='legacy-go'`）。

### 维度

| 字段 | 取值 |
| --- | --- |
| `channel` 渠道 | `fnstore`（FN软仓专属源）/ `synology`（群晖套件源）/ `fndepot`（FnDepot）/ `vps`（直连端口）/ `github`（GitHub Release，由 API 补齐）/ `fnos`（飞牛应用中心，直连 GitHub，VPS 不可见，恒 0） |
| `client` 客户端软件 | `fnstore-client` / `fndepot-plugin` / `synology-dsm` / `browser` / `curl` / `wget` / `powershell` / `scanner` / `other` / `unknown`，由 User-Agent 判定 |
| `date` 日期 | Asia/Shanghai，`YYYY-MM-DD` |
| `version` / `file_type` / `arch` | 由文件名解析（`fnos-fpk` / `synology-spk` / `win-exe` / `win-zip` / `nas-zip` / `android-apk`） |
| `ip` / `ip_kind` | `public`（真实外部）/ `loopback`（本机 curl 验证、SNI 未透传 IP 的历史记录）/ `private`（`172.17.x`，Docker 网桥）/ `unknown`（无 IP 的历史聚合导入行） |
| `origin` | `live`（实时记录）/ `legacy-json` / `legacy-go` / `legacy-nginx`（历史导入，可据此审计与回滚） |

只记录 `200 / 206 / 302`；`404` 扫描探测不入库。同 `(ip, file)` 10 秒内去重，防 FnDepot 轮询重复计数。

**默认口径 = 排除 `loopback` + `private`**，`public` 与 `unknown` 都计入。
这里刻意不是「只保留 public」：`unknown` 是 Go 版 `stats.db` 那种没有 IP 的聚合行，
把它滤掉会让「0.1.66 下载」这类真实记录重新消失——那正是要修的 bug。
勾选「含本机/内网记录」可切到全量。

**汇总数与「最近下载明细」用的是同一套口径。** 2026-09-29 之前不是：
`summary()` 过滤了 `loopback/private`，`recent()` 却一行都没滤，
于是页面上出现「总数写着 62、明细里却混着一堆 `127.0.0.1` / `172.17.0.1`」的观感 bug。
现在 `recent()` 也有 `include_internal` 参数（默认 `False`），
后台的复选框同时作用于汇总和明细；每行 IP 后面还会标出归属
（`公网` / `本机` / `内网` / `无 IP`），避免 `107.175.62.109` 这种「VPS 自己的公网 IP」
伪装成真实外部流量。

### 历史回填

`bin/backfill-nginx.py` 用 nginx access log 重建历史（日志里有真实 IP / UA / 状态码）：

```sh
python3 bin/backfill-nginx.py            # dry-run，只打印汇总
python3 bin/backfill-nginx.py --apply    # 写入，并把被覆盖的 legacy-json 行升级掉
python3 bin/backfill-nginx.py --dedupe-live --apply   # 只清理被 live 覆盖的重复行
```

三个必须知道的局限：

- `log_format` 里**没有 `$host`**，渠道只能按「路径 + UA」推断
  （`UA 含 FnDepot` → fndepot；路径含 `synology` → synology；`/apps/` → fnstore；其余 → vps）。
  因此从 `fnapp` 域名手动下载 synology SPK 会被算进 synology 渠道。
- `legacy-json` 与日志行描述的是**同一批请求**，直接叠加会重复计数。`--apply` 默认做
  「升级式合并」：能在日志里找到同 IP + 同文件 + 120 秒内的 JSON 行，就用日志行取代；
  找不到的（绕过 nginx 直连 `:5660` 的请求）才保留 JSON 行。
- **`live` 行优先于日志行**（与上一条方向相反）。`live` 是应用侧实时写的，渠道按 `Host`
  判定、IP 来自 `X-Real-IP`，比日志的「路径 + UA 推断」更准；日志行只是它的低配复制品。
  所以回填时，日志行一旦被同 IP + 同文件的 `live` 行覆盖就整条跳过。
  2026-09-29 `live` 启用当天，回填过一次留下了 6 条这样的重复行
  （都是 VPS 自己 curl 自己域名、走 hairpin NAT 的验证流量），
  已用 `--dedupe-live --apply` 清理；该命令幂等，可反复跑。

### 三个必守的口径

1. **下载只能有一个写入方。** 所有下载类路径（`/apps/`、`/downloads/`、群晖 host 全部）都指向 5661。
   如果 `/apps/` 又指回 5660，Go 版会把下载记进自己的 `stats.db`，仪表盘就看不到——
   这正是「昨天下了 0.1.66 但页面不显示」的原因。

   与之配套的是 `fn-appstores.json` 里的 `download_url`：它**不该写死 `:5660`**。
   实测 Go 版 `/api/apps` 会剥掉端口（即使 `Host: fnapp.floatingice.win:5660` 也返回无端口地址），
   所以线上没爆——但 Python 版（5661）是把存下来的值**原样透传**的，一旦有客户端从 5661 取
   `/api/apps`，就会拿到 `:5660` 直连地址、绕过 nginx、统计丢失。属潜在隐患，已一并修掉。
   规范入口是 **`http://fnapp.floatingice.win/`（无端口）**。
   现在 `sync.sh` 生成的是 `http://fnapp.floatingice.win/apps/mmh-<ver>.fpk`。
2. **群晖渠道必须能拿到真实 IP。** SNI 代理是纯 TCP 转发，nginx 只跟 `127.0.0.1` 说话，
   `$remote_addr` 恒为 `127.0.0.1` → 所有 DSM 下载都被记成 127.0.0.1。
   现在 SNI 代理在转发前发 PROXY protocol v1 头，nginx 侧用
   `listen 127.0.0.1:9443 ssl proxy_protocol` + `real_ip_header proxy_protocol` 接收。
   **两边必须同时改**：只改一边会让 9443 直接握手失败。
   （`nginx/stream.d/synology-sni.conf` 是死配置——`:443` 由 Python 代理持有，nginx 并没有在听。）
3. **GitHub Release 的下载量只能从 GitHub API 取**，VPS 侧看不到（`fnos` 渠道同理）。

---

## 部署 / 迁移

```sh
# 前置：docker + docker compose v2、nginx、python3、curl
cp .env.example .env      # 按实际环境改 DATA_DIR / BASE_URL / SYNOLOGY_BASE_URL
./install.sh              # 幂等；重复执行即为更新
./install.sh verify       # 只做健康检查
./install.sh uninstall    # 停容器（数据不动）
```

`install.sh` 会做：建数据目录 → 把 `app/admin/index.html` 复制到 `<DATA_DIR>/admin/`
（管理页由 `app.py` 的 `ADMIN_HTML_PATH` 从那里读，**不要**用 docker 挂载 `app/admin` 去遮它）→
起两个容器 → **先**装并重启 SNI 代理、**再**装并校验 nginx 站点配置（失败自动回滚）→ 提示 crontab → 自检。

顺序不能颠倒：nginx 的 9443 带 `proxy_protocol`，要求对端先发 PROXY 头。
先 reload nginx 再换代理，中间那段群晖 HTTPS 源是断的。
SNI 代理覆盖前会先 `py_compile`，语法错就不动线上文件。

**nginx 的 `/fnstore/` 片段要手动加**：它属于「对外提供 :4001 的那个 server 块」，
直接覆盖会连带改掉 new-api 的站点，所以只提供 [nginx/fnstore-location.snippet.conf](nginx/fnstore-location.snippet.conf)。

```sh
# 建议的 crontab（每小时同步一次 GitHub 最新 release）
0 * * * * /opt/mmh-fnstore/bin/sync.sh >> /opt/mmh-fnstore/sync.log 2>&1
```

### 线上实际布局（与包的差异）

fnVPS 上的两个容器是早先用 `docker run` 手工起的，数据目录是
`/opt/fn-appstores-server/data`，**不是**包默认的 `<包目录>/data`。
功能上两者完全一致（同样的镜像、同样的挂载点、同样的端口），差别只是编排方式：

| | 线上 fnVPS | 本包（新机器 / 迁移） |
| --- | --- | --- |
| 编排 | `docker run` ×2 | `docker-compose.yml` |
| 数据目录 | `/opt/fn-appstores-server/data` | `<包目录>/data`（可用 `DATA_DIR` 覆盖） |
| app.py 来源 | `/opt/fn-appstores-server/app.py` | `<包目录>/app/app.py` |

因为 `container_name` 相同，**在 fnVPS 上直接跑 `./install.sh` 会被预检拦下**，
不会误删正在服务的容器。要让线上改用 compose 编排（建议，之后 `install.sh` 就能直接跑）：

```sh
# 1. 确认数据目录位置
docker inspect fn-appstores-server --format '{{range .Mounts}}{{.Source}}{{println}}{{end}}'
# 2. 把 .env 的 DATA_DIR 指到它
#    DATA_DIR=/opt/fn-appstores-server/data
# 3. 接管（先备份：./backup.sh）
MMH_FNSTORE_ADOPT=1 ./install.sh
```

`data` 是 bind mount，删容器不丢数据；但**务必先 `./backup.sh`**。

### 迁移到新机器

```sh
./backup.sh                  # 产出 backups/mmh-fnstore-<ts>.tar.gz + 配置文本
# 新机器：
tar -xzf mmh-fnstore-<ts>.tar.gz -C /opt/mmh-fnstore
cd /opt/mmh-fnstore && ./install.sh
```

---

## 群晖套件源的硬约束

`app.py` 的 `_synology_catalog()` ← `_synology_package_info()` **只扫描本地目录**
`data/downloads/`，文件名必须匹配：

```
^mmh-synology-v(\d+\.\d+\.\d+)-(x86_64|arm64)\.spk$
```

没有匹配文件 ⇒ `/` 返回 `{"packages":[]}` ⇒ **DSM 搜不到 MMH**。
GitHub Release 上有没有 SPK **完全不影响**这一步。

所以每个 synology 版本都必须把两个 SPK 放进 `data/downloads/`。
`bin/sync.sh` 已把这件事自动化（`EXTRA_ASSETS` 默认拉两个 SPK，并保留最新 3 个版本）。
注意 `EXTRA_ASSETS` 块位于版本比较**之后**，只在新版本时才执行——漏掉的版本要手工补：

```sh
cd data/downloads
curl -fLO https://github.com/frankluise5220/MMH/releases/download/v<ver>/mmh-synology-v<ver>-x86_64.spk
curl -fLO https://github.com/frankluise5220/MMH/releases/download/v<ver>/mmh-synology-v<ver>-arm64.spk
```

---

## 排查

```sh
curl -s 'https://synology.floatingice.win/?arch=x86_64&build=64570&language=chs'
curl -s -o /dev/null -w '%{http_code}\n' https://synology.floatingice.win/catalog.json
curl -s -o /dev/null -w '%{http_code}\n' http://fnapp.floatingice.win:4001/fnstore/
./install.sh verify
```

| 现象 | 结论 |
| --- | --- |
| 返回 `{"name":"FN软仓服务端",...}` | 请求落到 5660 了，nginx 的 `proxy_pass` 被指回 Go 版 |
| 返回 `{"packages":[]}` | 协议正常，但 `data/downloads/` 缺匹配的 SPK |
| `/fnstore/` 404 | 同上，被指回 5660；Go 版没有该路由 |
| 仪表盘某版本下载数为 0 | `/apps/` 是否指向 5661（最主要原因）；其次看 `fn-appstores.json` 的 `download_url` 是否写死了 `:5660` |
| 大量 `127.0.0.1` 记录 | SNI 代理的 PROXY protocol 或 nginx 的 `proxy_protocol` 少改了一边；本机 curl 验证也会记成 127.0.0.1（默认口径已排除，勾选「含本机/内网」才显示） |
| 改了 `app/admin/index.html` 但页面没变 | 管理页读的是 `<DATA_DIR>/admin/index.html`，不是包里的 `app/admin/index.html`；跑 `./install.sh` 或手动 `install` 过去 |
| `https://synology...` 不通但 `http://` 通 | PROXY protocol 两端不一致 |

注意 `/api/apps` 返回的是 **FN 软仓**聚合接口，不是群晖源协议，别拿它验证群晖源。

---

## 目录

```
deploy/fnstore/
├── docker-compose.yml     两个容器的编排
├── .env.example           数据目录 / 镜像 / 端口 / 对外地址
├── install.sh             部署、迁移、健康检查、卸载
├── backup.sh              数据 + 配置 + crontab 备份
├── app/
│   ├── app.py             Python 版服务端（上游 + MMH 补丁）
│   ├── mmh_stats_override.py  下载统计覆盖层（挂在 app.py 末尾）
│   ├── stats_store.py     统一事件存储 + 维度识别
│   ├── index.html         源首页
│   └── admin/index.html   /fnstore 仪表盘
├── nginx/
│   ├── fnapp-floatingice.conf
│   ├── synology.floatingice.win.conf
│   └── fnstore-location.snippet.conf   （需手动并入 :4001 的 server 块）
├── sniproxy/mmh-synology-sni-proxy.py  443 SNI 分流 + PROXY protocol
│                                        ⚠ 共享组件：MMH 后台管理（deploy/admin）也靠它
│                                          分流 admin.floatingice.win。改这里要同时确认两边。
├── bin/
│   ├── sync.sh            每小时同步 GitHub release
│   └── backfill-nginx.py  用 nginx 日志重建历史统计（默认 dry-run；--dedupe-live 清重复）
└── docs/
    ├── rating-failure-2026-09-28.md   评分故障记录（迁移到 Go 版的起因）
    ├── 三方服务端搭建指南【2.8.3+服务端】.md  上游搭建文档
    ├── fnstore.txt                    上游 docker run 参考
    └── legacy-admin-index.html        旧版管理页（存档）
```

---

## 改动记录

- **2026-09-29** 修复 Go 版迁移造成的三处回归（群晖源 / `/downloads/` / `/fnstore`）：
  新增 Python 旁路容器 5661，nginx 按 host + path 分流；下载统计改为统一 SQLite 事件表
  （`stats_store.py`）并重建仪表盘；SNI 代理加 PROXY protocol 传真实 IP；
  `sync.sh` 自动同步群晖 SPK；整理目录并清理约 500 MB 冗余文件。
- **2026-09-29（下半场）** 修「0.1.66 不显示」与「一堆 127.0.0.1」：
  - 查明「不显示」的真因是**统计分裂成两个库**——Go 版写 `stats.db`，Python 版写
    `download-stats.json`，而 `/apps/` 当时指向 5660（Go），所以下载只进了 Go 的库。
    统一到 `mmh-stats.db` 后，旧 JSON 的 46 条与 Go 的 5 条日聚合一次性导入并标注 `origin`。
  - 默认口径从「只保留 public」改为「排除 loopback + private」，否则无 IP 的聚合行
    （即那次 0.1.66）会被一起滤掉。
  - `fn-appstores.json` 的 `download_url` 去掉写死的 `:5660`，并同步修正 `sync.sh` 里的生成逻辑。
- **2026-09-29（再下半场）** 修「明细里一堆 107.175.62.109 / 127.0.0.1」：
  - 查明 `recent()` **一行都没过滤**，而 `summary()` 过滤了 `loopback/private` ——
    同一屏里「总数 62、明细 90 条」就是这么来的。`recent()` 补 `include_internal`
    （默认 `False`），后台的「含本机/内网记录」复选框同时作用于汇总与明细。
  - `live` 行改为**优先于** `legacy-nginx`：回填时若日志行已被同 IP+同文件的 `live` 行覆盖
    就整条跳过，避免同一笔下载被记两次。新增 `--dedupe-live`（幂等）清理历史遗留。
  - 实测清掉 6 条重复行（都是 VPS 自己 curl 自己域名的 hairpin 验证流量），
    库从 90 行降到 84 行，汇总口径从 62 降到 56。
  - `mmh_stats_override.py` 的 `payload["recent"]` 同样跟随 `internal` 开关，
    `:4001/fnstore/` 页面与后台数字现在完全一致。
  - PROXY protocol 落地（SNI 代理 + nginx `proxy_protocol`/`real_ip_header`），
    群晖渠道开始记到真实 IP；`install.sh` 里把 SNI 代理调整到 nginx 之前执行。
  - 新增 `bin/backfill-nginx.py`，用 21 天 nginx 日志重建历史（10 秒去重把 FnDepot 的
    190 次轮询折成 19 次），并把被覆盖的 `legacy-json` 行升级掉，避免重复计数。
- **2026-09-29（SNI 分流器改成路由表）** 为了接入 MMH 后台管理（`deploy/admin`，
  `https://admin.floatingice.win`），把 `sniproxy/mmh-synology-sni-proxy.py` 从
  「只认一个 SNI_HOST，其余全给 xray」改成 `ROUTES` 路由表：

  ```python
  ROUTES = {
      "synology.floatingice.win": ("127.0.0.1", 9443),   # 群晖套件源
      "admin.floatingice.win":    ("127.0.0.1", 9444),   # MMH 后台管理
  }
  PROXY_PROTOCOL_HOSTS = set(ROUTES)      # 这些后端是 nginx，能收 PROXY v1 头
  DEFAULT_BACKEND = ("127.0.0.1", 8444)   # 其余给 xray
  ```

  行为对群晖完全等价（同后端、同样发 PROXY 头），改完已回归验证
  `/` 与 `/catalog.json` 均 200。**这个文件现在是 fnstore 与 admin 共用的**，
  以后改它要同时确认两条链路。旧版本备份在
  `/usr/local/bin/mmh-synology-sni-proxy.py.bak-<TS>`。
