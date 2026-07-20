# 编辑与新增窗口检查清单

## 检查机制

### 一、编辑窗口检查项

#### 1. 数据一致性检查
- [ ] **打开窗口时显示的数据是否与数据库一致**
  - 检查方法：对比数据库中的实际值与窗口显示值
  - 重点关注：日期、金额、关联账户ID、基金代码、备注等
  - 注意：某些字段可能需要从关联表读取（如基金名称从FundEntry读取）

- [ ] **是否有遗漏字段**
  - 检查方法：对比数据库schema与编辑窗口显示的字段列表
  - 特别注意：新增字段是否已在编辑窗口中实现

#### 2. 保存写入检查
- [ ] **所有修改的数据是否成功写回数据库**
  - 检查方法：编辑后保存，然后查询数据库验证字段值
  - 重点关注：空值处理（清空字段是否正确写入null）
  - 注意：关联字段的处理（如linkId、linkType）

- [ ] **关联数据是否正确更新**
  - 检查方法：保存后检查关联表数据（如FundEntry、RegularInvestPlan）
  - 注意：双向关联的同步（TxRecord ↔ FundEntry）

#### 3. 打开入口检查
- [ ] 明细表中可编辑的记录应同时支持点击编辑按钮和双击整行打开编辑窗口
- [ ] 双击信用卡、保险、基金/理财/存款记录时，应进入与编辑按钮相同的专用编辑窗口并加载同一条记录
- [ ] 双击复选框、编辑、删除、获取净值等操作控件时，不应因行事件冒泡重复打开窗口
- [ ] 保存修改后，相关行、余额和汇总应刷新，但明细列表必须保留当前账户、页码、每页数量、筛选、排序和列设置；不得因为全局刷新或局部重拉数据而复位显示状态

### 二、新增窗口检查项

#### 1. 初始数据检查
- [ ] **是否正确获取关联数据库数据**
  - 资金账户列表：是否从数据库加载可选账户
  - 投资账户列表：是否正确筛选投资类型账户
  - 基金代码/名称：是否有自动获取机制
  - 默认值：是否设置合理的默认值（如今天的日期）

- [ ] **是否不应该全部用初始空白值**
  - 检查方法：哪些字段应该有默认值或下拉选项
  - 注意：某些字段如金额、基金代码应该为空（需要用户输入）

#### 2. 保存写入检查
- [ ] **所有数据是否全部写入成功**
  - 检查方法：保存后查询数据库验证所有字段
  - 重点关注：必填字段是否完整写入

- [ ] **关联数据是否写入成功**
  - 检查方法：检查关联表是否创建对应记录
  - 注意：linkId/linkType是否正确设置
  - 注意：双向关联是否建立（如FundEntry创建后TxRecord.linkId指向它）

### 三、字段特定检查

#### 基金名称字段
- [ ] 是否为只读状态（不可手动编辑）
- [ ] 是否根据基金代码自动获取
- [ ] 基金代码变化时是否触发自动获取（延迟800ms）
- [ ] 获取失败时是否有提示

#### 资金账户字段
- [ ] 编辑模式下是否正确显示已保存的资金账户
- [ ] 新增模式下是否有下拉选择列表
- [ ] 是否正确区分投资账户和资金账户
- [ ] 导入预览中的“信用卡还款”是否保持业务类型显示，把付款账户限制为借记卡/电子钱包、目标账户限制为信用卡，并在落库后显示为“类型：转账、分类：信用卡还款”
- [ ] 普通账单是否逐行识别账户；信用卡账单是否只维护一个统一信用卡账户，并同步应用到全部预览行
- [ ] 只有机构和账户类型、没有后四位时，是否仅在唯一启用账户的情况下自动匹配
- [ ] 理财买入是否只显示资金来源同机构或同一所有人名下第三方支付/钱包机构的理财账户；新增产品后缺失的同机构理财账户是否自动建立、立即回填并在重新打开时保持一致

#### 日期字段
- [ ] 编辑模式下是否显示已保存的日期（不被替换为当前日期）
- [ ] 新增模式下是否默认为当前日期
- [ ] 日期格式是否正确（YYYY-MM-DD）
- [ ] 基金、理财、保险、存款等赎回/退保/取出窗口是否同时回显和保存到账日期；业务日期、确认日期、到账日期、存款到期日不能互相覆盖

#### 金额字段
- [ ] 是否正确处理负数（买入为负，赎回为正）
- [ ] 普通转账编辑模式下金额是否显示正值；用户输入负值保存时，是否交换转出/转入账户方向后按正额落库
- [ ] 是否正确处理小数位数

#### 信用卡分期字段
- [ ] 信用卡支出新增窗口显示“消费分期”；已出账账单行显示“账单分期”，两个入口名称和来源不可混用
- [ ] 分期金额大于 0 且不超过原支出，允许部分金额分期
- [ ] 账单分期金额不超过该期未还金额，冲抵来源账单，首期从下一个账单月开始
- [ ] 期数限制为 2 至 120；费率明确区分年利率与每期手续费率
- [ ] 保存后原消费、冲抵行和各期明细使用同一个分期计划 ID
- [ ] 删除/恢复原消费或任一分期生成行时，冲抵和各期明细必须整体联动

#### 贷款资金形式
- [ ] `资金到账` 必须增加所选入账账户余额；`消费分期` 只建立贷款负债，不能增加还款账户余额
- [ ] 车贷、购车融资默认选择 `消费分期`，编辑后仍能正确回显该模式
- [ ] 两种形式复用同一套利率、期数、还款计划和提前还款计算

### 四、表结构映射检查

#### TxRecord 表字段（基础交易）
**存在的字段**：
- `type`, `date`, `postedAt`, `accountId`, `accountName`, `amount`
- `toAccountId`, `toAccountName`
- `categoryId`, `categoryName`
- `fundCode`, `fundProductType`, `note`
- 贵金属交易额外字段：`metalTypeId`, `metalTypeName`, `metalUnitId`, `metalUnitName`, `metalQuantity`, `metalUnitPrice`, `metalFee`
- `linkId`, `linkType`
- `statementMonth`, `deletedAt`

**不存在的字段（易错）**：
- ❌ `fundSubtype`（属于 FundEntry）
- ❌ `fundUnits`（属于 FundEntry）
- ❌ `fundNav`（属于 FundEntry）
- ❌ `fundFee`（属于 FundEntry）
- ❌ `fundConfirmDate`（属于 FundEntry）
- ❌ `fundCashAccountId`（属于 FundEntry）

#### FundEntry 表字段（基金明细）
**存在的字段**：
- `accountId`, `accountName`
- `fundCode`, `fundName`, `fundSubtype`, `fundProductType`
- `amount`, `fundUnits`, `fundNav`, `fundFee`
- `fundConfirmDate`, `fundCashAccountId`
- `linkId`（指向 TxRecord）
- `memo`

#### 投资交易账户结构
- `TxRecord.accountId` = 资金来源账户（现金账户）
- `TxRecord.toAccountId` = 基金账户（投资账户）
- `amount` 为负数 = 买入（资金从左流向右）
- `amount` 为正数 = 赎回（资金从右流向左）

### 五、自动测试脚本模板

```typescript
// 测试编辑窗口数据一致性
async function testEditWindowDataConsistency(entryId: string) {
  // 1. 从数据库读取原始数据
  const dbData = await prisma.txRecord.findUnique({ where: { id: entryId } });

  // 2. 打开编辑窗口，获取显示数据
  // （需要模拟或手动操作）

  // 3. 对比字段值
  const fieldsToCheck = ['date', 'postedAt', 'amount', 'accountId', 'toAccountId', 'fundCode', 'note'];
  for (const field of fieldsToCheck) {
    if (dbData[field] !== displayData[field]) {
      console.error(`字段 ${field} 不一致: DB=${dbData[field]}, Display=${displayData[field]}`);
    }
  }

  console.log('✅ 数据一致性检查完成');
}

// 测试保存写入
async function testEditSave(entryId: string, updates: object) {
  // 1. 执行编辑保存
  await updateTransactionFromDialog(formData);

  // 2. 从数据库读取更新后的数据
  const updatedData = await prisma.txRecord.findUnique({ where: { id: entryId } });

  // 3. 验证每个字段是否正确更新
  for (const [key, value] of Object.entries(updates)) {
    if (updatedData[key] !== value) {
      console.error(`字段 ${key} 未正确更新: Expected=${value}, Actual=${updatedData[key]}`);
    }
  }

  console.log('✅ 保存写入检查完成');
}
```

## 已发现并修复的问题

### 问题1：基础交易编辑窗口资金账户显示为空
- **原因**：editPayload 使用了 TxRecord 不存在的字段 `fundCashAccountId`，且 accountId/toAccountId 混淆
- **修复**：正确映射 accountId = 资金账户，toAccountId = 投资账户
- **位置**：[page.tsx:2371-2382](src/app/(sidebar)/page.tsx#L2371-L2382), [page.tsx:2984-2996](src/app/(sidebar)/page.tsx#L2984-L2996)

### 问题2：基金名称字段可编辑
- **原因**：未实现自动获取机制
- **修复**：改为只读状态，添加自动获取逻辑
- **位置**：CreateTransactionButton.tsx, EditInvestmentButton.tsx, regular-invest/page.tsx

### 问题3：TxRecord 更新使用了不存在的字段
- **原因**：updateTransactionFromDialog 中使用了 FundEntry 专用字段
- **修复**：移除 fundSubtype, fundCashAccountId 等字段，只更新 TxRecord 字段
- **位置**：[page.tsx:1074-1142](src/app/(sidebar)/page.tsx#L1074-L1142)

### 问题4：定投计划窗口基金名称可编辑
- **原因**：与问题2相同
- **修复**：改为只读状态，添加自动获取逻辑
- **位置**：regular-invest/page.tsx

## 检查执行建议

信用卡账户新增/编辑还应检查：选择机构后是否正确带出已有卡的账单日、还款日、额度和账单模式；保存账单日、还款日或账单模式后，同机构信用卡是否同步；额度是否只应用于当前新增/编辑卡而没有覆盖其他卡。

1. **每次修改编辑/新增窗口后**，运行上述检查清单
2. **每次修改数据库schema后**，更新字段映射检查表
3. **定期运行自动测试脚本**验证关键功能
4. **使用 Prisma Studio** 手动抽查数据一致性
5. **记录所有发现的问题**在本文档中，便于追踪

## 相关文档
- [DESIGN.md](../DESIGN.md) - 数据模型设计
- [docs/check-investment-data.md](./check-investment-data.md) - 投资数据检查
