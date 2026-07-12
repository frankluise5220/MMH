package com.mmh.app.ui.overview

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.AccountTypeTotalsDto
import com.mmh.app.data.remote.dto.AccountListRowDto
import com.mmh.app.data.remote.dto.TopPositionRowDto
import com.mmh.app.ui.theme.pnlColor
import com.mmh.app.ui.util.formatAccountDisplayName
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatPnl
import com.mmh.app.ui.util.formatRate
import kotlin.math.abs

/**
 * 总览 / 资产首页。
 *
 * 移动端只保留高频摘要：总资产、月收支、日常资金、信用卡、投资账户和资金账户。
 * 详细统计与更多筛选交给 Web 工作台。
 */
@Composable
fun OverviewScreen(
    onNavigateToSettings: () -> Unit,
    onNavigateToAccounts: () -> Unit,
    onNavigateToFunds: () -> Unit,
    onNavigateToAddTransaction: () -> Unit = {},
    onNavigateToFundDetail: (String, String) -> Unit = { _, _ -> },
    onNavigateToAccountDetail: (String, String) -> Unit = { _, _ -> },
    viewModel: OverviewViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    var showAmounts by remember { mutableStateOf(true) }

    LaunchedEffect(Unit) { viewModel.loadOverview() }

    Box(modifier = Modifier.fillMaxSize()) {
        if (uiState.isLoading && uiState.netWorth == 0.0) {
            // 骨架加载态
            SkeletonLoading()
        } else {
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 14.dp, end = 14.dp, top = 8.dp, bottom = 92.dp),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                item {
                    AssetHeaderCard(
                        netWorth = uiState.netWorth,
                        dailyNetWorth = uiState.dailyNetWorth,
                        investmentMarketValue = uiState.investmentMarketValue,
                        liabilities = uiState.accountTypeTotals.liabilities,
                        showAmounts = showAmounts,
                        onToggleShow = { showAmounts = !showAmounts }
                    )
                }

                item {
                    MonthFlowStrip(
                        income = uiState.monthIncome,
                        expense = uiState.monthExpense,
                        showAmounts = showAmounts
                    )
                }

                item {
                    DailySummaryCard(
                        totals = uiState.accountTypeTotals,
                        showAmounts = showAmounts
                    )
                }

                if (uiState.creditAccountList.isNotEmpty()) {
                    item {
                        CreditSummaryCard(
                            used = uiState.creditUsedTotal,
                            available = uiState.creditAvailableTotal,
                            currentBill = uiState.creditCurrentBillTotal,
                            showAmounts = showAmounts
                        )
                    }
                }

                if (uiState.investmentAccountList.isNotEmpty()) {
                    item { SectionHeader("投资账户") }
                    items(uiState.investmentAccountList, key = { it.accountId.ifBlank { it.name } }) { pos ->
                        PositionCard(
                            pos = pos,
                            showAmounts = showAmounts,
                            onClick = {
                                if (pos.accountId.isNotBlank() && pos.fundCode.isNotBlank()) {
                                    onNavigateToFundDetail(pos.accountId, pos.fundCode)
                                }
                            }
                        )
                    }
                }

                if (uiState.dailyAccountList.isNotEmpty()) {
                    item { SectionHeader("资金账户") }
                    items(uiState.dailyAccountList, key = { it.id }) { acc ->
                        val displayName = acc.displayName()
                        AccountCard(acc, showAmounts) { onNavigateToAccountDetail(acc.id, displayName) }
                    }
                }

                uiState.error?.let { msg ->
                    item { ErrorBanner(msg) { viewModel.retry() } }
                }
            }
        }

        // 右上角菜单
        Row(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 4.dp, end = 4.dp)
        ) {
            IconButton(onClick = { viewModel.retry() }) {
                Icon(Icons.Default.Refresh, contentDescription = "刷新", tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 总资产头卡
// ─────────────────────────────────────────────────────────────────

@Composable
private fun AssetHeaderCard(
    netWorth: Double,
    dailyNetWorth: Double,
    investmentMarketValue: Double,
    liabilities: Double,
    showAmounts: Boolean,
    onToggleShow: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primaryContainer)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 14.dp)
                .animateContentSize(),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    "总资产",
                    color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.75f),
                    style = MaterialTheme.typography.labelLarge,
                    modifier = Modifier.weight(1f)
                )
                IconButton(
                    onClick = onToggleShow,
                    modifier = Modifier.size(28.dp)
                ) {
                    Icon(
                        if (showAmounts) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                        contentDescription = if (showAmounts) "隐藏金额" else "显示金额",
                        tint = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.65f),
                        modifier = Modifier.size(18.dp)
                    )
                }
            }

            Text(
                text = if (showAmounts) formatAmount(netWorth) else "****",
                style = MaterialTheme.typography.headlineMedium.copy(fontSize = 28.sp),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimaryContainer
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                HeaderMiniMetric("日常", dailyNetWorth, showAmounts, Modifier.weight(1f))
                HeaderMiniMetric("投资", investmentMarketValue, showAmounts, Modifier.weight(1f))
                HeaderMiniMetric("负债", liabilities, showAmounts, Modifier.weight(1f), liability = true)
            }
        }
    }
}

@Composable
private fun HeaderMiniMetric(
    label: String,
    value: Double,
    showAmounts: Boolean,
    modifier: Modifier = Modifier,
    liability: Boolean = false
) {
    Column(modifier = modifier) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer.copy(alpha = 0.62f),
            maxLines = 1
        )
        Text(
            text = if (showAmounts) formatAmount(value) else "****",
            style = MaterialTheme.typography.bodySmall.copy(fontSize = 12.sp),
            fontWeight = FontWeight.SemiBold,
            color = if (liability && value > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onPrimaryContainer,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun MonthFlowStrip(
    income: Double,
    expense: Double,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            CompactMetric(
                label = "本月收入",
                value = if (showAmounts) formatAmount(abs(income)) else "****",
                valueColor = Color(0xFF16A34A),
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "本月支出",
                value = if (showAmounts) formatAmount(abs(expense)) else "****",
                valueColor = Color(0xFFDC2626),
                modifier = Modifier.weight(1f)
            )
            CompactMetric(
                label = "结余",
                value = if (showAmounts) formatPnl(income - expense) else "****",
                valueColor = pnlColor(income - expense),
                modifier = Modifier.weight(1f),
                alignEnd = true
            )
        }
    }
}

@Composable
private fun DailySummaryCard(
    totals: AccountTypeTotalsDto,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Column(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                CompactMetric("现金", displayAmount(totals.cash, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("借记卡", displayAmount(totals.bankDebit, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("第三方", displayAmount(totals.ewallet, showAmounts), modifier = Modifier.weight(1f), alignEnd = true)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.fillMaxWidth()) {
                CompactMetric("存款", displayAmount(totals.deposit, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric("债权", displayAmount(totals.loanReceivable, showAmounts), modifier = Modifier.weight(1f))
                CompactMetric(
                    "负债",
                    displayAmount(totals.liabilities, showAmounts),
                    valueColor = if (totals.liabilities > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    modifier = Modifier.weight(1f),
                    alignEnd = true
                )
            }
        }
    }
}

@Composable
private fun CreditSummaryCard(
    used: Double,
    available: Double,
    currentBill: Double,
    showAmounts: Boolean
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(14.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 12.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp)
        ) {
            CompactMetric("信用卡已用", displayAmount(used, showAmounts), valueColor = MaterialTheme.colorScheme.error, modifier = Modifier.weight(1f))
            CompactMetric("可用额度", displayAmount(available, showAmounts), modifier = Modifier.weight(1f))
            CompactMetric("本期账单", displayAmount(currentBill, showAmounts), modifier = Modifier.weight(1f), alignEnd = true)
        }
    }
}

@Composable
private fun CompactMetric(
    label: String,
    value: String,
    valueColor: Color = MaterialTheme.colorScheme.onSurface,
    modifier: Modifier = Modifier,
    alignEnd: Boolean = false
) {
    Column(
        modifier = modifier,
        horizontalAlignment = if (alignEnd) Alignment.End else Alignment.Start
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium.copy(fontSize = 13.sp),
            fontWeight = FontWeight.SemiBold,
            color = valueColor,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

private fun displayAmount(value: Double, showAmounts: Boolean): String =
    if (showAmounts) formatAmount(value) else "****"

// ─────────────────────────────────────────────────────────────────
// 持仓卡片
// ─────────────────────────────────────────────────────────────────

@Composable
private fun PositionCard(
    pos: TopPositionRowDto,
    showAmounts: Boolean,
    onClick: () -> Unit
) {
    val profitColor = pnlColor(pos.floatingPnL)

    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // 左侧：基金图标
            Box(
                modifier = Modifier
                    .size(40.dp)
                    .clip(RoundedCornerShape(10.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.1f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    Icons.Default.ShowChart, contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(22.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            // 基金名 + 市值
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = pos.name.ifEmpty { pos.fundCode },
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 1
                )
                Text(
                    text = if (showAmounts) formatAmount(pos.marketValue) else "****",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // 盈亏
            Column(horizontalAlignment = Alignment.End) {
                Text(
                    text = if (showAmounts) formatPnl(pos.floatingPnL) else "****",
                    style = MaterialTheme.typography.bodyMedium.copy(fontSize = 15.sp),
                    fontWeight = FontWeight.Bold,
                    color = profitColor
                )
                Text(
                    text = if (showAmounts) formatRate(pos.floatingPnLRate) else "****",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 账户卡片
// ─────────────────────────────────────────────────────────────────

@Composable
private fun AccountCard(
    acc: AccountListRowDto,
    showAmounts: Boolean,
    onClick: () -> Unit
) {
    Card(
        onClick = onClick,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 14.dp, vertical = 14.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // 类型图标
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(accountKindColor(acc.kind).copy(alpha = 0.1f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    kindIcon(acc.kind), contentDescription = null,
                    tint = accountKindColor(acc.kind),
                    modifier = Modifier.size(18.dp)
                )
            }

            Spacer(modifier = Modifier.width(12.dp))

            Text(
                text = acc.displayName(),
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier.weight(1f)
            )

            Text(
                text = if (showAmounts) formatAmount(acc.balance) else "****",
                style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
                fontWeight = FontWeight.SemiBold,
                color = if (acc.balance >= 0) MaterialTheme.colorScheme.onSurface
                else MaterialTheme.colorScheme.error
            )

            Spacer(modifier = Modifier.width(4.dp))
            Icon(Icons.Default.ChevronRight, contentDescription = null, tint = Color.Gray, modifier = Modifier.size(20.dp))
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 骨架加载态
// ─────────────────────────────────────────────────────────────────

@Composable
private fun SkeletonLoading() {
    LazyColumn(
        modifier = Modifier.fillMaxSize(),
        contentPadding = PaddingValues(16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        item {
            Card(
                modifier = Modifier.fillMaxWidth().height(180.dp),
                shape = RoundedCornerShape(20.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.3f))
            ) {}
        }
        item {
            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                repeat(2) {
                    Card(
                        modifier = Modifier.weight(1f).height(90.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                    ) {}
                }
            }
        }
        item {
            Card(
                modifier = Modifier.fillMaxWidth().height(200.dp),
                shape = RoundedCornerShape(16.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {}
        }
        repeat(4) {
            item {
                Card(
                    modifier = Modifier.fillMaxWidth().height(64.dp),
                    shape = RoundedCornerShape(12.dp),
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
                ) {}
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 辅助组件
// ─────────────────────────────────────────────────────────────────

@Composable
private fun SectionHeader(text: String) {
    Text(
        text = text,
        style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.onSurface,
        modifier = Modifier.padding(top = 2.dp)
    )
}

@Composable
private fun ErrorBanner(message: String, onRetry: () -> Unit) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.errorContainer)
    ) {
        Row(modifier = Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f)
            )
            TextButton(onClick = onRetry) { Text("重试") }
        }
    }
}

private fun kindIcon(kind: String): ImageVector = when (kind) {
    "investment" -> Icons.Default.ShowChart
    "bank_debit", "bank_credit" -> Icons.Default.AccountBalance
    "ewallet" -> Icons.Default.AccountBalanceWallet
    "cash" -> Icons.Default.Payments
    "loan" -> Icons.Default.RequestQuote
    else -> Icons.Default.Savings
}

private fun accountKindColor(kind: String): Color = when (kind) {
    "investment" -> Color(0xFFD97706)
    "bank_debit", "bank_credit" -> Color(0xFF2563EB)
    "ewallet" -> Color(0xFF0891B2)
    "cash" -> Color(0xFF16A34A)
    "loan" -> Color(0xFFDC2626)
    else -> Color(0xFF6B7280)
}

private fun AccountListRowDto.displayName(): String = formatAccountDisplayName(name, institutionName)
