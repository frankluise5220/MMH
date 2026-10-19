/**
 * 「持仓型记账」通用类型：买入 / 赎回 / 分红 / 核销四种动作的表单数据。
 *
 * 中性层不出现具体品种词（理财、债券、基金…）；品种差异由调用方通过
 * 选项与回调注入。注意 `wealthProductId` / `wealthAccountId` 是既有数据
 * 契约（Entry 字段与接口返回），在此沿用字段名，不做领域改名。
 */

export type HoldingEntrySubtype = "buy" | "redeem" | "dividend_cash" | "write_off";

export type HoldingEntryEntry = {
  id?: string;
  /** 编辑事件明细里的原始 entryId（部分调用方只带这个字段）。 */
  entryId?: string;
  transactionId?: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  date: string;
  amount: number;
  note?: string | null;
  fundName?: string | null;
  wealthProductId?: string | null;
  fundProductType?: string | null;
  fundSubtype?: string | null;
  /** 品种特有的「来源单 id」（债券存单等）。 */
  sourceLotId?: string | null;
  fundUnits?: number | null;
  fundNav?: number | null;
  depositInterest?: number | null;
  fundArrivalAmount?: number | null;
  accountId?: string | null;
  toAccountId?: string | null;
  toAccountName?: string | null;
  fundArrivalDate?: string | null;
};

export type HoldingEntryAccountOption = {
  id: string;
  label: string;
  icon?: string;
  subLabel?: string;
  kind?: string;
  groupId?: string | null;
  investProductType?: string | null;
  institutionId?: string | null;
  institutionType?: string | null;
  currency?: string | null;
};

export type HoldingEntryProductOption = {
  id: string;
  name: string;
  shortName?: string | null;
  institutionId?: string | null;
  institutionName?: string | null;
  currency?: string | null;
  annualRate?: number | null;
  termDays?: number | null;
  productType?: string | null;
  maturityDate?: string | null;
  payoutFrequency?: string | null;
  interestCalcBasis?: string | null;
  firstPayoutDate?: string | null;
  note?: string | null;
};

export type HoldingEntryHoldingOption = {
  id: string;
  label: string;
  subLabel?: string;
  fundName: string;
  wealthProductId?: string | null;
  wealthAccountId: string;
  wealthAccountLabel?: string | null;
  remainingAmount: number;
  remainingUnits?: number | null;
  hasUnits?: boolean;
  annualRate?: number | null;
  termDays?: number | null;
  movements?: Array<{ date: string; delta: number }>;
  unitMovements?: Array<{ date: string; delta: number }>;
};

export type HoldingEntryRedeemSource = {
  id: string;
  label: string;
  fundName: string;
  wealthProductId?: string | null;
  wealthAccountId: string;
  wealthAccountLabel?: string | null;
  restoredPrincipalAmount: number;
  restoredRemainingAmount: number;
  restoredUnits: number | null;
  restoredRemainingUnits: number | null;
  hasUnits?: boolean;
  annualRate?: number | null;
  termDays?: number | null;
  movements?: Array<{ date: string; delta: number }>;
  unitMovements?: Array<{ date: string; delta: number }>;
};

export type HoldingEntryNestedFieldData = Record<string, Array<{ id: string; name: string; type?: string }>>;

/** 编辑事件 / 编辑回填共用的标准化明细。 */
export type HoldingEntryEditDetail = {
  requestId: string;
  entryId: string;
  cashEntryId?: string | null;
  businessTransactionId?: string | null;
  type: string;
  date: string;
  amount: number;
  note: string;
  accountId?: string;
  toAccountId?: string;
  fundName?: string;
  wealthProductId?: string | null;
  fundSubtype?: string;
  fundArrivalDate?: string | null;
  fundUnits?: number | null;
  fundNav?: number | null;
  depositInterest?: number | null;
  fundArrivalAmount?: number | null;
  fundProductType?: string;
  /** 品种特有的「来源单 id」（债券存单等），用于编辑时优先命中持仓。 */
  sourceLotId?: string | null;
  /** 回填时决定的动作，供品种回调判断。 */
  nextSubtype: HoldingEntrySubtype;
};
