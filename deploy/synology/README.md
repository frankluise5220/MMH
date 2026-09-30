# MMH Synology DSM SPK

本文记录 MMH 面向群晖 DSM 的 `.spk` 分发方式。普通用户安装和更新请优先看 `deploy/nas-install-manual.md`。

## 群晖套件源运维说明

当前群晖套件源是独立于 fnOS/FN 软仓的 Synology DSM 源。用户在 DSM 套件中心的「套件来源」中添加：

```text
https://synology.floatingice.win
```

### 架构

请求链路固定为：

```text
DSM 套件中心
  -> synology.floatingice.win:80/443
  -> fnVPS nginx
  -> 127.0.0.1:5660
  -> fn-appstores-server
```

- `synology.floatingice.win` 的 Cloudflare DNS 记录必须是 `A -> 107.175.62.109`、**DNS Only/灰云**，不要启用橙云代理。
- 该记录不要添加 `AAAA`。当前 fnVPS 没有为这个源提供可用 IPv6 入口；如果 DNS 返回 Cloudflare IPv6，部分 DSM/网络会连接被重置。
- 外部只使用标准 `80/443`。虽然 Docker 服务监听 `5660`，但 `:5660` 不是推荐的用户源地址，也不应作为长期公开入口。
- `fnapp.floatingice.win` 是 FN 软仓/FNOS 源，不能替代 `synology.floatingice.win`；两个地址使用不同协议。
- `4001` 是管理/中转入口，不是 DSM 套件源地址。

### 源协议

`fn-appstores-server` 容器中的 `/app/app.py`（宿主机持久化文件为 `/opt/fn-appstores-server/app.py`）提供 Synology 源接口：

```text
GET /
GET /?arch=x86_64&build=64570&language=enu
GET /?arch=arm64&build=64570&language=enu
GET /catalog.json
GET /downloads/<spk-file>
```

根地址在没有参数时也必须返回包含 `MMH` 的 `packages`，不能返回空数组。DSM 添加来源或刷新时可能先访问无参数根地址；如果这里返回 `{"packages": []}`，就会出现「源可以添加但搜索不到 MMH」。

带参数请求按架构返回对应 SPK，当前架构别名由 `app.py` 处理。返回的 `link` 必须指向 `https://synology.floatingice.win/downloads/...`，这样套件中心查询和实际下载使用同一个 VPS 入口。

### 软件包和下载

SPK 文件放在 VPS 宿主机：

```text
/opt/fn-appstores-server/data/downloads/
```

命名格式：

```text
mmh-synology-v0.1.x-x86_64.spk
mmh-synology-v0.1.x-arm64.spk
```

当前 `/downloads/<filename>` 优先从上述目录由 fnVPS 本地直接发送，并记录下载统计；不要把 Synology 源的下载链接改成群晖 NAS、GitHub 或 `fnapp` 的 FPK 地址。

### 远程访问

所有远程操作使用 SSH 别名，不要猜地址、端口或密钥：

```powershell
ssh -F "$env:USERPROFILE\.ssh\config" fnvps
```

本项目当前的 `fnvps` 别名指向 `mx.floatingice.win:2222`，用户为 `root`。服务容器名称为：

```text
fn-appstores-server
```

常用只读检查：

```bash
sudo -n docker ps --filter name=fn-appstores-server
sudo -n docker exec fn-appstores-server sha256sum /app/app.py
curl -4 -fsS https://synology.floatingice.win/
curl -4 -fsS 'https://synology.floatingice.win/?arch=x86_64&build=64570&language=enu'
curl -4 -I https://synology.floatingice.win/downloads/mmh-synology-v0.1.65-x86_64.spk
```

如果需要修复接口，先备份 `/opt/fn-appstores-server/app.py`，再修改宿主机文件并重启容器：

```bash
sudo -n cp -a /opt/fn-appstores-server/app.py /opt/fn-appstores-server/app.py.bak-<date>
sudo -n docker restart fn-appstores-server
```

`/app/app.py` 是宿主机文件的 bind mount；只修改容器内文件会在容器重建后丢失。每次修复后必须同时检查无参数根地址、x86_64、arm64 和 SPK 下载响应。

### 故障判断

| 现象 | 优先检查 |
| --- | --- |
| 添加时显示「无效的位置」 | DNS 是否仍为 DNS Only、是否出现 AAAA、80/443 是否能从外部访问 |
| 源能添加但搜不到 MMH | `GET /` 是否返回 `packages` 中的 `package=mmh`，不要只检查带参数 URL |
| x86_64 能查、ARM64 不能查 | `arch` 别名、arm64 SPK 是否存在、对应 MD5/size 是否生成 |
| 能查到但下载失败 | 返回的 `link` 是否仍指向 `synology.floatingice.win/downloads/`，VPS 本地文件是否存在 |
| 本机正常、外部异常 | 检查 Cloudflare 是否被重新打开代理，以及是否新增 AAAA；不要先改 `4001` 或 `fnapp` |

验证结果必须以 HTTP 响应为准。不要只打开域名首页判断，因为 DSM 使用的是带 `arch`、`build`、`language` 的协议请求，且添加来源时还可能使用无参数请求。

群晖版使用 SQLite 原生运行方式：包内包含 Next standalone、Linux Node runtime、Prisma runtime、SQLite 初始化脚本和 DSM 套件启动脚本，不依赖 Docker/PostgreSQL。当前 `.spk` 的 `os_min_ver` 兼容下限保持为 DSM `7.0-40000`，同时优先面向 DSM 7.2 及更新版本做实际安装测试。正式 Release 资产按架构发布：

```text
release-artifacts/synology/mmh-synology-v0.1.x-x86_64.spk
release-artifacts/synology/mmh-synology-v0.1.x-arm64.spk
```

调试归档不是用户安装包：

```text
release-artifacts/synology/mmh-synology-v0.1.x-x86_64-spk-source.tgz
release-artifacts/synology/mmh-synology-v0.1.x-arm64-spk-source.tgz
```

格式要求：

- `.spk` 最外层必须是未压缩 tar 归档，根目录包含 `INFO`、`scripts/`、`conf/`、图标和 `package.tgz`。
- `package.tgz` 是 `.spk` 内部的 gzip tar 归档，用来承载 `app/` 运行目录。
- `INFO` 里应写 `os_min_ver="7.0-40000"`、`checksum="<package.tgz md5>"` 和 `extractsize="<package 解压后 KB>"`；不要仅因 DSM 7.2 更常见而主动收窄 7.0/7.1 用户的安装入口，DSM 7.2 及更新版本作为优先测试面。
- `conf/privilege` 里应写 `"run-as": "package"`，不要写成无效的 `run_as`，否则 DSM 会判定套件以 root 权限运行并拒绝安装。
- 最终 `.spk` tar header 里的生命周期脚本必须是可执行文件，`scripts/start-stop-status`、`config`、`preinst`、`postinst`、`preuninst`、`preupgrade`、`postupgrade` 使用 `0755`，普通元数据文件使用 `0644`，并以稳定的 numeric root ownership 归档。删除用户数据时，`preuninst` 只清空 `SYNOPKG_PKGVAR` 目录内容，不删除 DSM 创建的数据目录本身，避免套件用户因无权删除父目录而导致卸载失败。
- 端口字段用 `WIZARD_UIFILES/install_uifile`（静态 JSON）+ `install_uifile.sh`（动态）成对提供。静态文件保证向导一定能渲染；动态脚本在向导渲染前探测端口：**端口空闲就照用；端口被本套件自己的进程占用（升级时旧版本还在跑）就保持原端口并在描述里说明；只有被别的程序占用才点名占用者并把默认值预填成下一个空闲端口**——这是**唯一**能在用户点“下一步”之前告诉他端口情况的时机。它还会把自己算出的默认端口写进 `<套件数据目录>/mmh-wizard-port`，作为 `preinst`/`postinst` 判断「用户是否真的改过端口」的依据（读后即删）。`.sh` 必须永远 `exit 0`，且只往 `$SYNOPKG_TEMP_LOGFILE` 写合法 JSON：脚本失败或写出非法 JSON，整个安装向导就不再渲染，表现正好是“安装时不提示端口”。JSON 由 `wizardJsonHead` / `wizardJsonMid` / `wizardJsonTail` 三个片段拼装，构建时由 `assertWizardJsonFragments()` 校验（2026-09-28 的故障就是手写 JSON 漏了前导 `[`）。
- **向导描述必须是一句短文**。DSM 把 `textfield` 子项的 `desc` 渲染在步骤标题下方的整行区域，**会换行**，而对话框高度固定 → 超出的行被直接裁掉（用户看到句子断在半截，不是横向溢出）。2026-09-30 之前那句三句话的提示有 87 个字符（含 `⚠️` 与嵌套括号），在 DSM 7.2 上换到第二行后被裁。现在每条描述都是单句，`check:synology` 同时断言固定文案 ≤30 字符、渲染结果 ≤40 字符、且不含 `⚠️`。占用者只写短形式（`pid=1234` / `Docker 映射` / `Docker pid=1234`），完整归属（进程名 + 类型）仍由 `preinst` 写进 `/var/log/packages/mmh.log`。
- **DSM 桌面入口（「打开」按钮 + 图标）靠 `INFO` 的 `dsmuidir` 生效，这是最容易漏掉的一环**。官方定义：`dsmuidir` 指向 `package.tgz` 里的 UI 目录，DSM 会把 `/var/packages/mmh/target/<dsmuidir>` 链接到 `/usr/syno/synoman/webman/3rdparty/<pkg>`；**`dsmuidir` 留空则完全不建立链接**，表现就是套件中心里既没有「打开」按钮、也没有 MMH 图标、主菜单里也找不到入口。本包固定写 `dsmuidir="ui"`。
- UI 目录里必须有两样东西：`config`（应用注册 JSON）和 `images/`（图标）。`config` 的 `.url` 键**必须等于 `INFO` 的 `dsmappname`**，否则 DSM 找不到对应条目。图标模板写 `images/mmh-{0}.png`，`{0}` 会被替换成 16/24/32/48/64/72/256，**七个尺寸必须全部存在**，缺一个就可能导致图标整体不显示。为规避 `dsmuidir` 语义差异，同样的 `config` + 七张图标会镜像写到 `ui/`、`app/`、`app/ui/` 三处（`dsmUiDirs()`）；`app/ui/` 原本是 fnOS 载荷自带的注册目录，其 `config` 声明的应用 id 是 `mmh.Application`（≠ `dsmappname`）且只带 64/256 两张图标，必须被我们的版本覆盖，否则就是一颗埋在载荷里的地雷。
- `WIZARD_UIFILES` 只有 `install_uifile` / `upgrade_uifile` / `uninstall_uifile` 三种（官方文档所列；本机 DSM 上 11 个第三方套件的 `WIZARD_UIFILES` 里零例外）。**没有 `config_uifile`**：本包曾用它做「设置」入口，但 DSM 从不读它，套件中心也不会出现「设置」。`scripts/config` 同样不是 DSM 生命周期脚本，保留它只是给 SSH 用户一条手动的改端口命令（`sudo -E wizard_port=7780 /var/packages/mmh/scripts/config`）。
- 生命周期脚本（`preinst` / `postinst`）写进 `SYNOPKG_TEMP_LOGFILE` 的消息**只在脚本返回非零、安装失败时才会显示**，安装成功时用户看不到；而向导阶段的 `install_uifile.sh` 写进同一个变量的内容是**向导 JSON 本身**，DSM 会读取并渲染。两者共用变量名但语义完全不同，不要混用。
- 端口占用检查分三层：**向导**（`install_uifile.sh` / `upgrade_uifile.sh`）在用户填端口之前就说明端口情况（本套件自己在用 → 保持；别人在用 → 点名并预填下一个空闲端口）；`scripts/preinst` 在解包前再核一次，只做**提示**（识别占用者的 PID / 归属并写进 `SYNOPKG_TEMP_LOGFILE`，然后 `exit 0` 让安装继续）；真正决定最终端口的是 `scripts/postinst`。不要用「`preinst` 非零退出中止安装」的方案：那会在用户面前直接掐死安装，拿不到 `postinst` 里的自动顺延。
- `scripts/postinst` 在端口空闲、或占用者是当前套件自己的旧进程时继续；遇到**外部占用**（Docker 版 MMH、另一个套件、任意其他服务）时从请求端口 +1 起探测，取第一个空闲端口**自动顺延**，写入 `mmh.env` 的 `PORT`，并同步 `package/ui/config` 的「打开」入口与向导默认值。`postinst` 只在「顺延 200 次仍找不到空闲端口」时才失败——`postinst` 返回非零会让 DSM 把套件标记为 corrupted，所以不能用来表达端口冲突。
- 如果 DSM 提示“套件文件格式不正确，请联系套件开发人员”，先确认上传的是正式 `.spk`，不是 `*-spk-source.tgz`；如果正式 `.spk` 仍报错，应重新构建并发布下一个补丁版本。

## 用户安装

1. 打开 GitHub Release 页面。
2. 下载适合当前群晖设备架构的 `.spk`：
   - x86_64：`mmh-synology-v0.1.x-x86_64.spk`
   - ARM64：`mmh-synology-v0.1.x-arm64.spk`
3. 在 DSM 套件中心选择手动安装并上传 `.spk`。
4. 安装完成后，DSM 套件中心会显示 MMH 图标和「打开」按钮，DSM 主菜单里也会出现 MMH 入口；默认指向 `http://群晖IP:7777/`。如果在安装向导里改了端口，或者 7777 已被别的程序占用而自动顺延，以「打开」按钮实际指向的端口为准（也可查看套件数据目录里的 `mmh.env`）。
5. 之后想改端口：DSM 官方没有为第三方套件提供「设置」向导，所以按下面的「安装后的端口与后续改端口」操作。

### 安装时的端口占用检查

DSM 显示安装向导、用户提交端口之后，`scripts/preinst` 会在**解包安装之前**检查该端口：

| 端口状态 | 行为 |
| --- | --- |
| 未被监听 | 直接继续安装 |
| 被**本套件版 MMH 自己的进程**监听（例如升级时旧进程还没退出） | 放行，交给启动脚本处理 |
| 被任何其他程序监听 | **给出提示但不中断安装**；`postinst` 完成后自动顺延到后面第一个空闲端口 |

“其他程序”是严格定义的：**按进程所属的 DSM cgroup 判定**——属于 `<pkg>.slice/pkgctl-<pkg>.service` 且不在容器里的进程才算“本套件自己”。以下都算“别人”：

- Docker 版 MMH（`docker-proxy` 端口映射，或容器内运行的 MMH 进程）；
- 另一个群晖套件（即使也叫 mmh，只要不是当前这个套件包）；
- 任意其他服务。

**不要改用「`/proc/<pid>/cmdline` 里有没有 `app/server/server.js`」来判定自己人**——2026-09-30 在 DSM 7.2（192.168.2.148）实测这条路永远匹配不上，会把正在运行的自己判成外人，正是「升级 0.1.67 时向导提示 7779 被占用、要改用 7780」的根因：

- Next.js standalone 启动时会改写 `argv[0]`（`process.title = "next-server (vX.Y.Z)"`，见 `node_modules/next/dist/esm/server/lib/start-server.js`），`cmdline` 读出来只有 `next-server (v16.2.6)`，`server.js` 路径已经没了；
- `/var/packages/mmh/target` 是指向 `/volumeX/@appstore/mmh` 的软链接，`readlink /proc/<pid>/exe` 得到 `/volume1/@appstore/mmh/app/bin/node`，和未解析的 `$APP_DIR/app/bin/node` 永远不相等。

cgroup 路径不受这两者影响，所以 `process_belongs_to_package()`（cgroup）+ `process_runs_our_server()`（`*/@appstore/<pkg>/app/bin/node` 兜底）取代了原来的 cmdline / exe 比对；`process_is_containerized()` 仍然先跑，保证 Docker 版 MMH 始终算外人。

检查结果同时写入 `SYNOPKG_TEMP_LOGFILE`（DSM 安装界面/日志可见）和脚本 stderr。提示会说明占用者的 PID、进程名与归属类型（Docker 端口映射 / 容器进程 / 普通进程），并说明「安装会继续，完成后自动改用后续可用端口」，同时给出两条出路：回到安装向导自己填一个端口重新安装，或先停止占用该端口的程序。

### 安装后的端口与后续改端口

- **自动顺延**：`postinst` 发现请求端口被别的程序占用时，从该端口 +1 开始探测，取第一个空闲端口，写入 `mmh.env` 的 `PORT`，并同步 DSM 套件卡片的「打开」入口（`package/ui/config`，镜像 `app/config`）和向导默认值。`mmh.log` 与安装输出会记录 `auto-advanced from <请求端口> (occupied)`。
- **用户自己填**：安装向导的“MMH 网络端口”字段始终可填（1–65535 校验）。端口被**别的程序**占用时，描述里会写出占用者（短形式）并把默认值预填成下一个空闲端口；被本套件自己占用时描述会说明“由 MMH 自身占用，安装后会继续沿用”，默认值保持原端口。**升级时把预填值改成别的端口再提交即会生效**（见下方「端口优先级」）。
- **后期编辑**：端口的唯一真源是 `/var/packages/mmh/var/mmh.env` 里的 `PORT=`。停用套件后改它，再启用即可——`start-stop-status` 启动时会用 `mmh.env` 的端口同步 DSM 的「打开」入口（`ui/config`、`app/config`、`app/ui/config` 三份镜像），不需要手工改 config。SSH 一条命令也可以：`sudo -E wizard_port=7780 /var/packages/mmh/scripts/config`。
- **升级/重装时改**：`upgrade_uifile` 会把当前端口预填进“MMH 网络端口”。**只要真的把值改成别的端口再提交，升级就会改用新端口**；保持预填值不动（或向导脚本没跑、退回静态默认）则沿用 `mmh.env` 里保存的原端口。判定靠向导脚本写下的 `/var/packages/mmh/var/mmh-wizard-port` 记录（详见下方「端口优先级」）。当然也可以用上一条的「停用 → 改 `mmh.env` → 启用」。
- **不要指望套件中心的「设置」入口**：DSM 没有为第三方套件提供设置向导，`config_uifile` 这个名字在官方文档和本机 DSM 上都不存在（11 个第三方套件的 `WIZARD_UIFILES` 里零例外），写了也不会出现入口。要真正提供「应用内改端口」，应把端口设置做进 MMH 自己的设置页。

端口优先级（`preinst` 与 `postinst` 同一口径）：**① 用户在向导里明确改成了「向导预填值以外」的端口 → 用向导值；② 否则已有安装（升级/重装）沿用 `mmh.env` 已保存的 `PORT`；③ 全新安装用向导填写值；④ 最后兜底包内默认 `7777`。**

「用户是否真的改过」由向导脚本写下的记录文件判定：动态向导把自己算出的默认端口写进 `<套件数据目录>/mmh-wizard-port`，`postinst`（以及做提示的 `preinst`）只有在该记录**存在且与提交值不同**时才采用向导值，并在读完后删除该记录。记录不存在（向导脚本未执行、退回静态 `install_uifile`，或没有向导）时一律回退已保存的 `PORT` —— 这一条正是防止静态默认 `7777` 把在用的端口静默挪走。

## 用户更新

下载更高版本、同架构的 `.spk`，在 DSM 套件中心对已安装的 MMH 覆盖安装。更新会清理旧的运行痕迹，只保留并恢复套件数据目录中的 SQLite 数据库和原端口；安装输出及 `mmh.log` 会记录最终端口。覆盖升级时端口优先级是：**在向导里把预填端口改成别的值 → 用向导值；没改 → 沿用 `mmh.env` 已保存的 `PORT`**（预填值本身就是原端口，所以不动字段就是「沿用原端口」）。原端口被别的程序（含 Docker 版 MMH）占用时，`upgrade_uifile` 会先显示占用情况并预填空闲端口，`preinst` 再提示一次，`postinst` 最后自动顺延并把新端口写回 `mmh.env`，不会因为端口冲突把安装判为损坏。原端口由**本套件自己的旧进程**占用（升级时的常态）属于正常情况：向导会保持原端口、不再提示“被占用”，也不会顺延到 7780。不要把卸载旧版再安装新版作为日常更新方式。

## 打包命令

先构建 SQLite standalone：

```bash
npm run build:synology:app
```

再按架构打包：

```bash
SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run build:synology
SYNOLOGY_TARGET_ARCH=arm64 SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run build:synology
```

只生成调试 stage 归档：

```bash
SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-x64.tar.gz npm run stage:synology
SYNOLOGY_TARGET_ARCH=arm64 SYNOLOGY_NODE_TARBALL=/path/to/node-v20.x-linux-arm64.tar.gz npm run stage:synology
```

打包前后校验：

```bash
npm run check:synology
SYNOLOGY_VERIFY_BUILT_SPK=1 npm run check:synology
```

端口行为的分支回归测试（读**生成后**的脚本，不是读生成器源码，避免测试与实现漂移）：

```bash
sh .skill/synology-spk-port-guard/scripts/port-flow-test.sh      # postinst 的端口决策
sh .skill/synology-spk-port-guard/scripts/wiz-decision-test.sh   # 向导的 自家 / 外人 / 空闲 分支
```

两个 harness 都不要和别的 `sh` 脚本串在一条命令里跑，也不要让脚本内部执行 `rm`：沙箱的批量删除守卫会连带把整条命令 SIGTERM 掉，测试输出会全部丢失。

在真机 DSM 上复验（不必安装）：`.skill/synology-spk-port-guard/scripts/wiz-test.sh`（跑生成的向导脚本 + 校验 JSON）以及「判定自己人」的两个正负样例——本套件进程必须判为 own，Docker 容器里的 `next-server` 必须判为 foreign。

## 发布规则

- 凡是正式发布包含群晖 `.spk`，必须先在发布前本地生成同版本 x86_64 / arm64 两个 `.spk`，交给真实 DSM 环境安装/覆盖升级测试；用户确认可以安装且 MMH 可以启动后，才允许创建 GitHub Release 或上传公开 SPK 资产。
- 正式 `.spk` 打包必须在 Linux 环境完成；如果当前机器是 Windows 或缺少对应 Linux Node runtime tarball，只能视为发布阻塞，不能用 GitHub Release workflow 直接替代首次安装测试。
- 本地交付测试前必须对两个架构分别执行 `SYNOLOGY_VERIFY_BUILT_SPK=1 npm run check:synology`，arm64 额外带 `SYNOLOGY_TARGET_ARCH=arm64`。
- 如果其他分发面需要先发布，而群晖本地测试尚未通过，Release 说明中必须明确“群晖 SPK 暂缓发布”，并且不得上传 `.spk` 资产。
- GitHub Release 通过 `.github/workflows/synology-release.yml` 构建并上传 `release-artifacts/synology/*.spk`。
- Release workflow 必须重新构建 `.spk`，不能把 `*-spk-source.tgz` 当成用户安装包。
- 包版本直接使用 `package.json` 的 `0.1.x`，与 GitHub Release tag、GHCR 镜像 tag、飞牛 `.fpk` 和 Android 版本保持同号。
- 群晖版运行时设置 `MMH_DEPLOY_TARGET=synology`，系统更新页只展示套件版本；更新由 DSM 套件中心或手动安装新版 `.spk` 管理。
- 长期运行的 Node 服务默认使用 `MMH_NODE_MAX_OLD_SPACE_MB=auto`，启动时按宿主机内存自动分档；如果正常导入或识别任务频繁触顶，可在套件数据目录中的 `mmh.env` 中写成明确数字后重启套件。`/api/health` 会返回宿主内存、运行限制和内存压力，便于区分数据库不可用、应用未启动和内存接近阈值。
- `.spk` 不得包含本机 `.env`、私有 token、SSH 信息、邮箱授权码、AI key 或数据库备份。
