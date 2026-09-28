/** Maps server-side reimbursement error codes to i18n keys. */
const ERROR_KEY_BY_CODE: Record<string, string> = {
  REIMBURSEMENT_TITLE_REQUIRED: "reimburse.alert.titleRequired",
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
  REIMBURSEMENT_INVOICE_AMOUNT_INVALID: "reimburse.alert.invoiceAmountInvalid",
  REIMBURSEMENT_NOT_PENDING: "reimburse.alert.notPending",
  REIMBURSEMENT_UNKNOWN: "reimburse.alert.unknown",
  REIMBURSEMENT_CREATE_FAILED: "reimburse.alert.createFailed",
  REIMBURSEMENT_REIMBURSE_FAILED: "reimburse.alert.reimburseFailed",
  REIMBURSEMENT_DELETE_FAILED: "reimburse.alert.deleteFailed",
};

export function reimbursementErrorMessage(code: string, t: (key: string) => string) {
  const key = ERROR_KEY_BY_CODE[code];
  return key ? t(key) : code;
}
