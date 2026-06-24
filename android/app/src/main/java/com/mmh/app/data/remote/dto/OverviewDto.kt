package com.mmh.app.data.remote.dto

import kotlinx.serialization.Serializable

/**
 * Overview / Dashboard DTOs.
 * API: GET /api/v1... (overview data is composed from multiple endpoints)
 */

/** Net worth data point for chart */
@Serializable
data class NetWorthPointDto(
    val date: String = "",
    val totalAssets: Double = 0.0,
    val totalLiabilities: Double = 0.0,
    val netWorth: Double = 0.0
)

/** Category summary */
@Serializable
data class CategorySummaryDto(
    val categoryId: String? = null,
    val categoryName: String = "",
    val type: String = "expense",
    val amount: Double = 0.0,
    val percentage: Double = 0.0,
    val count: Int = 0
)

/** Monthly summary */
@Serializable
data class MonthlySummaryDto(
    val month: String = "",   // "YYYY-MM"
    val income: Double = 0.0,
    val expense: Double = 0.0,
    val net: Double = 0.0
)

/** Account overview summary */
@Serializable
data class AccountOverviewDto(
    val id: String = "",
    val name: String = "",
    val kind: String = "other",
    val balance: Double = 0.0,
    val currency: String = "CNY",
    val groupName: String? = null,
    val institutionName: String? = null
)

/** Overview data assembled from multiple API calls */
data class OverviewData(
    val totalAssets: Double = 0.0,
    val totalLiabilities: Double = 0.0,
    val netWorth: Double = 0.0,
    val accounts: List<AccountOverviewDto> = emptyList(),
    val recentTransactions: List<TransactionDto> = emptyList(),
    val monthlySummary: List<MonthlySummaryDto> = emptyList(),
    val categorySummary: List<CategorySummaryDto> = emptyList()
)

/** Category entity */
@Serializable
data class CategoryDto(
    val id: String = "",
    val name: String = "",
    val type: String = "expense",
    val parentId: String? = null,
    val sortOrder: Int? = null
)

/** Category list response */
@Serializable
data class CategoryListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val categories: List<CategoryDto>? = null
)

/** Tag entity */
@Serializable
data class TagDto(
    val id: String = "",
    val name: String = "",
    val color: String? = null
)

/** Tag list response */
@Serializable
data class TagListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val tags: List<TagDto> = emptyList()
)

/** Institution entity */
@Serializable
data class InstitutionCreateResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val institution: InstitutionDto? = null
)

/** Account group list response */
@Serializable
data class AccountGroupListResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val groups: List<AccountGroupDto>? = null
)

/** Auth verify request */
@Serializable
data class AuthVerifyRequest(
    val username: String,
    val password: String
)

/** Auth verify response */
@Serializable
data class AuthVerifyResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val username: String? = null,
    val systemVerified: Boolean? = null,
    val householdId: String? = null,
    val householdName: String? = null
)

/** Ping response */
@Serializable
data class PingResponse(
    val status: String = "",
    val timestamp: String = ""
)

// ── Overview summary (GET /api/v1/overview/summary) ──────────────────────────

/** 资产分布单项 */
@Serializable
data class AssetDistributionItemDto(
    val kind: String = "",
    val label: String = "",
    val value: Double = 0.0,
    val pct: Double = 0.0
)

/** 账户余额展示行（投资账户 balance 字段即 marketValue） */
@Serializable
data class AccountListRowDto(
    val id: String = "",
    val name: String = "",
    val kind: String = "other",
    val balance: Double = 0.0,
    val groupName: String? = null,
    val institutionName: String? = null
)

/** 投资持仓摘要行（Top N，按市值降序） */
@Serializable
data class TopPositionRowDto(
    val accountId: String = "",
    val fundCode: String = "",
    val name: String = "",
    val marketValue: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val floatingPnLRate: Double = 0.0
)

/** 总览汇总数据。与网页总览页同一计算源，金额一致。 */
@Serializable
data class OverviewSummaryDto(
    val netWorth: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val totalCost: Double = 0.0,
    val monthIncome: Double = 0.0,
    val monthExpense: Double = 0.0,
    val assetDistribution: List<AssetDistributionItemDto> = emptyList(),
    val accountList: List<AccountListRowDto> = emptyList(),
    val topPositions: List<TopPositionRowDto> = emptyList()
)

/** GET /api/v1/overview/summary 响应 */
@Serializable
data class OverviewSummaryResponse(
    val ok: Boolean = false,
    val error: String? = null,
    val data: OverviewSummaryDto? = null
)
