package com.mmh.app.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

/**
 * A pending auto-bookkeeping draft captured from a payment app's screen.
 *
 * Lives locally on the device until the user either confirms it (writes it to
 * the ledger through the transaction form) or deletes it. `status` is reserved
 * for future states (e.g. confirmed/hidden); drafts are created as "pending".
 */
@Entity(tableName = "auto_draft")
data class AutoDraftEntity(
    @PrimaryKey val id: String,
    val amount: Double,
    val direction: String,
    val merchant: String?,
    @ColumnInfo(name = "account_hint") val accountHint: String?,
    val note: String?,
    @ColumnInfo(name = "raw_text") val rawText: String?,
    val date: String,
    @ColumnInfo(name = "captured_at") val capturedAt: Long,
    val status: String = "pending"
)
