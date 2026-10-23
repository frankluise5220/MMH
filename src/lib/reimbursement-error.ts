/** Maps server-side reimbursement error codes to i18n keys. */
const ERROR_KEY_BY_CODE: Record<string, string> = {
  REIMBURSEMENT_TITLE_REQUIRED: "reimburse.alert.titleRequired",
  REIMBURSEMENT_DOCUMENT_NUMBER_DUPLICATE: "reimburse.alert.documentNumberDuplicate",
  REIMBURSEMENT_OBJECT_REQUIRED: "reimburse.alert.objectRequired",
  REIMBURSEMENT_ITEMS_REQUIRED: "reimburse.alert.itemsRequired",
  REIMBURSEMENT_ITEM_INVALID: "reimburse.alert.itemInvalid",
  REIMBURSEMENT_ATTACHMENT_COUNT_INVALID: "reimburse.alert.attachmentCountInvalid",
  REIMBURSEMENT_NOT_FOUND: "reimburse.alert.notFound",
  REIMBURSEMENT_ALREADY_REIMBURSED: "reimburse.alert.alreadyReimbursed",
  REIMBURSEMENT_CASH_ACCOUNT_REQUIRED: "reimburse.alert.cashAccountRequired",
  REIMBURSEMENT_CASH_ACCOUNT_INVALID: "reimburse.alert.cashAccountInvalid",
  REIMBURSEMENT_DATE_INVALID: "reimburse.alert.dateInvalid",
  REIMBURSEMENT_ADVANCE_ACCOUNT_MISSING: "reimburse.alert.advanceAccountMissing",
  REIMBURSEMENT_BALANCE_INSUFFICIENT: "reimburse.alert.balanceInsufficient",
  REIMBURSEMENT_ITEM_NOT_FOUND: "reimburse.alert.itemNotFound",
  REIMBURSEMENT_ACTUAL_AMOUNT_INVALID: "reimburse.alert.actualAmountInvalid",
  REIMBURSEMENT_APPROVED_AMOUNT_INVALID: "reimburse.alert.approvedAmountInvalid",
  REIMBURSEMENT_APPROVED_AMOUNT_EXCEEDS_CLAIM: "reimburse.alert.approvedAmountExceedsClaim",
  REIMBURSEMENT_BATCH_INVALID: "reimburse.alert.batchInvalid",
  REIMBURSEMENT_BATCH_CHANGED_RETRY: "reimburse.alert.batchChangedRetry",
  REIMBURSEMENT_BATCH_ALREADY_PAID: "reimburse.alert.batchAlreadyPaid",
  REIMBURSEMENT_SETTLEMENT_NOT_FOUND: "reimburse.alert.settlementNotFound",
  REIMBURSEMENT_SETTLEMENT_LEGACY_UNEDITABLE: "reimburse.alert.settlementLegacyUneditable",
  REIMBURSEMENT_TRANSACTION_NOT_FOUND: "reimburse.alert.transactionNotFound",
  REIMBURSEMENT_INVOICE_AMOUNT_INVALID: "reimburse.alert.invoiceAmountInvalid",
  REIMBURSEMENT_NOT_PENDING: "reimburse.alert.notPending",
  REIMBURSEMENT_UNKNOWN: "reimburse.alert.unknown",
  REIMBURSEMENT_CREATE_FAILED: "reimburse.alert.createFailed",
  REIMBURSEMENT_REIMBURSE_FAILED: "reimburse.alert.reimburseFailed",
  REIMBURSEMENT_DELETE_FAILED: "reimburse.alert.deleteFailed",
};

export function reimbursementErrorMessage(code: string | undefined, t: (key: string) => string) {
  // 没带错误码时不要弹空对话框：给一句通用失败文案。
  if (!code) return t("reimburse.alert.unknown");
  const key = ERROR_KEY_BY_CODE[code];
  return key ? t(key) : code;
}
