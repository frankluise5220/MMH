package com.mmh.app.ui.settings

import android.Manifest
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ReceiptLong
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.hilt.navigation.compose.hiltViewModel

/** Payment apps the user can enable for auto-bookkeeping screen capture. */
private val SUPPORTED_SOURCES = listOf(
    "com.eg.android.AlipayGphone" to "支付宝",
    "com.tencent.mm" to "微信",
    "com.taobao.idlefish" to "闲鱼",
    "com.taobao.taobao" to "淘宝",
    "com.sankuai.meituan" to "美团",
    "com.jingdong.app.mall" to "京东"
)

/** Settings card for auto-bookkeeping: master switch, accessibility gate, sources, pending drafts. */
@Composable
fun AutoBookkeepSection(
    onOpenDrafts: () -> Unit,
    viewModel: AutoBookkeepViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()
    val context = LocalContext.current

    val notifPermissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { /* a denied notification permission only disables the heads-up; drafts still save */ }

    Card(modifier = Modifier.fillMaxWidth()) {
        Column(modifier = Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("自动记账", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
                    Text(
                        "支付成功时自动捕获账单，生成待确认记录",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(
                    checked = uiState.enabled,
                    onCheckedChange = { on ->
                        viewModel.setEnabled(on)
                        if (on && Build.VERSION.SDK_INT >= 33) {
                            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
                        }
                    }
                )
            }

            HorizontalDivider()

            if (!uiState.accessibilityOn) {
                Text(
                    "无障碍服务未开启。自动记账依赖无障碍读取支付页文字，请先在系统设置中开启。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Button(
                onClick = { runCatching { context.startActivity(viewModel.accessibilitySettingsIntent()) } },
                modifier = Modifier.fillMaxWidth(),
                enabled = !uiState.accessibilityOn
            ) {
                Text(if (uiState.accessibilityOn) "无障碍已开启" else "去开启无障碍")
            }

            if (uiState.enabled) {
                Text("捕获来源", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    SUPPORTED_SOURCES.forEach { (pkg, label) ->
                        FilterChip(
                            selected = pkg in uiState.enabledPackages,
                            onClick = { viewModel.togglePackage(pkg, pkg !in uiState.enabledPackages) },
                            label = { Text(label, fontSize = 12.sp) }
                        )
                    }
                }
            }

            HorizontalDivider()

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpenDrafts() }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(Icons.Default.ReceiptLong, contentDescription = null, tint = MaterialTheme.colorScheme.primary)
                Spacer(Modifier.size(10.dp))
                Text(
                    "待确认账单",
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.Medium,
                    modifier = Modifier.weight(1f)
                )
                if (uiState.pendingCount > 0) {
                    Text(
                        "${uiState.pendingCount} 笔",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.primary
                    )
                }
                Icon(Icons.Default.ChevronRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }

            Text(
                "账单在本地解析，只有你确认后才会写入账本。仅在你开启的 App 内读取屏幕文字。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
