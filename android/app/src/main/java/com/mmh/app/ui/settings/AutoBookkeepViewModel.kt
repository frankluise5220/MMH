package com.mmh.app.ui.settings

import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.auto.AutoBookkeepPrefs
import com.mmh.app.data.repository.AutoDraftRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** State + actions for the auto-bookkeeping settings card. */
data class AutoBookkeepUiState(
    val enabled: Boolean = false,
    val enabledPackages: Set<String> = emptySet(),
    val accessibilityOn: Boolean = false,
    val pendingCount: Int = 0
)

@HiltViewModel
class AutoBookkeepViewModel @Inject constructor(
    private val prefs: AutoBookkeepPrefs,
    private val autoDraftRepository: AutoDraftRepository,
    @ApplicationContext private val context: Context
) : ViewModel() {

    val uiState: StateFlow<AutoBookkeepUiState> =
        combine(
            flowOf(
                AutoBookkeepUiState(
                    enabled = prefs.enabled,
                    enabledPackages = prefs.enabledPackages(),
                    accessibilityOn = isAccessibilityOn()
                )
            ),
            autoDraftRepository.observePending().map { it.size }
        ) { base, count -> base.copy(pendingCount = count) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), AutoBookkeepUiState())

    fun setEnabled(value: Boolean) {
        prefs.enabled = value
    }

    fun togglePackage(pkg: String, on: Boolean) {
        val next = prefs.enabledPackages().toMutableSet().apply {
            if (on) add(pkg) else remove(pkg)
        }
        prefs.setEnabledPackages(next)
    }

    fun isAccessibilityOn(): Boolean {
        val enabled = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
        ) ?: return false
        val target = "${context.packageName}/${ACCESSIBILITY_SERVICE_CLASS}"
        return enabled.split(':').any { it.equals(target, ignoreCase = true) }
    }

    fun accessibilitySettingsIntent(): Intent = Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)

    fun clearAll() {
        viewModelScope.launch { autoDraftRepository.clearPending() }
    }

    private companion object {
        const val ACCESSIBILITY_SERVICE_CLASS = "com.mmh.app.auto.AutoBookkeepAccessibilityService"
    }
}
