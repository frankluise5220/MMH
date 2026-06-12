# Debug Session: fund-users-balance
- **Status**: [OPEN]
- **Issue**: 基金 API 页面没有显示；用户管理页面为空；借记卡余额与 sidebar 数字不同。
- **Debug Server**: http://192.168.2.199:7778/event
- **Log File**: `.dbg/trae-debug-log-fund-users-balance.ndjson`

## Reproduction Steps
1. 打开 `/settings/fund-api`，观察页面是否渲染、接口是否返回数据或错误。
2. 打开 `/settings/users`，观察接口返回的用户列表和当前账簿信息。
3. 对比 sidebar、`/assets`、相关账户详情中同一借记卡的显示余额。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | 基金 API 页面实际请求失败或返回异常，前端把错误吞掉了，所以表现为“没显示”。 | High | Low | Pending |
| B | 用户管理接口在当前登录用户 / household / cookie 组合下返回空数组，前端只是正常展示了空态。 | High | Low | Pending |
| C | 基金 API 和用户管理页面点击后实际路由是对的，但设置页或代理层存在运行时重定向 / 未授权跳转。 | Medium | Medium | Pending |
| D | 借记卡余额仍然有另一处页面或接口在用独立汇总口径，和 sidebar 的 `account.balance` 不是同一数据源。 | High | Low | Pending |
| E | 用户当前环境没有拿到最新构建或最新 bundle，导致代码已改但运行时仍是旧行为。 | Medium | Medium | Pending |

## Log Evidence
- Evidence (pre-fix):
  - `/api/v1/settings/users` returned `500` while proxy allowed the request (not a login redirect).
  - Sidebar rendered successfully, so the app is not blocked at routing-level.

## Verification Conclusion
- Pending
