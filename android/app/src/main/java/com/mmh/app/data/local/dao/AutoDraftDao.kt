package com.mmh.app.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import com.mmh.app.data.local.entity.AutoDraftEntity
import kotlinx.coroutines.flow.Flow

/** DAO for pending auto-bookkeeping drafts. */
@Dao
interface AutoDraftDao {

    @Query("SELECT * FROM auto_draft WHERE status='pending' ORDER BY captured_at DESC")
    fun observePending(): Flow<List<AutoDraftEntity>>

    @Query("SELECT * FROM auto_draft WHERE status='pending' ORDER BY captured_at DESC")
    suspend fun getPending(): List<AutoDraftEntity>

    @Query("SELECT * FROM auto_draft WHERE id=:id")
    suspend fun getById(id: String): AutoDraftEntity?

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insert(entity: AutoDraftEntity): Long

    /** Used to dedupe repeated captures of the same payment within a window. */
    @Query("SELECT * FROM auto_draft WHERE status='pending' AND amount=:amount AND direction=:direction AND captured_at > :since ORDER BY captured_at DESC")
    suspend fun findRecent(amount: Double, direction: String, since: Long): List<AutoDraftEntity>

    @Query("DELETE FROM auto_draft WHERE id=:id")
    suspend fun deleteById(id: String)

    @Query("DELETE FROM auto_draft WHERE status='pending'")
    suspend fun clearPending()

    @Query("SELECT COUNT(*) FROM auto_draft WHERE status='pending'")
    suspend fun pendingCount(): Int
}
