function toNumberOrNull(value: unknown) {
  const num = typeof value === "number" ? value : Number(value);
  return Number.isFinite(num) ? num : null;
}

export function formatLoanRecalculateSuccessMessage(data: unknown) {
  const result = data && typeof data === "object" ? data as Record<string, unknown> : {};
  const status = String(result.status ?? "");

  if (status === "historical_recalculated") {
    const startDate = String(result.startDate ?? "");
    const endDate = String(result.endDate ?? "");
    const regeneratedCount = toNumberOrNull(result.regeneratedCount);
    const lockedCount = toNumberOrNull(result.lockedCount);
    return [
      "重算成功。",
      startDate && endDate ? `已重建 ${startDate} 至 ${endDate} 的自动还款记录。` : "",
      regeneratedCount != null ? `自动记录：${regeneratedCount} 条。` : "",
      lockedCount && lockedCount > 0 ? `保留手工还款：${lockedCount} 条。` : "",
    ].filter(Boolean).join("\n");
  }

  if (status === "completed") {
    return "重算成功。\n贷款还款计划已标记为结清。";
  }

  if (status === "active") {
    const nextAmount = toNumberOrNull(result.nextAmount);
    const remainingRuns = toNumberOrNull(result.remainingRuns);
    return [
      "重算成功。",
      nextAmount != null ? `下期计划金额：${nextAmount.toFixed(2)}。` : "",
      remainingRuns != null ? `剩余期数：${remainingRuns}。` : "",
    ].filter(Boolean).join("\n");
  }

  return "重算成功。";
}
