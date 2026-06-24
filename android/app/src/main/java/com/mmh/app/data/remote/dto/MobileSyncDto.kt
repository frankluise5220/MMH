package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

@Serializable
data class MobileSyncResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val serverTime: String = "",
    val hasMore: Boolean = false,
    val accounts: List<MobileSyncAccountDto> = emptyList(),
    val categories: List<CategoryItemDto> = emptyList(),
    val transactions: List<TransactionDto> = emptyList(),
    val deletedTransactionIds: List<String> = emptyList(),
    val fundHoldings: List<MobileSyncFundHoldingDto> = emptyList(),
    val fundConfirmDays: List<MobileSyncFundConfirmDaysDto> = emptyList(),
    val fundFeeRates: List<MobileSyncFundFeeRateDto> = emptyList(),
    val fundNav: List<MobileSyncFundNavDto> = emptyList(),
    val regularInvestPlans: List<RegularInvestPlanDto> = emptyList()
)

@Serializable
data class MobileSyncAccountDto(
    val id: String = "",
    val name: String = "",
    val balance: Double = 0.0,
    val kind: String = "other",
    val currency: String = "CNY",
    val isActive: Boolean = true,
    val isPlaceholder: Boolean = false,
    val investProductType: String? = null,
    val creditLimit: Double? = null,
    val billingDay: Int? = null,
    val repaymentDay: Int? = null,
    val numberMasked: String? = null,
    val institutionId: String? = null,
    val institutionName: String? = null,
    val groupId: String = "",
    val groupName: String? = null,
    val costBasisMethod: String? = null,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundHoldingDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val fundName: String? = null,
    val units: Double = 0.0,
    val avgCost: Double = 0.0,
    val cost: Double = 0.0,
    val nav: Double? = null,
    val navDate: String? = null,
    val pendingCost: Double = 0.0,
    val historicalProfit: Double = 0.0,
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundConfirmDaysDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val days: Int = 0,
    val redeemCostDays: Int = 1,
    val arrivalDays: Int = 0,
    val effectiveDate: String = "",
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundFeeRateDto(
    val id: String = "",
    val accountId: String = "",
    val fundCode: String = "",
    val rate: Double = 0.0,
    val feeType: String = "buy",
    val effectiveDate: String = "",
    val updatedAt: String = ""
)

@Serializable
data class MobileSyncFundNavDto(
    val id: String = "",
    val fundCode: String = "",
    val navDate: String = "",
    val nav: Double = 0.0,
    val cumNav: Double? = null,
    val name: String? = null,
    val updatedAt: String = ""
)
