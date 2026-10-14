package com.mmh.app.auto

import android.content.Context
import android.content.SharedPreferences
import dagger.hilt.android.qualifiers.ApplicationContext
import javax.inject.Inject
import javax.inject.Singleton

/**
 * Persisted settings for auto-bookkeeping: the master on/off switch and the
 * whitelist of payment apps whose screens may be read. Stored in plain
 * SharedPreferences (non-sensitive), separate from the encrypted TokenProvider.
 */
@Singleton
class AutoBookkeepPrefs @Inject constructor(
    @ApplicationContext context: Context
) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences("mmh_auto_prefs", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = prefs.getBoolean(KEY_ENABLED, false)
        set(value) {
            prefs.edit().putBoolean(KEY_ENABLED, value).apply()
        }

    fun enabledPackages(): Set<String> =
        prefs.getStringSet(KEY_PACKAGES, null) ?: defaultPackages()

    fun setEnabledPackages(packages: Set<String>) {
        prefs.edit().putStringSet(KEY_PACKAGES, packages).apply()
    }

    companion object {
        private const val KEY_ENABLED = "enabled"
        private const val KEY_PACKAGES = "enabled_packages"

        fun defaultPackages(): Set<String> = setOf(
            "com.eg.android.AlipayGphone",
            "com.tencent.mm",
            "com.taobao.idlefish",
            "com.taobao.taobao",
            "com.sankuai.meituan",
            "com.jingdong.app.mall"
        )
    }
}
