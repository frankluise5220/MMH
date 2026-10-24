# MMH MCP 接入指南

MMH 内置 MCP（Model Context Protocol）服务端。AI 助手（Claude Desktop、Claude Code、Cursor、CodeBuddy 等）通过它访问你的账簿：查询账户、分类、流水、持仓、存单和收支统计，以及记账和删账。

所有余额、合计、持仓盈亏由 MMH 服务端计算后返回，助手不自行重算，口径与 Web 界面一致。账本数据留在你自己的设备或 NAS 上，助手只是远程调用。

## 前置条件

- MMH 0.1.71 或更高版本，更早版本没有 MCP 端点。
- 一把 Access Key，在「设置 → 外接 API Key」创建。
  - 「只读（仅查询）」：只能查询，建议作为默认选择。
  - 「读写（查询 + 记账）」：额外允许记账和删账。
  - 完整 Key 只在创建弹窗里显示一次，关闭后无法再查看，请当场复制保存。

## 连接方式

MMH 的 MCP 端点是 `POST /api/v1/mcp`（Streamable HTTP，无状态，每次请求独立鉴权）。鉴权用请求头 `Authorization: Bearer <Access Key>`，也接受 `X-Api-Key`。

### 支持远程 HTTP 的客户端

在客户端的 MCP 设置里添加：

```json
{
  "mcpServers": {
    "mmh": {
      "type": "http",
      "url": "http://<MMH 地址>/api/v1/mcp",
      "headers": { "Authorization": "Bearer <Access Key>" }
    }
  }
}
```

`<MMH 地址>` 填你的 MMH 访问地址，例如 `192.168.5.199:7777`。

### 只支持本机子进程的客户端

部分客户端（Claude Desktop、CodeBuddy）只启动 `type: "stdio"` 的本地子进程。用仓库自带的桥接脚本 `scripts/mmh-mcp-stdio.cjs` 转发，无需改动 MMH：

```json
{
  "mcpServers": {
    "mmh": {
      "type": "stdio",
      "command": "node",
      "args": ["<仓库路径>/scripts/mmh-mcp-stdio.cjs"],
      "env": {
        "MMH_MCP_URL": "http://<MMH 地址>/api/v1/mcp",
        "MMH_MCP_KEY": "<Access Key>"
      }
    }
  }
}
```

Key 走环境变量，不经过对话记录。

## 工具清单

| 工具 | 权限 | 用途 |
| --- | --- | --- |
| `mmh_list_accounts` | 只读 | 列出账簿全部账户及余额 |
| `mmh_list_categories` | 只读 | 列出三级分类树 |
| `mmh_list_transactions` | 只读 | 按账户分页读取流水 |
| `mmh_get_investment_shell` | 只读 | 单个投资账户的持仓、明细、市值 / 成本 / 收益 |
| `mmh_list_deposit_lots` | 只读 | 列出存款存单 |
| `mmh_list_bond_lots` | 只读 | 列出债券存单 |
| `mmh_query_investment_flow` | 只读 | 按日期区间汇总买入 / 卖出金额 |
| `mmh_get_monthly_summary` | 只读 | 年度收支统计 |
| `mmh_create_transaction` | 读写 | 记一笔支出 / 收入 / 转账 |
| `mmh_delete_transaction` | 读写 | 删除一笔流水 |

只读 Key 的 `tools/list` 看不到两个写工具，写调用还会在服务端再次被拦下。

## 各工具说明

### mmh_list_accounts

列出账簿全部账户及余额，不做类型过滤，覆盖现金、储蓄卡、信用卡、电子钱包、存款、投资（基金 / 理财 / 债券 / 股票 / 贵金属 / 固定资产）、往来款、贷款和保险账户。

余额口径由服务端按账户类型计算：纯投资账户返回市值，保险账户返回展示余额，信用卡返回当前账单周期余额，其余返回维护余额。可选参数 `kind`、`investProductType` 按类型过滤。

### mmh_list_categories

列出分类树。分类分三级：一级是交易类型（expense / income / transfer / advance / investment），二级是该类型下的顶级分类（如餐饮、住房、固定资产），三级是子分类。固定资产是支出下的二级分类，不属于住房。可选参数 `type` 按交易类型过滤。

### mmh_list_transactions

按账户分页读取流水，行含 id、date、postedAt、type、amount、accountName、toAccountName、categoryName、note；金额带符号，支出为负、收入为正。本工具没有日期区间过滤，「这个月」类问题不要用它逐页扫描，改用 `mmh_get_monthly_summary` 或 `mmh_query_investment_flow`。参数：`accountId`、`page`、`pageSize`（最大 100）、`locateDate`（定位到某日期附近的页）。

### mmh_get_investment_shell

单个投资账户的一站式视图：持仓、已清仓持仓、全部明细行、市值 / 成本 / 历史收益合计。覆盖基金、理财、贵金属与固定资产账户；债券用 `mmh_list_bond_lots`，存款用 `mmh_list_deposit_lots`。

明细行的 date 是申请日，fundConfirmDate 是 T+N 确认日，两者可能跨月。参数：`accountId`（必填）、`fundCode`、`entryScope`、`showCleared`。

### mmh_list_deposit_lots 与 mmh_list_bond_lots

按张列存单：一笔买入行即一张存单，同一产品可以有多张存单，每张各自计息、付息。存单带期限、利率、到期日、付息计划和剩余本金。参数 `accountIds` 按账户过滤；存款侧另有 `includeClosed`（已结清存单默认不返回）。

### mmh_query_investment_flow

按日期区间汇总买入 / 卖出金额，服务端固定口径，调用方不要用明细重算：

- 默认按申请日（`dateBasis=apply`）归集，可选确认日（`confirm`）。月底申购 T+N 确认会跨月，两种口径结果可能不同。
- 分红再投（dividend_reinvest）不计入买入：只增加份额，没有现金流出。
- 申购失败退款从买入总额中扣除。
- 定投产生的申购计入买入，同时在 `regularInvestAmount` 中单列。
- 买入金额取申购金额（含手续费），不是份额 × 净值，也不是赎回到账金额。
- 只覆盖基金与货币基金；理财、债券、贵金属、固定资产各有独立业务表，暂不支持。

参数：`from`、`to`（必填，YYYY-MM-DD，`to` 含当天）、`subtype`（buy / sell / all）、`productType`（fund / money / all）、`dateBasis`、`groupBy`（none / fund / account）。

### mmh_get_monthly_summary

按年度返回收支统计：全年收支合计、逐月收支与结余、分类 / 标签 / 机构分布，与 Web「统计」页面完全同口径。「这个月花了多少」「哪类支出最多」优先用它。参数：`year`（省略为当前年）、`accountIds`、`tagIds`。

### mmh_create_transaction

记一笔支出 / 收入 / 转账。服务端解析分类、维护账户余额与投资持仓、写入账单周期。

- `amount` 传绝对值，符号由 `type` 决定，传负数也会取绝对值。
- 账户和分类按 ID 或精确名称指定；分类必须已存在，不会隐式创建，重名会被拒绝。
- 转账需给出转出与转入账户，且不能相同。
- `date` 省略用今天，`postedAt` 省略与 `date` 相同。
- 贷款、存款、基金资金、股票资金、基金、理财账户不能作为普通转账对手方，这类操作请用 MMH 里对应的专用记账窗口。

返回新建流水的 id。

### mmh_delete_transaction

按 ID 删除一笔流水。服务端负责撤销快照、回滚账户余额与投资持仓。删除前先回读确认目标流水，避免误删。

## 口径与限制

- 合计、余额、持仓盈亏一律以服务端返回为准，不要用明细行自行加总。
- 记账用三级分类名（如「外出就餐」）。「餐饮」是二级父分类，直接传入会失败，先调 `mmh_list_categories` 确认真实名称。
- 日期统一用 YYYY-MM-DD；金额不做跨币种换算。
- 净资产汇总工具尚未上线，暂不提供。
- 在浏览器里直接调用 `/api/v1/transactions/detail` 等 GET 端点会被 CORS 预检拦下（这些端点未导出 OPTIONS）；经 `/api/v1/mcp` 调用不受影响，桌面 MCP 客户端也不受限制。

## 常见鉴权失败

| 现象 | 原因 |
| --- | --- |
| `{"ok":false,"code":"UNAUTHORIZED","error":"未登录"}` | 没带 `Bearer ` 前缀。只认 `Bearer <key>` 与 `X-Api-Key`，裸 token 会被当成未登录 |
| `{"ok":false,"code":"INVALID_API_KEY","error":"API Key 无效"}` | Key 与库中任何一条都不匹配。多数情况是复制了列表里的掩码（完整 Key 只在新增弹窗出现一次），或末尾多了空格、换行 |

## 交给 AI 助手的提示词

把下面整段复制给你的助手（harness），它会按 MMH 的口径使用这些工具：

```text
你是我的家庭账簿助手，通过 MMH（MoneyMoneyHome）的 MCP 服务端访问我的本地账本。数据不出我的设备；只使用下列 MCP 工具，不要编造账本里没有的数据。

查账：
- 账户和余额用 mmh_list_accounts。余额一律以服务端返回为准，禁止用流水自行加总。
- 分类用 mmh_list_categories。分类分三级，记账时必须用已存在的三级分类名（如「外出就餐」）；「餐饮」是二级父分类，不能直接使用。
- 按账户翻流水用 mmh_list_transactions。它没有日期区间过滤，不要用它逐页扫描「这个月」类问题。
- 「这个月花了多少」「哪类支出最多」优先用 mmh_get_monthly_summary（年度收支统计，与 Web 统计页同口径）。
- 「这个月买了多少基金」「今年赎回了多少」「定投投了多少」用 mmh_query_investment_flow。口径：默认按申请日归集（可选确认日）；分红再投不计入买入；申购失败退款从买入中扣除；定投申购计入买入并在 regularInvestAmount 单列；目前只覆盖基金与货币基金。
- 单个投资账户的持仓、明细、市值 / 成本 / 历史收益用 mmh_get_investment_shell；债券用 mmh_list_bond_lots，存款用 mmh_list_deposit_lots（按张管理，一张一行）。

记账与删账：
- 记一笔支出 / 收入 / 转账用 mmh_create_transaction。金额传绝对值，符号由 type 决定；账户和分类按 ID 或精确名称指定；贷款、存款、基金资金、股票资金、基金、理财账户不能作为普通转账对手方。
- 删除流水用 mmh_delete_transaction。删除前必须先回读确认目标流水。

纪律：
1. 合计、余额、持仓盈亏一律以服务端返回为准，不要用明细重算。
2. 写操作（记账、删账）执行前，先向我复述要点并等我确认。
3. 名称匹配不到或重名时，先调对应的 list 工具确认真实名称，不要猜 ID。
4. 日期统一用 YYYY-MM-DD；金额不做跨币种换算。
5. 工具报错时如实转告错误信息，不要编造参数重试。
```
