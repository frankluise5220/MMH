package com.mmh.app.ui.overview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.remote.dto.AccountListRowDto
import com.mmh.app.data.remote.dto.AssetDistributionItemDto
import com.mmh.app.data.remote.dto.TopPositionRowDto
import com.mmh.app.data.repository.OverviewRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import javax.inject.Inject

/**
 * UI state for the overview screen.
 * Fields mirror GET /api/v1/overview/summary (single source of truth with web).
 */
data class OverviewUiState(
    val isLoading: Boolean = false,
    val netWorth: Double = 0.0,
    val floatingPnL: Double = 0.0,
    val totalCost: Double = 0.0,
    val monthIncome: Double = 0.0,
    val monthExpense: Double = 0.0,
    val assetDistribution: List<AssetDistributionItemDto> = emptyList(),
    val accountList: List<AccountListRowDto> = emptyList(),
    val topPositions: List<TopPositionRowDto> = emptyList(),
    val error: String? = null
)

@HiltViewModel
class OverviewViewModel @Inject constructor(
    private val overviewRepository: OverviewRepository
) : ViewModel() {

    private val _uiState = MutableStateFlow(OverviewUiState())
    val uiState: StateFlow<OverviewUiState> = _uiState.asStateFlow()

    fun loadOverview() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, error = null)
            when (val result = overviewRepository.getSummary()) {
                is com.mmh.app.domain.model.Resource.Success -> {
                    val d = result.data
                    _uiState.value = OverviewUiState(
                        isLoading = false,
                        netWorth = d.netWorth,
                        floatingPnL = d.floatingPnL,
                        totalCost = d.totalCost,
                        monthIncome = d.monthIncome,
                        monthExpense = d.monthExpense,
                        assetDistribution = d.assetDistribution,
                        accountList = d.accountList,
                        topPositions = d.topPositions
                    )
                }
                is com.mmh.app.domain.model.Resource.Error -> {
                    _uiState.value = _uiState.value.copy(
                        isLoading = false,
                        error = result.message
                    )
                }
            }
        }
    }

    fun retry() = loadOverview()
}
