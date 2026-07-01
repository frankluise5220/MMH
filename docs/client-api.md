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
- `/api/v1/auth/password-reset/request`
- `/api/v1/auth/password-reset/confirm`

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
- 往来对象及简称。
- 余额重算。

相关路径示例：

- `/api/v1/accounts`
- `/api/v1/accounts/balances`
- `/api/v1/accounts/investment`
- `/api/v1/account-group`

### Transactions

范围：

- 收入、支出、转账。
- 交易详情。
- 批量编辑。
- 删除和清理。

相关路径示例：

- `/api/v1/transactions`
- `/api/v1/transactions/detail`
- `/api/v1/entries/batch-edit`
- `/api/v1/entries/batch-update`
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
- `/api/v1/settings/fund-query-api`
- `/api/v1/settings/backup`
- `/api/v1/settings/system-update`

### Mobile Sync

范围：

- 移动端快速同步。
- 移动端概览、账户、交易、基金的聚合数据。

相关路径示例：

- `/api/v1/mobile/sync`

移动端聚合接口可以减少请求次数，但不应复制 Web 的业务计算逻辑。聚合数据应来自同一套服务模块或统一查询口径。

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
