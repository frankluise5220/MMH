package com.mmh.app.ui.overview

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.Canvas
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel
import com.mmh.app.data.remote.dto.AccountListRowDto
import com.mmh.app.data.remote.dto.AssetDistributionItemDto
import com.mmh.app.data.remote.dto.TopPositionRowDto
import com.mmh.app.ui.theme.pnlColor
import com.mmh.app.ui.util.formatAccountDisplayName
import com.mmh.app.ui.util.formatAmount
import com.mmh.app.ui.util.formatPnl
import com.mmh.app.ui.util.formatRate
import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin

/**
 * 总览 / 资产首页。
 *
 * 对标支付宝"总资产"页 + 招商银行"我的"页的资产展示模式：
 * - 总资产金额、双目显隐切换
 * - 浮动盈亏、持仓成本（红涨绿跌）
 * - 环形资产分布图（Canvas 手绘 donut）
 * - 本月收支双卡
 * - 持仓摘要、账户余额
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
                contentPadding = PaddingValues(start = 16.dp, end = 16.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(14.dp)
            ) {
                // ═══ 总资产大卡（对标支付宝）═══
                item {
                    AssetHeaderCard(
                        netWorth = uiState.netWorth,
                        floatingPnL = uiState.floatingPnL,
                        totalCost = uiState.totalCost,
                        showAmounts = showAmounts,
                        onToggleShow = { showAmounts = !showAmounts }
                    )
                }

                // ═══ 本月收支 ═══
                item {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.spacedBy(12.dp)
                    ) {
                        FlowCard(
                            label = "本月收入",
                            amount = uiState.monthIncome,
                            icon = Icons.Default.ArrowDownward,
                            iconTint = Color(0xFF16A34A),
                            showAmounts = showAmounts,
                            modifier = Modifier.weight(1f)
                        )
                        FlowCard(
                            label = "本月支出",
                            amount = uiState.monthExpense,
                            icon = Icons.Default.ArrowUpward,
                            iconTint = Color(0xFFDC2626),
                            showAmounts = showAmounts,
                            modifier = Modifier.weight(1f)
                        )
                    }
                }

                // ═══ 资产分布环形图 ═══
                if (uiState.assetDistribution.isNotEmpty()) {
                    item {
                        SectionHeader("资产分布")
                    }
                    item {
                        AssetDonutCard(
                            items = uiState.assetDistribution,
                            showAmounts = showAmounts
                        )
                    }
                }

                // ═══ 持仓摘要 ═══
                if (uiState.topPositions.isNotEmpty()) {
                    item { SectionHeader("持仓摘要") }
                    items(uiState.topPositions, key = { "${it.accountId}:${it.fundCode}" }) { pos ->
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

                // ═══ 账户余额 ═══
                if (uiState.accountList.isNotEmpty()) {
                    item { SectionHeader("账户余额") }
                    items(uiState.accountList, key = { it.id }) { acc ->
                        val displayName = acc.displayName()
                        AccountCard(acc, showAmounts) { onNavigateToAccountDetail(acc.id, displayName) }
                    }
                }

                // ═══ 快捷入口 ═══
                item { SectionHeader("快捷操作") }
                item {
                    QuickActionsRow(
                        onRecord = onNavigateToAddTransaction,
                        onAccounts = onNavigateToAccounts,
                        onFunds = onNavigateToFunds
                    )
                }

                // ═══ 错误提示 ═══
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
            IconButton(onClick = onNavigateToSettings) {
                Icon(Icons.Default.Settings, contentDescription = "设置", tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
    floatingPnL: Double,
    totalCost: Double,
    showAmounts: Boolean,
    onToggleShow: () -> Unit
) {
    val floatingPnlColor = pnlColor(floatingPnL)

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(20.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.primary)
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(20.dp)
                .animateContentSize(),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // 标题行：总资产 + 眼睛图标
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "总资产",
                    color = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.85f),
                    style = MaterialTheme.typography.titleSmall
                )
                Spacer(modifier = Modifier.width(6.dp))
                IconButton(
                    onClick = onToggleShow,
                    modifier = Modifier.size(24.dp)
                ) {
                    Icon(
                        if (showAmounts) Icons.Default.Visibility else Icons.Default.VisibilityOff,
                        contentDescription = if (showAmounts) "隐藏金额" else "显示金额",
                        tint = MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f),
                        modifier = Modifier.size(20.dp)
                    )
                }
            }

            Spacer(modifier = Modifier.height(8.dp))

            // 金额
            Text(
                text = if (showAmounts) formatAmount(netWorth) else "****",
                style = MaterialTheme.typography.headlineLarge.copy(fontSize = 30.sp),
                fontWeight = FontWeight.Bold,
                color = MaterialTheme.colorScheme.onPrimary
            )

            Spacer(modifier = Modifier.height(20.dp))

            // 底部两列数据
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                StatItem(
                    label = "浮动盈亏",
                    value = if (showAmounts) formatPnl(floatingPnL) else "****",
                    valueColor = floatingPnlColor,
                    onPrimary = false
                )
                StatItem(
                    label = "持仓成本",
                    value = if (showAmounts) formatAmount(totalCost) else "****",
                    valueColor = MaterialTheme.colorScheme.onPrimary,
                    onPrimary = false
                )
            }
        }
    }
}

@Composable
private fun StatItem(
    label: String,
    value: String,
    valueColor: Color,
    onPrimary: Boolean
) {
    Column(horizontalAlignment = Alignment.CenterHorizontally) {
        Text(
            text = label,
            style = MaterialTheme.typography.labelMedium,
            color = if (onPrimary) MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.8f)
            else MaterialTheme.colorScheme.onPrimary.copy(alpha = 0.7f)
        )
        Spacer(modifier = Modifier.height(2.dp))
        Text(
            text = value,
            style = MaterialTheme.typography.titleSmall.copy(fontSize = 15.sp),
            fontWeight = FontWeight.SemiBold,
            color = valueColor
        )
    }
}

// ─────────────────────────────────────────────────────────────────
// 收支卡片
// ─────────────────────────────────────────────────────────────────

@Composable
private fun FlowCard(
    label: String,
    amount: Double,
    icon: ImageVector,
    iconTint: Color,
    showAmounts: Boolean,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier,
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    modifier = Modifier
                        .size(28.dp)
                        .clip(CircleShape)
                        .background(iconTint.copy(alpha = 0.12f)),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        icon, contentDescription = null,
                        tint = iconTint, modifier = Modifier.size(16.dp)
                    )
                }
                Spacer(modifier = Modifier.width(8.dp))
                Text(
                    text = label,
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = if (showAmounts) formatAmount(abs(amount)) else "****",
                style = MaterialTheme.typography.titleMedium.copy(fontSize = 18.sp),
                fontWeight = FontWeight.Bold,
                color = iconTint
            )
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// 环形资产分布图（Canvas Donut）
// ─────────────────────────────────────────────────────────────────

@Composable
private fun AssetDonutCard(
    items: List<AssetDistributionItemDto>,
    showAmounts: Boolean
) {
    val palette = listOf(
        Color(0xFF1976D2), Color(0xFF388E3C), Color(0xFFFB8C00),
        Color(0xFF8E24AA), Color(0xFF00ACC1), Color(0xFFE53935),
        Color(0xFF6D4C41), Color(0xFF5C6BC0), Color(0xFFFF7043)
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // 左侧：环形图
            Box(
                modifier = Modifier.size(130.dp),
                contentAlignment = Alignment.Center
            ) {
                val total = items.sumOf { abs(it.value) }.coerceAtLeast(1.0)
                val strokeWidth = 20f
                Canvas(modifier = Modifier.fillMaxSize()) {
                    val size = Size(size.width, size.height)
                    val topLeft = Offset(strokeWidth / 2, strokeWidth / 2)
                    val arcSize = Size(size.width - strokeWidth, size.height - strokeWidth)
                    var startAngle = -90f

                    val totalSweep = items.sumOf { (abs(it.value) / total * 360f).toDouble() }
                        .toFloat().coerceAtMost(360f)

                    items.forEachIndexed { i, it ->
                        val sweep = (abs(it.value) / total * 360f).toFloat()
                        if (sweep > 0f) {
                            drawArc(
                                color = palette[i % palette.size],
                                startAngle = startAngle,
                                sweepAngle = sweep,
                                useCenter = false,
                                topLeft = Offset(strokeWidth / 2, strokeWidth / 2),
                                size = Size(size.width - strokeWidth, size.height - strokeWidth),
                                style = Stroke(width = strokeWidth, cap = StrokeCap.Butt)
                            )
                            startAngle += sweep
                        }
                    }
                }

                // 中心文字
                Text(
                    "${items.size}类资产",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center
                )
            }

            Spacer(modifier = Modifier.width(16.dp))

            // 右侧：图例
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(10.dp)
            ) {
                items.take(7).forEachIndexed { i, it ->
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Box(
                            modifier = Modifier
                                .size(10.dp)
                                .clip(CircleShape)
                                .background(palette[i % palette.size])
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = it.label,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f)
                        )
                        Text(
                            text = "${String.format("%.1f", it.pct)}%",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(modifier = Modifier.width(8.dp))
                        Text(
                            text = if (showAmounts) formatAmount(it.value) else "****",
                            style = MaterialTheme.typography.bodySmall,
                            fontWeight = FontWeight.Medium
                        )
                    }
                }
            }
        }
    }
}

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
// 快捷操作
// ─────────────────────────────────────────────────────────────────

@Composable
private fun QuickActionsRow(
    onRecord: () -> Unit,
    onAccounts: () -> Unit,
    onFunds: () -> Unit
) {
    val actions = listOf(
        Triple("记一笔", Icons.Default.EditNote, onRecord),
        Triple("账户", Icons.Default.AccountBalance, onAccounts),
        Triple("基金", Icons.Default.TrendingUp, onFunds),
    )
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        actions.forEach { (label, icon, onClick) ->
            Card(
                onClick = onClick,
                modifier = Modifier.weight(1f).height(76.dp),
                shape = RoundedCornerShape(12.dp),
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Column(
                    modifier = Modifier.fillMaxSize(),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.Center
                ) {
                    Icon(icon, contentDescription = label, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(24.dp))
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
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
