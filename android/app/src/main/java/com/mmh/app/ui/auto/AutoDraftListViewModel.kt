package com.mmh.app.ui.auto

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.mmh.app.data.local.entity.AutoDraftEntity
import com.mmh.app.data.repository.AutoDraftRepository
import dagger.hilt.android.lifecycle.HiltViewModel
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import javax.inject.Inject

/** UI state for the pending auto-bookkeeping draft list. */
data class AutoDraftListUiState(
    val drafts: List<AutoDraftEntity> = emptyList(),
    val loading: Boolean = true
)

@HiltViewModel
class AutoDraftListViewModel @Inject constructor(
    private val autoDraftRepository: AutoDraftRepository
) : ViewModel() {

    val uiState: StateFlow<AutoDraftListUiState> =
        autoDraftRepository.observePending()
            .map { AutoDraftListUiState(drafts = it, loading = false) }
            .stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), AutoDraftListUiState())

    fun delete(id: String) {
        viewModelScope.launch { autoDraftRepository.deleteById(id) }
    }

    fun clearAll() {
        viewModelScope.launch { autoDraftRepository.clearPending() }
    }
}
