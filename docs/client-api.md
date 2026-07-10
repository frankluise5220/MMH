# 客户端 API 说明

本文档用于 Web、iOS、Android 接入 MMH 后端 API。当前阶段先记录接口契约和约定，后续在接口稳定后可再生成 OpenAPI 或 typed client。

## 总体约定

- 客户端接口使用 `/api/v1` 作为版本前缀。
- Web 可以使用更完整的明细接口，移动端可以使用聚合接口，但两者必须共享同一套业务含义和计算结果。
- debug、test、cleanup、internal 类接口不是客户端接入契约，除非本文档明确列入。
- 面向客户端的 route 文件顶部应写 JSDoc，说明方法、参数、返回结构。

## 通用返回格式

推荐成功格式：

```json
{
  "ok": true,
  "data": {}
}
```

推荐失败格式：

```json
{
  "ok": false,
  "error": "错误说明"
}
```

删除、修改类接口在目标 ID 不存在时必须返回失败，不能静默成功。

## 登录与上下文

客户端访问财务数据前，需要明确以下上下文：

- 服务器：客户端连接的 Web 服务地址。
- 账簿：财务数据所在账簿。
- 用户：账簿下的登录用户。
- 角色：用户在账簿中的权限。

用户名和密码属于账簿/用户上下文，不只是 Web 服务进程本身。如果系统存在多个账簿，登录或会话接口应返回足够信息让客户端显示当前账簿并支持安全切换。

## 数据格式约定

### ID

- 客户端应使用稳定 ID 识别实体。
- API 返回列表时，应同时返回客户端展示需要的名称字段。
- 客户端不应通过显示名称推断唯一身份。

### 日期

- 日期字段必须说明是日期时间还是业务日期。
- 纯业务日期建议使用 `YYYY-MM-DD`。
- 涉及基金净值、确认日期、到账日期时，需要避免时区漂移。

### 金额和小数

- 金额、份额、净值、成本、收益字段应保持财务计算需要的精度。
- 客户端显示的小数位可以受偏好设置影响，但 API 的原始数值不应为了显示而过早截断。

### 分页、排序和筛选

列表接口应说明：

- 分页参数。
- 排序字段和方向。
- 筛选参数。
- 默认排序规则。

涉及余额、流水、基金交易明细的列表必须有确定排序，避免同一天多笔记录造成显示余额错乱。
- 交易记录可返回 `dayOrder` 作为同一显示日期内的人工业务顺序。数值越大表示越晚发生：倒序明细中越靠上，正序余额计算中越靠后。余额校准/初始余额锚点仍固定为同日最后记录。

## 模块目录

下面是计划维护的客户端 API 模块。具体接口应在实现或稳定后补充到对应章节。

### Auth

范围：

- 登录。
- 登出。
- 会话校验。
- 密码状态。
- 找回密码。

相关路径示例：

- `/api/v1/auth/verify`
- `/api/v1/auth/logout`
- `/api/v1/auth/password-status`
- `/api/v1/auth/create-ledger`
- `/api/v1/auth/password-reset/request`
- `/api/v1/auth/password-reset/confirm`

新建账簿规则：

- `/api/v1/auth/create-ledger` 用于登录页通过邀请码创建新账簿。
- 该接口必须校验系统设置中的账簿创建邀请码，不能无门槛开放。
- 成功后应直接建立新账簿管理员账号并写入登录态，让用户进入新账簿。

找回密码规则：

- `/api/v1/auth/password-reset/request` 使用用户名和绑定邮箱定位用户。
- 如果同一个用户名和邮箱匹配多个账簿，返回 `{ ok:false, code:"AMBIGUOUS_USER", households }`，客户端应让用户选择账簿后携带 `householdId` 重新请求验证码。
- 当验证码邮件实际发送成功时，接口可返回 `maskedEmail`，用于显示脱敏后的目标邮箱，如 `ab***@qq.com`。
- `/api/v1/auth/password-reset/confirm` 支持携带 `householdId`，确保验证码只重置目标账簿下的同名用户。

### Overview

范围：

- 首页/概览汇总。
- 总资产、资金账户、投资账户、近期变化。

相关路径示例：

- `/api/v1/overview/summary`

### Accounts

范围：

- 资金账户。
- 投资账户。
- 账户余额。
- 账户分组。
- 往来机构/人员及简称。
- 余额重算。

相关路径示例：

- `/api/v1/accounts`
- `/api/v1/accounts/balances`
- `/api/v1/accounts/investment`
- `/api/v1/account-group`

补充约定：

- 基金/货币基金类投资账户新增 `tradingCalendar` 字段，当前可选值包括 `cn_fund`、`hk_fund`、`us_fund`、`generic_weekday`。
- `POST /api/v1/accounts` 与 `PUT /api/v1/accounts` 在这类账户上接受 `tradingCalendar`；当账户类型不支持该字段时，服务端会自动清空。

### Transactions

- 普通转账只接受普通资金或信用卡目标账户。目标账户如果是基金/投资、存款或往来款，应按对应业务类型提交投资、存款或往来款交易，不能保存为普通转账。
- 普通转账只支持同币种账户，并会把账户币种写入交易 `currency`。跨币种转账必须走后续专用的换汇/跨币种流程，不能用一个金额同时代表两边账户。
- 现金、借记卡或电子钱包账户转入信用卡账户时，存储层仍为 `type = "transfer"`；客户端显示和筛选应按 `accountKind` + `toAccountKind` 识别为信用卡还款。
- `/api/v1/transactions` 与 `/api/v1/transactions/detail` 的交易项会返回 `accountKind` 和 `toAccountKind`，用于跨客户端判断转账、还款、以及特殊账户目标语义。
- 交易项中的 `date` 是业务发生日期。支出记录可带 `postedAt` 表示实际入账时间；未提供时服务端在新增支出时默认按 `date` 写入，收入、转账和投资记录通常为 `null`。
- 信用卡邮箱账单导入调用 `/api/v1/statement/import` 时，`mailSource` 可携带 `{ emailAccountId, uid, hash, subject, from, date }`。服务端会用 UID、邮件列表 hash 和解析后的稳定账单指纹阻止重复导入；稳定账单指纹只使用机构、卡号后四位、账单月份/周期，避免分类、备注、明细文本等解析规则变化造成同一账单被当作新账单。

### Categories

- `/api/v1/category` 用于收支分类列表、新增、重命名和移动。
- 分类名称在同一账簿内必须全局唯一，不区分收入、支出、代付类型，也不区分父分类。
- 新增或修改为已有名称时，接口返回 `{ ok:false, error:"分类名称已存在" }`，状态码为 `409`。
- 分类名称全局唯一后，客户端按名称匹配导入分类时不应再自行按同级或类型消歧。

范围：

- 收入、支出、转账。
- 交易详情。
- 批量编辑。
- 删除和清理。

相关路径示例：

- `/api/v1/transactions`
- `/api/v1/transactions/detail`
- `/api/v1/transactions/reorder` 用于同一账户明细、同一显示日期内调整记录顺序；成功返回 `orderedEntryIds`，客户端应以该顺序作为服务端最终顺序。
- `/api/v1/entries/batch-edit`
- `/api/v1/entries/batch-update`

### External Agent / DB Maintenance

范围：

- 外部 Agent 受控读取和维护数据库记录。
- 模型字段发现。
- 小范围补数据、核对、修正。

相关文档：

- `docs/agent-api.md`

相关路径示例：

- `/api/v1/db/models`
- `/api/v1/db/data`

注意：

- 这组接口不是普通移动端业务契约，优先使用账户、交易、基金等业务 API。
- 通用 DB API 必须认证，并屏蔽用户、密钥、邮箱、系统设置等敏感模型。
- 涉及交易、基金、余额的修改后，应调用对应业务接口或服务做重算。
- `/api/v1/entries/delete`

### Fund

范围：

- 基金名称。
- 基金净值。
- 基金交易明细。
- 基金持仓。
- 手续费率。
- 确认天数/到账天数。
- 持仓重算和净值刷新。

相关路径示例：

- `/api/v1/fund/name`
- `/api/v1/fund/nav`
- `/api/v1/fund/nav/history`
- `/api/v1/fund/entries`
- `/api/v1/fund/entry`
- `/api/v1/fund/position`
- `/api/v1/fund/fee-rate`
- `/api/v1/fund/confirm-days`
- `/api/v1/fund/refresh`
- `/api/v1/fund/sync-position`
- `/api/v1/fund/import`
- `/api/v1/invest/monthly-floating-pnl`
- `/api/v1/precious-metals/dictionaries`
- `/api/v1/wealth-products`

#### 银行理财产品主数据

- Method: `GET`
- Path: `/api/v1/wealth-products`
- Query: `institutionId?: string`
- Success: `{ ok: true, products: [{ id, name, shortName, institutionId, institutionName, currency, annualRate, termDays, note }] }`

- Method: `POST`
- Path: `/api/v1/wealth-products`
- Body: `{ name, shortName?, institutionId?, currency?, annualRate?, termDays?, note? }`
- Success: `{ ok: true, product }`

银行理财交易应保存 `wealthProductId` 作为产品身份，`fundName` 只作为兼容展示文本。理财买入/赎回入口的投资账户只能选择 `investProductType = "wealth"` 的账户。

#### 贵金属字典

- Method: `GET`
- Path: `/api/v1/precious-metals/dictionaries`
- Auth: required
- Context: server/book/user/role

Success:

```json
{
  "ok": true,
  "data": {
    "types": [
      { "id": "metal-type-gold", "code": "gold", "name": "黄金", "shortName": "金" }
    ],
    "units": [
      { "id": "metal-unit-gram", "code": "gram", "name": "克", "symbol": "g", "decimals": 3 }
    ]
  }
}
```

Notes:

- 贵金属录入应选择字典里的品种和单位，不应让用户手填基金式代码。
- 交易明细可返回 `metalTypeId`、`metalTypeName`、`metalUnitId`、`metalUnitName`、`metalQuantity`、`metalUnitPrice`、`metalFee`，用于编辑回显和跨客户端显示。
- 贵金属交易不应把品种、数量、单价写入 `fundCode`、`fundUnits`、`fundNav` 等基金字段。

#### 基金批量导入

- Method: `POST`
- Path: `/api/v1/fund/import`
- Auth: required
- Context: server/book/user/role

Request body:

```json
{
  "mode": "preview",
  "overrides": [
    {
      "fundAccount": "招商基金账户",
      "fundCode": "000001",
      "confirmDays": 2,
      "arrivalDays": 3
    }
  ],
  "items": [
    {
      "date": "2026-06-08",
      "fundSubtype": "buy",
      "source": "regular_invest",
      "cashAccount": "招商银行2758",
      "fundAccount": "招商基金账户",
      "fundCode": "000001",
      "fundName": "",
      "amount": -100,
      "units": null,
      "nav": null,
      "fee": null,
      "confirmDate": null,
      "arrivalDate": null,
      "remark": "定投"
    }
  ]
}
```

规则：

- `mode="preview"` 只返回预览和校验结果，不写库。
- `mode="import"` 会先按同样规则重新校验，通过后整批写入；任一条阻断错误都会整批回滚。
- `overrides` 用于预览弹窗表头上方的 T+N 规则块。键是 `基金账户 + 基金代码`，可覆盖确认天数与入账天数；`mode="import"` 时会把这次确认后的规则回写到确认天数库，供后续导入直接读取。
- `buy` / `buy_failed` / `refund` 等 buy 类动作会按绝对值处理金额。
- `refund` 是导入别名，服务端会兼容映射到现有退回记录子类型。
- `confirmDate` 表示净值日期，写入 `fundConfirmDate`。
- `arrivalDate` 表示入账日期，写入 `fundArrivalDate`。
- 买入退回记录会通过 `fundSourceEntryId` 显式关联到源买入记录；借记卡/现金账户明细展示这类退回入账时，按实际到账日期显示和排序。基金交易明细按源买入申请日期归集展示，退回到账日期保留在到账日期字段。
- 预览阶段会按基金账户已有配置或本次 `overrides` 自动补全确认天数、净值日期、入账日期、手续费；不会为了预览额外查询净值。
- `cashAccount` 与 `fundAccount` 都按账户匹配规则解析，基金账户必须能匹配到开放式基金账户。

Preview success:

```json
{
  "ok": true,
  "items": [
    {
      "date": "2026-06-08",
      "fundSubtype": "buy",
      "amount": 100,
      "fee": 0.15,
      "confirmDays": 1,
      "confirmDate": "2026-06-09",
      "issues": []
    }
  ]
}
```

#### 月度基金浮盈

- Method: `GET`
- Path: `/api/v1/invest/monthly-floating-pnl`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| month | string | no | 目标月份，格式 `YYYY-MM`；也可用 `year` + `monthNumber` |
| year | number | no | 目标年份，与 `monthNumber` 一起使用 |
| monthNumber | number | no | 目标月份，1-12，与 `year` 一起使用 |
| accounts | string | no | 投资账户 ID 列表，用英文逗号分隔 |

Success:

```json
{
  "ok": true,
  "data": {
    "month": "2026-06",
    "baselineDate": "2026-06-01",
    "endDate": "2026-06-30",
    "baselineFloatingPnL": 1200,
    "baselineFloatingPnLRate": 0.08,
    "endFloatingPnL": 1500,
    "endFloatingPnLRate": 0.09,
    "floatingPnLChange": 300,
    "floatingPnLRateChange": 0.01,
    "monthlyBuy": {
      "amount": 2000,
      "units": 1800.123456,
      "count": 2
    },
    "accounts": []
  }
}
```

Notes:

- 月度浮盈计算归属在 `src/lib/invest/monthlyFloatingPnl.ts`；API route 只负责参数解析、上下文获取和 JSON 输出，不维护计算公式。
- 接口从 `TxRecord` 重建月初和月末持仓，并使用 `FundNavCache` 中目标日期当天或之前最近一条净值估值，不依赖 `FundSnapshot`。
- `floatingPnLRate = floatingPnL / totalCost`；`floatingPnLRateChange = endFloatingPnLRate - baselineFloatingPnLRate`。
- `monthlyBuy` 统计确认日期落在目标月份内的基金申购交易，不包含红利再投资。
- 如果缺少净值，账户快照和持仓行会返回 `missingNavCodes`，客户端应提示先补净值再解释结果。

### Insurance

范围：

- 保险产品列表、创建和更新。
- 按保险产品名称查询公开参考资料。
- 保险投保、赎回记录仍通过交易明细接口保存，并关联 `insuranceProductId`。
- Web 设置页 `/settings/insurance-products` 用于维护保险产品库；保险持仓页只显示有交易记录的持仓。

相关路径示例：

- `/api/v1/insurance-products`
- `/api/v1/insurance-products/lookup`

#### 保险产品资料查询

- Method: `GET`
- Path: `/api/v1/insurance-products/lookup`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| name | string | yes | 保险产品名称，建议使用保单或条款上的正式名称 |
| institutionName | string | no | 承保机构名称，用于缩小官方产品库和搜索范围 |

Success:

```json
{
  "ok": true,
  "data": {
    "query": "产品名称",
    "institutionName": "保险公司名称",
    "candidates": [
      {
        "name": "产品正式名称",
        "institutionName": "保险公司名称",
        "productType": "critical_illness",
        "status": "在售",
        "saleDate": "2026-06-29",
        "termsNo": "条款编号",
        "source": "中国保险行业协会产品信息库",
        "sourceType": "official",
        "url": "https://tiaokuan.iachina.cn/",
        "confidence": "high",
        "reason": "来自中国保险行业协会公开产品库。"
      }
    ],
    "officialSources": [],
    "officialProducts": [],
    "webResults": [],
    "crawledPages": [],
    "suggestion": {
      "productType": "critical_illness",
      "institutionName": "保险公司名称",
      "confidence": "medium",
      "reason": "根据标题/摘要轻量推断"
    },
    "searchedAt": "2026-06-29T00:00:00.000Z"
  }
}
```

Error:

```json
{
  "ok": false,
  "error": "错误说明"
}
```

Notes:

- 外部资料只作为录入辅助和官方核对入口，不是数据库事实来源。
- 客户端应优先展示 `candidates` 作为可选择产品列表；不要把 `webResults` 或 `crawledPages` 原始摘要直接铺到表单里。
- `officialProducts`、`webResults`、`crawledPages` 只作为参考/调试材料，展示给用户时必须先整理成结构化候选项。
- 查询会先尝试公开行业产品库接口；如果不可用、限频或缺少必要条件，再爬取公开搜索结果页面并抽取产品名称、承保机构、条款号、状态、日期等结构化字段。
- 爬虫只访问公开页面，不绕过验证码、登录、robots 防护或非公开数据控制。
- 客户端不能把搜索摘要当作精算、保障责任、费率或销售资格依据。

### Scheduled Tasks

范围：

- 定期计划任务。
- 当前支持基金定投、还房贷、转账、保险缴费四类任务。
- 任务共用计划字段：资金账户、任务类型、周期、下次执行、已执行次数、开始日期、停止日期。
- 任务内容按类型保存不同目标：基金代码/基金账户、贷款账户、转入账户、保险产品。
- 执行时调用现有交易、基金、保险业务语义，不新增独立交易类型。
- 每日自动执行扫描所有执行中计划，未到执行日的计划直接跳过。

相关路径示例：

- `/api/v1/regular-invest`
- `/api/v1/regular-invest/records`
- `/api/v1/regular-invest/execute`
- `/api/v1/regular-invest/batch-execute`
- `/api/v1/regular-invest/auto-execute`

### Settings

范围：

- 用户设置。
- App 偏好。
- 颜色规则。
- 邮件/Resend 设置。
- 基金查询 API。
- 系统更新。

相关路径示例：

- `/api/v1/settings/users`
- `/api/v1/settings/app-preferences`
- `/api/v1/settings/color-scheme`
- `/api/v1/settings/email`
- `/api/v1/settings/email-accounts`
- `/api/v1/settings/resend`
- `/api/v1/settings/fund-query-api`：GET/POST/PUT/DELETE 管理基金查询来源，PATCH 批量保存拖拽后的优先级；基金净值查询会优先使用账户默认 API，其次按机构场景（如支付宝基金账户优先支付宝来源），最后按全局优先级尝试。
- `/api/v1/settings/backup`
- `/api/v1/settings/system-update`

### Mobile Sync

范围：

- 移动端快速同步。
- 移动端概览、账户、交易、基金的聚合数据。

相关路径示例：

- `/api/v1/mobile/sync`

移动端聚合接口可以减少请求次数，但不应复制 Web 的业务计算逻辑。聚合数据应来自同一套服务模块或统一查询口径。

交易同步项包含 `accountKind` 和 `toAccountKind`。移动端应使用这两个字段识别信用卡还款等账户目标语义，不要依赖账户名称或备注文本猜测。

## 接口详情模板

后续补充具体接口时使用以下模板：

````md
### 接口名称

- Method: `GET`
- Path: `/api/v1/example`
- Auth: required
- Context: server/book/user/role

Query:

| Name | Type | Required | Description |
| --- | --- | --- | --- |
| id | string | yes | Entity ID |

Body:

```json
{}
```

Success:

```json
{
  "ok": true,
  "data": {}
}
```

Error:

```json
{
  "ok": false,
  "error": "错误说明"
}
```

Notes:

- 说明排序、日期、金额、刷新影响等特殊规则。
````
