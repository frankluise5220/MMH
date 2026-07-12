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
- [ ] 导入预览中的“信用卡还款”是否保持业务类型显示，并把付款账户限制为借记卡/电子钱包、目标账户限制为信用卡
- [ ] 普通账单是否逐行识别账户；信用卡账单是否只维护一个统一信用卡账户，并同步应用到全部预览行
- [ ] 只有机构和账户类型、没有后四位时，是否仅在唯一启用账户的情况下自动匹配

#### 日期字段
- [ ] 编辑模式下是否显示已保存的日期（不被替换为当前日期）
- [ ] 新增模式下是否默认为当前日期
- [ ] 日期格式是否正确（YYYY-MM-DD）

#### 金额字段
- [ ] 是否正确处理负数（买入为负，赎回为正）
- [ ] 编辑模式下是否显示绝对值
- [ ] 是否正确处理小数位数

#### 信用卡分期字段
- [ ] 仅信用卡支出新增时显示分期开关
- [ ] 分期金额大于 0 且不超过原支出，允许部分金额分期
- [ ] 期数限制为 2 至 120；费率明确区分年利率与每期手续费率
- [ ] 保存后原消费、冲抵行和各期明细使用同一个分期计划 ID
- [ ] 删除/恢复原消费时，冲抵和各期明细必须整体联动

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

1. **每次修改编辑/新增窗口后**，运行上述检查清单
2. **每次修改数据库schema后**，更新字段映射检查表
3. **定期运行自动测试脚本**验证关键功能
4. **使用 Prisma Studio** 手动抽查数据一致性
5. **记录所有发现的问题**在本文档中，便于追踪

## 相关文档
- [DESIGN.md](../DESIGN.md) - 数据模型设计
- [docs/check-investment-data.md](./check-investment-data.md) - 投资数据检查
