package dev.zamad.callrelay.relay

import android.content.Context
import dev.zamad.callrelay.BuildConfig
import dev.zamad.callrelay.crypto.SecureSecretStore

class RelayPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("relay-private", Context.MODE_PRIVATE)
    private val secureSecretStore = SecureSecretStore(context)

    init {
        val saved = preferences.getString(KEY_API_BASE, null)?.trim()?.trimEnd('/')
        if (saved in OFFICIAL_API_ORIGINS && saved != BuildConfig.DEFAULT_API_BASE_URL) {
            clearEnvironmentIdentity()
            preferences.edit().putString(KEY_API_BASE, BuildConfig.DEFAULT_API_BASE_URL).apply()
        }
    }

    var apiBaseUrl: String
        get() = preferences.getString(KEY_API_BASE, BuildConfig.DEFAULT_API_BASE_URL)
            ?.ifBlank { BuildConfig.DEFAULT_API_BASE_URL }
            ?: BuildConfig.DEFAULT_API_BASE_URL
        set(value) {
            val requested = value.trim().trimEnd('/')
            val next = if (requested in OFFICIAL_API_ORIGINS && requested != BuildConfig.DEFAULT_API_BASE_URL) {
                BuildConfig.DEFAULT_API_BASE_URL
            } else {
                requested
            }
            val previous = apiBaseUrl
            if (previous != next) clearEnvironmentIdentity()
            preferences.edit().putString(KEY_API_BASE, next).apply()
        }

    var deviceId: String
        get() = preferences.getString(KEY_DEVICE_ID, "") ?: ""
        set(value) = preferences.edit().putString(KEY_DEVICE_ID, value).apply()

    var fcmToken: String
        get() = preferences.getString(KEY_FCM_TOKEN, "") ?: ""
        set(value) = preferences.edit().putString(KEY_FCM_TOKEN, value).apply()

    var pairingId: String
        get() = preferences.getString(KEY_PAIRING_ID, "") ?: ""
        set(value) = preferences.edit().putString(KEY_PAIRING_ID, value).apply()

    var pairingSecret: String
        get() {
            secureSecretStore.get()?.let { return it }
            val legacy = preferences.getString(KEY_PAIRING_SECRET, "").orEmpty()
            if (legacy.isNotBlank()) {
                secureSecretStore.put(legacy)
                preferences.edit().remove(KEY_PAIRING_SECRET).apply()
            }
            return legacy
        }
        set(value) {
            secureSecretStore.put(value)
            preferences.edit().remove(KEY_PAIRING_SECRET).apply()
        }

    var pairingConfirmed: Boolean
        get() = preferences.getBoolean(KEY_PAIRING_CONFIRMED, false)
        set(value) = preferences.edit().putBoolean(KEY_PAIRING_CONFIRMED, value).apply()

    var selectedPhoneAccount: String
        get() = preferences.getString(KEY_PHONE_ACCOUNT, "") ?: ""
        set(value) = preferences.edit().putString(KEY_PHONE_ACCOUNT, value).apply()

    var captureGain: Float
        get() = preferences.getFloat(KEY_CAPTURE_GAIN, 1.0f)
        set(value) = preferences.edit().putFloat(KEY_CAPTURE_GAIN, value.coerceIn(0f, 4f)).apply()

    var playbackGain: Double
        get() = java.lang.Double.longBitsToDouble(
            preferences.getLong(KEY_PLAYBACK_GAIN, java.lang.Double.doubleToRawLongBits(1.0)),
        )
        set(value) = preferences.edit().putLong(
            KEY_PLAYBACK_GAIN,
            java.lang.Double.doubleToRawLongBits(value.coerceIn(0.0, 4.0)),
        ).apply()

    fun configured(): Boolean = apiBaseUrl.startsWith("https://") &&
        deviceId.isNotBlank() && pairingId.isNotBlank() && pairingSecret.isNotBlank() && pairingConfirmed

    fun claimRemoteCommand(commandId: String): Boolean = synchronized(commandLock) {
        if (commandId.isBlank()) return@synchronized true
        val existing = preferences.getString(KEY_REMOTE_COMMANDS, "")
            .orEmpty()
            .lineSequence()
            .filter(String::isNotBlank)
            .toMutableList()
        if (commandId in existing) return@synchronized false
        existing += commandId
        preferences.edit().putString(KEY_REMOTE_COMMANDS, existing.takeLast(100).joinToString("\n")).commit()
    }

    private fun clearEnvironmentIdentity() {
        preferences.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_PAIRING_ID)
            .remove(KEY_PAIRING_SECRET)
            .remove(KEY_PAIRING_CONFIRMED)
            .remove(KEY_REMOTE_COMMANDS)
            .apply()
        secureSecretStore.put("")
    }

    companion object {
        private const val KEY_API_BASE = "api_base"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_FCM_TOKEN = "fcm_token"
        private const val KEY_PAIRING_ID = "pairing_id"
        private const val KEY_PAIRING_SECRET = "pairing_secret"
        private const val KEY_PAIRING_CONFIRMED = "pairing_confirmed"
        private const val KEY_PHONE_ACCOUNT = "phone_account"
        private const val KEY_CAPTURE_GAIN = "capture_gain"
        private const val KEY_PLAYBACK_GAIN = "playback_gain"
        private const val KEY_REMOTE_COMMANDS = "remote_commands"
        private val OFFICIAL_API_ORIGINS = setOf(
            "https://call-relay-staging.zamadshakil.workers.dev",
            "https://call-relay.zamadshakil.workers.dev",
        )
        private val commandLock = Any()
    }
}
