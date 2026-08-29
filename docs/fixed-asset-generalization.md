# 固定资产泛化设计（Fixed Asset Generalization）

> 状态：0.1.44 已部分落地。当前版本已加入用户可见的固定资产账户类型、资产类型枚举、`assetType` / `attributes` 字段、固定资产编辑弹窗和交易明细联动；表名物理重命名、完整估值历史曲线和更细的类型专属字段仍按本文方向继续推进。
> 本文英文段落为权威来源，中文段落为镜像说明。

## 1. 目标（Goal）

把固定资产从「房产专用」泛化为「多类型固定资产」，同时保持现有数据与计算口径不变。

- 用户心智：一个「固定资产账户」代表一类固定资产（房产、车辆、设备、家具、收藏品、其他），账户下挂多个具体资产记录。
- 每个固定资产都有「估值」和「估值日期」，估值历史存表，用于以后计算市值变化曲线。
- 不新增每类一张表：把现有 `PropertyAsset` / `PropertyValuation` / `PropertyTransaction` 泛化为通用固定资产表，用 `assetType` 字段区分类型。
- 贵金属（黄金/白银/铂金/钯金）**不属于**固定资产，继续走现有 `investProductType = "metal"` 投资类型，不重复建。

## 2. 固定资产类型（Fixed Asset Types）

| assetType | 中文 | 说明 |
|-----------|------|------|
| `property` | 房产 | 住宅、商铺、车位、写字楼 |
| `vehicle` | 车辆 | 汽车、摩托车、电动车 |
| `equipment` | 设备 | 电脑、手机、家电、生产设备 |
| `furniture` | 家具 | 家具、家电大件 |
| `collectible` | 收藏品 | 艺术品、古董、珠宝、手表、字画 |
| `other` | 其他 | 兜底 |

- 贵金属**排除**在外，走 `metal` 投资类型。
- 类型是枚举，不是自由文本；新增类型需同步 i18n 三目录（`zh-CN` / `en-US` / `ja-JP`）。

## 3. 账户与资产关系（Account ↔ Asset）

- 一个固定资产账户 = 一类固定资产（`Account.kind = investment` + `investProductType = property`，用户可见类型为 `fixed_asset`）。
- 一个账户下挂多个 `FixedAsset` 记录（1:N）。
- 账户名是「类型名」（如「房产」「设备」），资产名是「具体资产名」（如「月亮园朗月苑」「MacBook Pro」）。
- 账户名与资产名**不再强制同步**（之前 1:1 时代的同步逻辑需要回退/调整）：账户是类型，资产是具体项，二者语义不同。

> 注意：上一轮为 1:1 模型加的「房产改名同步账户名」逻辑（`properties/route.ts` 的 POST purchase / PUT 中 `tx.account.update({ data: { name } })`）在 1:N 模型下不再成立，实施泛化时必须移除或改为「账户名由用户单独维护」。

## 4. 表结构（Schema）

### 4.1 泛化映射

| 现有表 | 泛化后 | 说明 |
|--------|--------|------|
| `PropertyAsset` | `FixedAsset` | 加 `assetType` 字段，`propertyType` 语义并入 `assetType` |
| `PropertyValuation` | `FixedAssetValuation` | 估值历史，`propertyAssetId` → `fixedAssetId` |
| `PropertyTransaction` | `FixedAssetTransaction` | 交易明细，`propertyAssetId` → `fixedAssetId` |

> 表名是否物理重命名由实施时决定；若保留旧表名，则用注释/别名明确其已泛化，避免后续误读为「房产专用」。

### 4.2 `FixedAsset` 字段

通用字段（所有类型都有，参与计算或列表展示）：

- `id`、`householdId`、`accountId`（关联固定资产账户）
- `assetType`（枚举，见第 2 节）
- `name`（资产名）
- `currency`
- `purchaseDate`（购入日期）
- `purchasePrice`（购入价格）
- `cost`（成本/账面价值）
- `marketValue`（最新市值）
- `latestValuationDate`（最新估值日期）
- `status`（`active` / `sold`）
- `note`
- `attributes`（JSON 扩展列，存类型专属字段，见下表）
- `deletedAt`、`createdAt`、`updatedAt`

类型专属字段（只存 `attributes` JSON，不建新表、不参与计算）：

| assetType | 专属字段（`attributes` 内） |
|-----------|---------------------------|
| `property` | 地址、面积、房产类型（住宅/商铺/车位/写字楼） |
| `vehicle` | 车牌号、车架号、品牌型号、里程 |
| `equipment` | 品牌、型号、序列号、存放位置 |
| `furniture` | 品牌、型号、位置 |
| `collectible` | 类别、作者/年代、来源 |
| `other` | 自由键值 |

> 专属字段只是展示用，不参与成本/市值/估值计算。新增类型专属字段时只改 `attributes` 的读写与表单，不改表结构。

### 4.3 `FixedAssetValuation` 字段（估值历史，市值曲线数据源）

- `id`、`householdId`、`fixedAssetId`
- `valuationDate`（估值日期，**必填**）
- `marketValue`（估值市值，**必填**）
- `source`（`purchase` / `manual` / `sale`）
- `note`
- `createdAt`、`updatedAt`

市值变化曲线 = 按 `fixedAssetId` 过滤、按 `valuationDate` 升序排序的 `FixedAssetValuation` 记录。

## 5. 估值规则（Valuation Rules）

- 每个固定资产**必须**有估值和估值日期；估值历史存 `FixedAssetValuation`，用于市值曲线。
- 最新估值冗余在 `FixedAsset.marketValue` + `latestValuationDate`，用于列表快速显示和浮动盈亏计算。
- 估值历史是曲线数据源，最新估值是冗余快照，二者必须一致（写入估值时同时更新快照）。
- 购入时自动生成一条 `source = "purchase"` 的初始估值（`valuationDate = purchaseDate`，`marketValue = 初始市值`）。
- 出售时生成一条 `source = "sale"` 的估值（`marketValue = 净回收金额`）。
- 手动估值生成 `source = "manual"` 记录。
- 市值曲线不自动用成本覆盖；只有无手动估值时才回退到成本。

## 6. 交易规则（Transaction Rules）

- 固定资产购入/装修/出售是普通现金收支记录（`TxRecord`），通过 `EntryBusinessLink` 同步到 `FixedAssetTransaction` 投影。
- 购入和装修投入用普通支出窗口记录，允许从不同资金账户分别建立多笔支出。
- 支出窗口强制关联选中的固定资产账户和具体资产。
- 出售以净回收金额减累计成本计算已实现收益。
- 交易明细下方用 `AdvancedDataTable` 展示，双击交易明细打开普通收支编辑窗口（可编辑、可加附件），不再单独做一张表。

## 7. UI/UX 规则

- 固定资产页面用「固定资产」作为上位概念，房产/车辆/设备等只是其中一种类型。
- 持仓列表不提供「购入房产」按钮；点击某项固定资产后在下方显示该资产关联的交易明细。
- 持仓列表按 `assetType` 展示不同类型专属列：房产显示地址/面积/房产类型，车辆显示车牌/品牌型号/里程，设备显示品牌/型号/位置等；通用列（名称、成本、市值、估值日期、浮动盈亏）所有类型一致。
- 下方交易明细对所有类型**完全一致**：都是普通收支交易（`FixedAssetTransaction`），用同一套 `AdvancedDataTable` 展示，双击打开普通收支编辑窗口（可编辑、可加附件），不因资产类型不同而换表或换编辑窗口。
- 双击固定资产持仓打开的是「资产信息编辑」（名称、类型、地址、购入日期、购入价格、估值、备注），不是交易编辑。
- 账户类型下拉新增「固定资产」（`fixed_asset`），底层仍存 `investment` + `property`（兼容实现细节）。
- 固定资产账户无机构（`institutionId` 为空）。

## 8. API 契约

- 现有 `/api/v1/properties` 泛化为固定资产接口；路径是否改名由实施时决定，但请求/响应字段语义必须覆盖 `assetType`。
- 成功返回 `{ ok: true, data }`，失败返回 `{ ok: false, code, error }`，`code` 为稳定英文枚举。
- 删除/更新接口在 ID 匹配不到记录时必须返回 `{ ok: false, error }`，不得静默成功。

## 9. i18n 要求

- 所有用户可见文案走 i18n 层，键命名 `fixedAsset.*` 命名空间。
- 每个新键必须同时加入 `zh-CN` / `en-US` / `ja-JP` 三目录。
- 6 个 `assetType` 的标签必须来自目录，不得内联字面量。

## 10. 迁移步骤（Migration Steps）

1. 泛化 `PropertyAsset` → `FixedAsset`，加 `assetType`，迁移现有房产数据 `assetType = "property"`。
2. 泛化 `PropertyValuation` / `PropertyTransaction` 的外键与命名。
3. 移除 1:1 时代的「房产改名同步账户名」逻辑。
4. 账户类型下拉、固定资产视图、编辑弹窗、交易明细接入 `assetType`。
5. 估值历史与市值曲线按 `FixedAssetValuation` 实现。
6. 更新 i18n 三目录、`docs/development-docs.md` 文档地图、`docs/product-memory.md` 相关规则。

## 11. 已确认的边界（Boundaries）

- 贵金属不属于固定资产，走 `metal` 投资类型。
- 固定资产账户是「类型」，资产是「具体项」，1:N。
- 每个固定资产都有估值 + 估值日期，估值历史存表，用于市值曲线。
- 不新增每类一张表，用一张通用 `FixedAsset` 表 + `assetType` 区分。
