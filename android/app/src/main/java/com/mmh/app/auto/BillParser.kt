package com.mmh.app.auto

/**
 * Extracts a bill (amount + direction + merchant / account hint) from the screen
 * text of a whitelisted payment app.
 *
 * Heuristic and conservative on purpose:
 *  - Requires a recognizable amount (e.g. "¥20.60", "20.60元").
 *  - Requires a reliable direction keyword, otherwise returns null so the
 *    accessibility service does not fabricate drafts from random screens.
 *  - Prefers an amount that sits right after a strong label (金额/实付/合计…)
 *    or the ¥ sign to avoid grabbing unrelated numbers on the page.
 */
object BillParser {

    /** App package -> display name used as a merchant fallback. */
    private val KNOWN_APPS = mapOf(
        "com.eg.android.AlipayGphone" to "支付宝",
        "com.tencent.mm" to "微信",
        "com.taobao.idlefish" to "闲鱼",
        "com.taobao.taobao" to "淘宝",
        "com.taobao.trip" to "飞猪",
        "com.sankuai.meituan" to "美团",
        "com.jingdong.app.mall" to "京东",
        "com.xingin.xhs" to "小红书",
        "com.sdu.didi.psnger" to "滴滴",
        "com.ss.android.ugc.aweme" to "抖音",
        "com.dianping.v1" to "大众点评"
    )

    private val AMOUNT_RE = Regex("(?:¥|￥|RMB)?\\s*([0-9]+[.,][0-9]{1,2})\\s*(?:元)?")
    private val STRONG_LABELS = Regex("(金额|实付|合计|实收|付款|支付|应还|消费|¥|￥)")

    private val EXPENSE_KEYWORDS = listOf("支出", "消费", "付款", "已支付", "支付成功", "扣款", "扣费", "实付", "购买")
    private val INCOME_KEYWORDS = listOf("收入", "收款", "到账", "入账", "退款", "退回", "收到")
    private val TRANSFER_KEYWORDS = listOf("转账")

    private val ACCOUNT_HINTS = listOf(
        "花呗", "余额宝", "余额", "零钱", "银行卡", "信用卡", "储蓄卡",
        "微信支付", "支付宝", "云闪付", "白条", "翼支付"
    )
    private val ACCOUNT_LABELS = listOf("支付方式", "付款方式", "付款账户", "支付账户", "账户", "银行卡")
    private val MERCHANT_LABELS = listOf("商家", "商户", "收款方", "收款人", "店铺", "门店", "收款方式", "收款账户")
    private val NOTE_LABELS = listOf("备注", "商品", "订单详情")

    /** Full-width digit/separator normalization for Chinese keyboard UIs. */
    private val FULLWIDTH = mapOf(
        '０' to '0', '１' to '1', '２' to '2', '３' to '3', '４' to '4',
        '５' to '5', '６' to '6', '７' to '7', '８' to '8', '９' to '9',
        '，' to ',', '．' to '.'
    )

    fun parse(screenText: String?, packageName: String?): CapturedBill? {
        if (screenText.isNullOrBlank()) return null
        val text = normalize(screenText)
        if (text.length > 4000) return null // bound the cost of screen capture

        val amount = extractAmount(text) ?: return null
        if (amount <= 0) return null
        val direction = extractDirection(text) ?: return null

        val merchant = extractMerchant(text) ?: KNOWN_APPS[packageName]
        val accountHint = extractAccountHint(text)
        val note = buildNote(text, merchant)

        return CapturedBill(
            amount = amount,
            direction = direction,
            merchant = merchant,
            accountHint = accountHint,
            note = note
        )
    }

    fun appDisplayName(packageName: String?): String? = KNOWN_APPS[packageName]

    private fun normalize(raw: String): String {
        val sb = StringBuilder(raw.length)
        for (c in raw) sb.append(FULLWIDTH[c] ?: c)
        return sb.toString().replace(Regex("\\s+"), " ")
    }

    private fun extractAmount(text: String): Double? {
        val matches = AMOUNT_RE.findAll(text).toList()
        if (matches.isEmpty()) return null
        val values = matches.map { it.groupValues[1].replace(",", "").toDoubleOrNull() }

        // Prefer the amount right after a strong label / ¥ sign.
        for (m in matches) {
            val start = (m.range.first - 12).coerceAtLeast(0)
            val ctx = text.substring(start, m.range.first)
            if (STRONG_LABELS.containsMatchIn(ctx)) {
                val v = values[matches.indexOf(m)]
                if (v != null && v > 0) return v
            }
        }
        return values.firstOrNull { it != null && it > 0 }
    }

    private fun extractDirection(text: String): BillDirection? {
        if (TRANSFER_KEYWORDS.any { text.contains(it) }) return BillDirection.TRANSFER
        val income = INCOME_KEYWORDS.any { text.contains(it) }
        val expense = EXPENSE_KEYWORDS.any { text.contains(it) }
        return when {
            income && expense -> BillDirection.INCOME
            income -> BillDirection.INCOME
            expense -> BillDirection.EXPENSE
            else -> null
        }
    }

    private fun extractMerchant(text: String): String? {
        for (label in MERCHANT_LABELS) {
            val idx = text.indexOf(label)
            if (idx >= 0) {
                val seg = text.substring(idx + label.length).take(40)
                val raw = seg.split(Regex("[ 　，,。]")).firstOrNull { it.isNotBlank() } ?: continue
                val value = raw.trimStart(':', '：', '·', '|', '—', '-', '＝', '=')
                if (value.length in 1..24) return value
            }
        }
        return null
    }

    private fun extractAccountHint(text: String): String? {
        for (label in ACCOUNT_LABELS) {
            val idx = text.indexOf(label)
            if (idx >= 0) {
                val seg = text.substring(idx + label.length).take(20)
                ACCOUNT_HINTS.firstOrNull { seg.contains(it) }?.let { return it }
            }
        }
        return ACCOUNT_HINTS.firstOrNull { text.contains(it) }
    }

    private fun buildNote(text: String, merchant: String?): String? {
        val merchantPart = merchant?.takeIf { it.isNotBlank() }
        var extra: String? = null
        for (label in NOTE_LABELS) {
            val idx = text.indexOf(label)
            if (idx >= 0) {
                val seg = text.substring(idx + label.length).take(60)
                val raw = seg.split(Regex("[ 　]")).firstOrNull { it.isNotBlank() } ?: continue
                val v = raw.trimStart(':', '：', '·', '|', '—', '-', '＝', '=')
                if (v.length in 1..40 && v != merchantPart) {
                    extra = v
                    break
                }
            }
        }
        return if (extra != null) listOfNotNull(merchantPart, extra).joinToString(" ") else merchantPart
    }
}
