package com.mmh.app.data.repository

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import com.mmh.app.MainActivity
import com.mmh.app.R
import com.mmh.app.auto.CapturedBill
import com.mmh.app.data.local.dao.AutoDraftDao
import com.mmh.app.data.local.entity.AutoDraftEntity
import dagger.hilt.android.qualifiers.ApplicationContext
import kotlinx.coroutines.flow.Flow
import java.time.LocalDate
import java.util.UUID
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Local repository for pending auto-bookkeeping drafts.
 *
 * Capture (from the accessibility service) only writes to Room; confirming a
 * draft routes the user into the existing transaction form, which reuses the
 * canonical server-side create path — no separate ledger-write logic here.
 */
@Singleton
class AutoDraftRepository @Inject constructor(
    @ApplicationContext private val context: Context,
    private val autoDraftDao: AutoDraftDao
) {

    fun observePending(): Flow<List<AutoDraftEntity>> = autoDraftDao.observePending()

    suspend fun getPending(): List<AutoDraftEntity> = autoDraftDao.getPending()

    suspend fun getById(id: String): AutoDraftEntity? = autoDraftDao.getById(id)

    suspend fun deleteById(id: String) = autoDraftDao.deleteById(id)

    suspend fun clearPending() = autoDraftDao.clearPending()

    /**
     * Persist a captured bill as a pending draft. Dedupes repeated captures of
     * the same payment (same amount/direction/merchant/note) within 5 minutes.
     * @return true when a new draft was inserted.
     */
    suspend fun addCapturedBill(bill: CapturedBill): Boolean {
        val since = System.currentTimeMillis() - DEDUP_WINDOW_MS
        val recent = autoDraftDao.findRecent(bill.amount, bill.direction.transactionType, since)
        if (recent.any { it.merchant == bill.merchant && it.note == bill.note }) {
            return false
        }

        autoDraftDao.insert(
            AutoDraftEntity(
                id = UUID.randomUUID().toString(),
                amount = bill.amount,
                direction = bill.direction.transactionType,
                merchant = bill.merchant,
                accountHint = bill.accountHint,
                note = bill.note,
                rawText = null,
                date = LocalDate.now().toString(),
                capturedAt = bill.capturedAt
            )
        )
        notifyCaptured()
        return true
    }

    private fun notifyCaptured() {
        ensureChannel()
        if (Build.VERSION.SDK_INT >= 33 &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val contentIntent = Intent(context, MainActivity::class.java)
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        val pi = PendingIntent.getActivity(context, 0, contentIntent, flags)
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_auto_bookkeep)
            .setContentTitle("自动记账")
            .setContentText("捕获到一笔待确认账单")
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        try {
            NotificationManagerCompat.from(context).notify(NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            // POST_NOTIFICATIONS revoked — skip the heads-up, the draft is still saved.
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = context.getSystemService(NotificationManager::class.java)
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "自动记账", NotificationManager.IMPORTANCE_DEFAULT)
            )
        }
    }

    companion object {
        private const val CHANNEL_ID = "mmh_auto_bookkeep"
        private const val NOTIFICATION_ID = 1
        private const val DEDUP_WINDOW_MS = 5 * 60 * 1000L
    }
}
