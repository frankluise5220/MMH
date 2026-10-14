# MMH Bug Harness

常驻检测服务：**盯 GitHub issue + MMH 反馈邮箱，用指定模型把原始报错写成规范修复任务**，
落到 `tasks/` 目录供第三方 harness 读取执行。

## 它做什么 / 不做什么

| 做 | 不做 |
|---|---|
| 轮询 GitHub open issue（含评论） | 不拉仓库、不跑构建、不碰 git |
| 轮询反馈邮箱未读邮件（含截图附件、客户端日志） | 不提交代码、不推送、不开 PR |
| 用模型分诊（过滤建议/提问/赞助/重复） | 不合并任何东西 |
| 撰写任务规格：复现步骤、疑似文件、验收标准、硬约束 | 不删除用户邮件（只标记已读） |
| 产出 `tasks/pending/<id>/{task.md,task.json,assets/}` | 不调用第三方 harness |

之所以把职责切得这么窄：**NAS 侧负载极低**（只有 HTTP 出站），能在内存紧张的群晖上长期常驻；
重活（改代码、跑 tsc）交给第三方 harness 在有算力的机器上做。

## 数据流

```
GitHub Issues ─┐
               ├─► 去重(状态库) ─► 模型分诊+写规格 ─► tasks/pending/<id>/
反馈邮箱(IMAP) ─┘                                      │
                                                       ▼
                                          第三方 harness 读目录 → 改代码
                                                       │
                                    mv pending/<id> → claimed/ 或 done/
                                                       ▼
                                        服务下轮扫描目录，状态回流 index.json
```

## 任务目录契约

见 [`tasks/README.md`](tasks/README.md)（服务启动时自动写入 `tasks/README.md`）。
要点：**harness 只需移动目录**，不需要调任何 API、不需要写状态文件。

任务 ID：GitHub 用 `GH-<number>`，邮件用 `MAIL-<messageId 摘要>`。

## 配置

复制 `.env.example` 为 `.env` 并填写。关键项：

| 变量 | 说明 |
|---|---|
| `HARNESS_UI_PASSWORD` | 页面登录密码，**初始 `mmh12345`**，登录后请改掉；填 `-` 关闭登录 |
| `GITHUB_TOKEN` | 细粒度 PAT，**Issues: Read** 权限。**公开仓库可留空**（匿名限 60 次/小时，间隔建议 ≥ 10 分钟）；私有仓库必填 |
| `GITHUB_LABELS` | 只处理带这些标签的 issue；留空 = 全部 open issue |
| `IMAP_HOST/PORT/USER/PASS` | `mmh@floatingice.win` 的 IMAP 凭据（授权码，不是登录密码） |
| `IMAP_SUBJECT_FILTER` | 默认 `[MMH Bug]`；`*` 表示不过滤 |
| `AI_BASE_URL/API_KEY/MODEL` | 任意 OpenAI 兼容端点（DeepSeek / 硅基流动 / 自建网关…） |
| `HARNESS_FIRST_RUN` | `backfill`（回补现存 open issue）/ `now`（只监听后续活动） |
| `HARNESS_DRY_RUN` | `true` 只打印不落盘，用于首次验证 |

**模型没配也能跑**：会退化为规则分诊（按邮件主题前缀 / issue 来源判定），任务照常产出。

## 配置页

服务自带一个自包含的配置页（内联 CSS/JS，无框架、无外部资源），**挂在同一个端口**：

```
http://<NAS-IP>:7788/          # 初始密码 mmh12345
```

三个页签：

| 页签 | 内容 |
|---|---|
| **配置** | 五个分组（访问控制 / 运行参数 / GitHub / 反馈邮箱 / 模型）的表单；每个字段标注**当前值的来源**（页面 / 环境变量 / .env / 默认值）；GitHub、邮箱、模型各有一个**测试连接**按钮 |
| **任务看板** | pending / claimed / done / skipped 计数 + 任务列表，点开看完整 `task.md` 与截图附件 |
| **运维** | 运行状态、**立即扫描一轮**、最近日志（内存环形缓冲，自动刷新） |

### 访问控制

- **初始密码 `mmh12345`** —— 开箱即用。登录后请在「配置 → 访问控制」改成自己的；仍在使用初始密码时页面顶部会有提醒。
- 密码非空即启用登录：**除 `/login`、`/healthz` 外一律要求登录**。会话由「密码派生的签名 cookie」维持：不落库、重启不失效、**改密码即让所有旧会话失效**。
- 要彻底关掉登录，把密码显式设成 `-`（只建议端口绑 `127.0.0.1` 时）。**留空 ≠ 关闭** —— 留空只会回落到默认密码。
- 登录页是原生表单 POST，不依赖 JS；页头有「退出」。
- 密码可在配置页直接改（改完当前会话会失效，需重新登录），**无需重启容器**。

> ⚠️ 端口一旦开到局域网，**没有密码就等同于把配置写权限交给同网段所有设备** ——
> 配置页虽然不回传密钥明文，但能改写「模型接口地址」，服务下一轮就会把 API Key 发到那个地址。
> 所以 compose 里默认 `7788:7788` 开放，前提是你已经改了初始密码。

### 配置分层（重要）

逐键优先级：**`data/config.json` > 环境变量 / `.env` > 代码默认值**

- 在页面上保存的值写进 `data/config.json`（权限 600），**下一轮立即生效，不用重启容器**
- `.env` 退化为「首次启动种子」与 gitops 硬编码入口
- 想清掉页面覆盖 → 页面上点「清除页面覆盖」，即回落到环境变量或默认值
- **密钥永不回传浏览器**：页面上只显示掩码（`••••1234`），留空即不修改
- 端口是唯一需要重启的项（HTTP 监听不热切换），页面上已标注

### 远程访问

端口默认绑全网卡（`7788:7788`），局域网直接访问：

```
http://<NAS-IP>:7788/
```

也可以继续用 SSH 隧道（不想开端口时）：

```bash
ssh -N -L 7788:127.0.0.1:7788 mmh148
# 然后本地浏览器打开 http://127.0.0.1:7788/
```

## 本地运行

```bash
cd harness
npm install --omit=dev
cp .env.example .env      # 填配置
npm run selftest          # 离线自检：分诊→落盘→状态回流→索引（不联网）
npm run once              # 跑一轮后退出
npm start                 # 常驻（含 /healthz /status HTTP 接口）
```

## 部署到群晖

```bash
# 在 NAS 上：/volume1/docker/mmh-bug-harness/
docker compose up -d --build
docker compose logs -f
```

容器用 **host 网络**（见 `docker-compose.yml` 里的说明），服务直接绑宿主机的 `0.0.0.0:7788`，
局域网内用 `http://<NAS-IP>:7788/` 打开，用初始密码 `mmh12345` 登录后改成自己的。
健康检查端点 `/healthz` 免鉴权。

> 之所以不用默认的 bridge + 端口映射：**模型网关可能不在容器能路由到的网段**。
> 148 是双网卡（`ovs_eth0` = 192.168.2.148、`ovs_eth1` = 192.168.5.148），
> 实测 bridge 网络下容器能到 192.168.2.x，但到 192.168.5.x 一律超时（宿主机自己可以）。
> 走 host 网络后容器直接用宿主机的路由表。代价是端口冲突要自己留意。

单轮验证（不启动常驻）：

```bash
docker compose run --rm mmh-bug-harness node src/index.mjs --once
```

## 运维接口

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/healthz` | 存活、最近轮询时间、任务计数 |
| GET | `/status` | 配置摘要（密钥脱敏）+ 最近任务列表 |
| POST | `/rescan` | 立即触发一轮扫描 |

## 安全与守卫

- 密钥只经 `.env` / `data/config.json` 注入，**不进镜像**（`.dockerignore`、`.gitignore` 都已排除）。
- 页面**默认要求登录**（初始密码 `mmh12345`），`/healthz` 免鉴权供 Docker 健康检查使用。
- **密钥永不回传浏览器**：配置接口对密码类字段只回 `{isSet, masked}`。
- 模型调用有 `AI_MAX_CALLS_PER_CYCLE` 上限，防止首次 backfill 打爆额度。
- 邮件处理失败不标记已读 → 下轮重试；去重靠 Message-ID，不会重复建任务。
- 任务文件是**唯一输出**，且明确要求 harness「只改代码、不提交」。

## 排错

| 现象 | 排查 |
|---|---|
| 日志里出现「未配置 GITHUB_TOKEN，以匿名方式读取」 | 正常：公开仓库匿名即可（限 60 次/小时）。私有仓库或额度不够时在配置页填 PAT |
| 邮件收不到 | IMAP 授权码是否过期；`IMAP_SUBJECT_FILTER` 是否把邮件过滤掉了（设 `*` 试） |
| 任务没生成 | 看日志里「模型调用失败」→ 走兜底也会生成；若 `HARNESS_DRY_RUN=true` 则只打印不落盘 |
| `index.json` 有条目但 `tasks/pending/` 是空的 | 手工删过任务目录但没停服务（内存状态库仍在）。`index.json` 里这些条目会带 `missingOnDisk: true`；**停容器 → 删 `data/state.json` → 启动** 即可重建 |
| 模型返回不是 JSON | 已容错（抠 `{}` + 兜底），但会退化任务质量；换更强的模型 |
