<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
这是一个家用记帐软件项目，总体方向是数据的联动更新、智能化填充数据，尽量少地让用户操作、填写信息。细腻地显示机构真实的数据，包括统计数据，资金数据。
力求显示界面的统一性，避免多处计算导致的显示金额不一致。
第一层库数据
第二层显示表用数据从库数据直接获取，需要计算的直接从数据库计算后显示。可考虑使用缓存，避免重复读取导致的系统的速度下降。
第三层编辑表数据从数据库直接获取，需要计算的从数据库计算后显示于编辑（新增）界面。
编辑窗口关闭时判断是否保存（确认），如果是直接关闭，则抛弃所有编辑层数据，如果有保存（确认），则将修改后的数据写回库，并对相关数据进行刷新。
写回时力求所有数据的完整性，即使表字段不是强制填，也需要考虑写回，避免数据丢失。
避免重复计算，避免无意义的刷新浪费资源，避免多层数据。
新增、编辑窗口使用统一静音，通过传递参数来区别新增和编辑。初始界面显示的数值需要尽量智能化提供默认值，避免用户手动填写。

API 设计规则：
- 删除 / 修改类 API 必须返回 { ok: false, error } 当传入的 ID 没有匹配到任何记录时，不能静默 success
- 如果一个 API 接受多种实体类型的 ID（如 FundEntry.id 和 TxRecord.id），必须在文件头部用 JSDoc 写清楚
- API 文档即契约：所有 client 调用必须遵守 API 头部 JSDoc 定义的参数格式

## 统一库模块使用规范

项目中有三个统一库模块，用于查询和更新基础配置数据。**所有API必须使用这些统一模块，禁止直接操作数据库表**：

### 1. 确认天数库 (FundConfirmDays)
- 模块位置：`src/lib/fund/confirmDays.ts`
- 功能：查询/更新基金确认天数（T+N）
- 必须使用的API：
  - `getFundConfirmDays(accountId, fundCode)` - 查询确认天数（默认T+0）
  - `setFundConfirmDays(accountId, fundCode, days)` - 更新确认天数（可传0）
  - `setFundConfirmDaysInTx(tx, accountId, fundCode, days)` - 事务内更新

### 2. 手续费率库 (FundFeeRate)
- 模块位置：`src/lib/fund/feeRate.ts`
- 功能：查询/更新基金手续费率
- 必须使用的API：
  - `getFundFeeRate(accountId, fundCode)` - 查询费率（默认0，免手续费）
  - `setFundFeeRate(accountId, fundCode, rate)` - 更新费率（可传0）
  - `setFundFeeRateInTx(tx, accountId, fundCode, rate)` - 事务内更新

### 3. 净值缓存库 (FundNavCache)
- 模块位置：`src/lib/fund/navCache.ts`
- 功能：查询/更新基金净值数据
- 必须使用的API：
  - `getFundNav(fundCode, navDate)` - 查询指定日期净值
  - `setFundNav(fundCode, navDate, nav, cumNav?, name?)` - 更新净值
  - `setFundNavInTx(tx, fundCode, navDate, nav, cumNav?, name?)` - 事务内更新
  - `getLatestFundNav(fundCode)` - 查询最新净值

**使用场景**：
- 定投计划创建/编辑时，必须同步更新确认天数库和费率库
- 基金明细生成时，必须从确认天数库和费率库查询配置
- 净值查询/补填时，必须使用净值缓存库模块

**禁止行为**：
- 禁止直接 `prisma.fundConfirmDays.findUnique/upsert`
- 禁止直接 `prisma.fundFeeRate.findUnique/upsert`
- 禁止直接 `prisma.fundNavCache.findUnique/upsert`
- 必须导入并使用统一模块函数

检查点：
所有编辑窗口打开后显示的字段的数据，是否与数据库数据一致，是否有遗漏。
编辑保存后，与数据库内不同的数据，成功是否写回数据库
新增窗口
是否取得关联数库数据，比如资金账户、人员等，不应该全部用初始空白值
新增保存（确认）后，所有数据是否全部写入成功。
关联数据是否写入成功。
优化设计检查机制
注意这些情况：
1. 时区问题，中国的大模型看 北京时间 ，美国的大模型看 美国时间 ... 
2. Error code 到底是 int 类型还是 str 类型， 傻傻分不清. 
3. 软删除 是真的删除还是 标志为 'is_deleted' = true . 
4. 状态码 ( 500 , 400 ... ) 分散在全项目各处都是 ... 
5. 数据库慢查询设置 ， N+1 问题 未考虑 ... 
6. 短信验证码 、 实名认证的防暴力破解 未考虑 ... 
7. 状态机 待会儿 8个状态 ，隔一天就10个状态，再隔一天 7个状态 ... 
8. 同一个业务含义的变量，分不同函数名 或者 不同 变量名来写。 
9. 写了而又不用的函数名。 
10. 不用 ORM ，而是裸用 SQL ，带来 主键 自增长问题 。 
11. 数据库设计了 JsonB ，导致 数据查询 和 数据检索的 困难问题。 
12. 高危严重的水平越权漏洞 和 垂直越权漏洞 泛滥 ...
13. catch 后没有 Exception ，吞异常。
14. 写了而又不用的变量 、 函数 、 类。引入了不用的三方组件。
15. 引入 3-4套不同的日志系统。
16. 同样含义的常量，遍布整个项目各处，并且不统一.
17.  存在很多冗余而又没用（ 失效 ）的测试代码 ，有一些测试代码做好了删库跑路的准备（ 譬如 用于还原db状态）.
18. 输入参数 和 输出参数 不稳定 ，譬如有时候用 mobile 表示手机号 ，有时候用 phone 。
19. 输出 json层级混乱（有时候两层 ，有时候三层）。
20. 集成了过时而废弃，且缺乏文档的三方库。
21. 编写重复（近似）的功能和模块， 两个 endpoint 其实功能一样的，重复写，存在冗余。
22. redis 的 key 风格混乱 ；
23. 重复实现的工具格式化函数 （ 如格式化字符串 、格式化函数 ），分散在各个 文件里。
24. 分页封装的问题，有些地方有 pagenum  + page_size ，有些地方用 offset + limit 。
25.  有的地方用 原生 SQL ， 有的地方用ORM 。有的列表查询没有 limit 。
26.  经常使用 like %keyword% 来做检查 ，而没有索引。
27.  竞态条件问题 ，在高并发下会存在不可预测的风险。
28. 使用可以预测的随机数。
29. 遗留在代码里的硬编码后门。
30. 可以被暴力破解的接口和服务。
31.  支付 0元购 。
32. 使用plan模式，大模型在业务上想多了，明明产品经理只需要1个API就搞定的，额外实现冗余的不同场景的 3-4个API （复杂化），没有减枝。
33. 实际使用的阿里云SLS日志无规范无规划，想到哪里就记录到哪。
34. 大模型改到一半把自己改崩了（运行不起来），自己 通过 git pull 拉取项目又继续一顿烧token ...
35. 对于重构的代码，通常只改了一半（遗留一部分），然后谎报 ‘我都做完了’，信誓旦旦来邀功。实际一检查还差很多没搞定（ 带来了系统风格的混乱）。
36. 对于重构的代码，有时候贪图省事直接另写 python






<!-- END:nextjs-agent-rules -->



