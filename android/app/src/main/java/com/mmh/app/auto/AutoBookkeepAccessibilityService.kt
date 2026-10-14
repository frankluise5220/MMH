package com.mmh.app.auto

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.mmh.app.data.repository.AutoDraftRepository
import dagger.hilt.android.AndroidEntryPoint
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import timber.log.Timber
import javax.inject.Inject

/**
 * Captures bill info from whitelisted payment apps via the Accessibility API.
 *
 * Privacy model (mirrors the "一木记账" approach the user asked for):
 *  - Only runs when the master switch in Settings is enabled.
 *  - Only processes the packages the user explicitly enabled.
 *  - Reads only the active window's text, parses a [CapturedBill] locally, and
 *    stores it as a pending draft. Nothing leaves the device until the user
 *    confirms the draft in the app and it is written to the ledger.
 */
@AndroidEntryPoint
class AutoBookkeepAccessibilityService : AccessibilityService() {

    @Inject lateinit var prefs: AutoBookkeepPrefs
    @Inject lateinit var autoDraftRepository: AutoDraftRepository

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var lastParseAt = 0L

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (!prefs.enabled) return
        val pkg = event?.packageName?.toString() ?: return
        if (pkg !in prefs.enabledPackages()) return

        val type = event.eventType
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return

        val now = System.currentTimeMillis()
        if (now - lastParseAt < 700) return // throttle: the same window fires many events
        lastParseAt = now

        val root = rootInActiveWindow ?: event?.source ?: return
        val text = try {
            collectText(root)
        } catch (e: Exception) {
            Timber.w(e, "collectText failed")
            return
        }

        val bill = BillParser.parse(text, pkg)
        if (bill != null) {
            scope.launch {
                autoDraftRepository.addCapturedBill(bill)
            }
        }
    }

    override fun onInterrupt() {
        // Nothing to release: capture is stateless across events.
    }

    /** Bounded breadth-first traversal collecting visible text / descriptions. */
    private fun collectText(root: AccessibilityNodeInfo, maxNodes: Int = 220): String {
        val parts = ArrayList<String>(64)
        var visited = 0
        val queue = ArrayDeque<AccessibilityNodeInfo>()
        queue.addLast(root)
        while (queue.isNotEmpty() && visited < maxNodes) {
            val node = queue.removeFirst()
            visited++
            node.text?.toString()?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
            node.contentDescription?.toString()?.takeIf { it.isNotBlank() }?.let { parts.add(it) }
            for (i in 0 until node.childCount) {
                node.getChild(i)?.let { queue.addLast(it) }
            }
        }
        return parts.joinToString(" ")
    }
}
