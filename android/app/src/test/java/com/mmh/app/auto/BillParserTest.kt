package com.mmh.app.auto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Unit tests for the bill parser against realistic payment-result screen text. */
class BillParserTest {

    @Test
    fun parsesExpenseBillDetail_likeTheScreenshot() {
        val text = "-20.60 等待确认收货 支付时间 2026-10-08 16:19:30 付款方式 花呗 支出 " +
            "备注:肯德基肯律轻食烤鸡腿肉黑椒牛肉烤蔬焖饭能量碗能量三明治代下单"
        val bill = BillParser.parse(text, "com.taobao.idlefish")

        assertNotNull(bill)
        assertEquals(20.60, bill!!.amount, 0.001)
        assertEquals(BillDirection.EXPENSE, bill.direction)
        assertEquals("花呗", bill.accountHint)
        assertTrue(bill.note!!.contains("肯德基"))
    }

    @Test
    fun parsesAlipayPaymentSuccess() {
        val text = "付款成功 ¥20.60 商户:瑞幸咖啡 余额"
        val bill = BillParser.parse(text, "com.eg.android.AlipayGphone")

        assertNotNull(bill)
        assertEquals(20.60, bill!!.amount, 0.001)
        assertEquals(BillDirection.EXPENSE, bill.direction)
        assertEquals("瑞幸咖啡", bill.merchant)
    }

    @Test
    fun parsesIncome() {
        val text = "收款到账 ¥500.00 微信零钱"
        val bill = BillParser.parse(text, "com.tencent.mm")

        assertNotNull(bill)
        assertEquals(500.00, bill!!.amount, 0.001)
        assertEquals(BillDirection.INCOME, bill.direction)
    }

    @Test
    fun parsesRefundAsIncome() {
        val text = "退款 ¥35.00 原路退回"
        val bill = BillParser.parse(text, "com.taobao.taobao")

        assertNotNull(bill)
        assertEquals(35.00, bill!!.amount, 0.001)
        assertEquals(BillDirection.INCOME, bill.direction)
    }

    @Test
    fun rejectsScreenWithoutDirection() {
        val text = "首页 12.50 分类 消息 我的"
        assertNull(BillParser.parse(text, "com.eg.android.AlipayGphone"))
    }

    @Test
    fun rejectsBlankText() {
        assertNull(BillParser.parse(null, "com.tencent.mm"))
        assertNull(BillParser.parse("", "com.tencent.mm"))
    }
}
