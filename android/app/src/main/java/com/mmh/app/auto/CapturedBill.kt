package com.mmh.app.auto

/**
 * A payment bill captured from a whitelisted payment app's screen text.
 *
 * The parser is deliberately conservative: it only emits a [CapturedBill] when
 * both the amount and the direction can be determined reliably, so that the
 * auto-bookkeeping feature does not create false entries. The captured data
 * never leaves the device until the user explicitly confirms it in the app.
 */
enum class BillDirection(val transactionType: String) {
    EXPENSE("expense"),
    INCOME("income"),
    TRANSFER("transfer")
}

data class CapturedBill(
    val amount: Double,
    val direction: BillDirection,
    val merchant: String? = null,
    val accountHint: String? = null,
    val note: String? = null,
    val capturedAt: Long = System.currentTimeMillis()
)
