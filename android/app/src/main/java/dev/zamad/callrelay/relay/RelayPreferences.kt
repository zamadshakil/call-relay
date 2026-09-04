package dev.zamad.callrelay.relay

import android.content.Context
import dev.zamad.callrelay.BuildConfig
import dev.zamad.callrelay.crypto.SecureSecretStore
import org.json.JSONArray
import org.json.JSONObject

class RelayPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("relay-private", Context.MODE_PRIVATE)
    private val secureSecretStore = SecureSecretStore(context)

    init {
        val saved = preferences.getString(KEY_API_BASE, null)?.trim()?.trimEnd('/')
        if (saved in OFFICIAL_API_ORIGINS && saved != BuildConfig.DEFAULT_API_BASE_URL) {
            clearEnvironmentIdentity()
            preferences.edit().putString(KEY_API_BASE, BuildConfig.DEFAULT_API_BASE_URL).apply()
        }
        migrateLegacyPairing()
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
            pairingId.takeIf(String::isNotBlank)?.let { id ->
                secureSecretStore.get(pairingSecretKey(id))?.let { return it }
            }
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
            if (pairingId.isNotBlank()) {
                secureSecretStore.put(pairingSecretKey(pairingId), value)
                upsertPairing(PairingRecord(pairingId, value, pairingConfirmed))
            }
            preferences.edit().remove(KEY_PAIRING_SECRET).apply()
        }

    var pairingConfirmed: Boolean
        get() = preferences.getBoolean(KEY_PAIRING_CONFIRMED, false)
        set(value) {
            preferences.edit().putBoolean(KEY_PAIRING_CONFIRMED, value).apply()
            if (pairingId.isNotBlank() && pairingSecret.isNotBlank()) {
                upsertPairing(PairingRecord(pairingId, pairingSecret, value))
            }
        }

    var selectedPhoneAccount: String
        get() = preferences.getString(KEY_PHONE_ACCOUNT, "") ?: ""
        set(value) = preferences.edit().putString(KEY_PHONE_ACCOUNT, value).apply()

    var simProfileUploaded: Boolean
        get() = preferences.getBoolean(KEY_SIM_PROFILE_UPLOADED, false)
        set(value) = preferences.edit().putBoolean(KEY_SIM_PROFILE_UPLOADED, value).apply()

    var accountEmail: String
        get() = preferences.getString(KEY_ACCOUNT_EMAIL, "") ?: ""
        set(value) = preferences.edit().putString(KEY_ACCOUNT_EMAIL, value).apply()

    var entitlementActive: Boolean
        get() = preferences.getBoolean(KEY_ENTITLEMENT_ACTIVE, true)
        set(value) = preferences.edit().putBoolean(KEY_ENTITLEMENT_ACTIVE, value).apply()

    /** The user's durable intent. RelayRuntime.ready is only an in-process UI cache. */
    var relayReadyDesired: Boolean
        get() = preferences.getBoolean(KEY_RELAY_READY_DESIRED, false)
        set(value) = preferences.edit().putBoolean(KEY_RELAY_READY_DESIRED, value).commit().let { Unit }

    var activeCallId: String
        get() = preferences.getString(KEY_ACTIVE_CALL_ID, "") ?: ""
        set(value) = preferences.edit().putString(KEY_ACTIVE_CALL_ID, value).commit().let { Unit }

    var activeCallDirection: String
        get() = preferences.getString(KEY_ACTIVE_CALL_DIRECTION, "") ?: ""
        set(value) = preferences.edit().putString(KEY_ACTIVE_CALL_DIRECTION, value).commit().let { Unit }

    var activeCallGeneration: Long
        get() = preferences.getLong(KEY_ACTIVE_CALL_GENERATION, 0L)
        private set(value) = preferences.edit().putLong(KEY_ACTIVE_CALL_GENERATION, value).commit().let { Unit }

    val activeCallDialIssued: Boolean
        get() = preferences.getBoolean(KEY_ACTIVE_CALL_DIAL_ISSUED, false)

    var captureGain: Float
        get() = preferences.getFloat(KEY_CAPTURE_GAIN, 1.0f)
        set(value) = preferences.edit().putFloat(KEY_CAPTURE_GAIN, value.coerceIn(0f, 4f)).apply()

    var playbackGain: Double
        get() = java.lang.Double.longBitsToDouble(
            preferences.getLong(KEY_PLAYBACK_GAIN, java.lang.Double.doubleToRawLongBits(DEFAULT_PLAYBACK_GAIN)),
        )
        set(value) = preferences.edit().putLong(
            KEY_PLAYBACK_GAIN,
            java.lang.Double.doubleToRawLongBits(value.coerceIn(0.0, 4.0)),
        ).apply()

    data class PairingRecord(
        val id: String,
        val secret: String,
        val confirmed: Boolean,
        val peerDeviceId: String = "",
        val peerPlatform: String = "peer",
    )

    fun pairings(): List<PairingRecord> = synchronized(commandLock) {
        val array = runCatching { JSONArray(preferences.getString(KEY_PAIRINGS, "[]").orEmpty()) }.getOrElse { JSONArray() }
        buildList {
            for (index in 0 until array.length()) {
                val value = array.optJSONObject(index) ?: continue
                val id = value.optString("id")
                val secret = secureSecretStore.get(pairingSecretKey(id)).orEmpty()
                if (id.isBlank() || secret.isBlank()) continue
                add(PairingRecord(
                    id = id,
                    secret = secret,
                    confirmed = value.optBoolean("confirmed"),
                    peerDeviceId = value.optString("peerDeviceId"),
                    peerPlatform = value.optString("peerPlatform", "peer"),
                ))
            }
        }
    }

    fun confirmedPairings(): List<PairingRecord> = pairings().filter(PairingRecord::confirmed)

    fun pairing(pairingId: String): PairingRecord? = pairings().firstOrNull { it.id == pairingId }

    fun upsertPairing(record: PairingRecord) = synchronized(commandLock) {
        if (record.id.isBlank() || record.secret.isBlank()) return@synchronized
        secureSecretStore.put(pairingSecretKey(record.id), record.secret)
        val records = pairings().filterNot { it.id == record.id } + record
        savePairingMetadata(records)
    }

    fun removePairing(pairingId: String) = synchronized(commandLock) {
        if (pairingId.isBlank()) return@synchronized
        secureSecretStore.put(pairingSecretKey(pairingId), "")
        val remaining = pairings().filterNot { it.id == pairingId }
        savePairingMetadata(remaining)
        if (this.pairingId == pairingId) {
            val next = remaining.lastOrNull()
            preferences.edit()
                .putString(KEY_PAIRING_ID, next?.id.orEmpty())
                .putBoolean(KEY_PAIRING_CONFIRMED, next?.confirmed == true)
                .apply()
            secureSecretStore.put(next?.secret.orEmpty())
        }
    }

    /** Keeps old single-pair call sites pointed at a valid record during migration. */
    fun activateLegacyPairing(pairingId: String): Boolean = synchronized(commandLock) {
        val record = pairing(pairingId) ?: return@synchronized false
        preferences.edit()
            .putString(KEY_PAIRING_ID, record.id)
            .putBoolean(KEY_PAIRING_CONFIRMED, record.confirmed)
            .commit()
        secureSecretStore.put(record.secret)
        true
    }

    fun configured(): Boolean = apiBaseUrl.startsWith("https://") &&
        deviceId.isNotBlank() && confirmedPairings().isNotEmpty()

    data class RemoteCommand(
        val id: String,
        val type: String,
        val event: String,
        val callId: String,
        val pairingId: String,
        val phoneNumber: String,
        val digit: String,
        val muted: String,
        val callVersion: Long,
        val createdAt: Long,
    )

    /** Persist before waking the foreground service. Completion is recorded only after dispatch succeeds. */
    fun enqueueRemoteCommand(command: RemoteCommand): Boolean = synchronized(commandLock) {
        if (command.id.isBlank()) return@synchronized false
        if (processedCommandIds().contains(command.id)) return@synchronized false
        val pending = pendingRemoteCommands().toMutableList()
        if (pending.any { it.id == command.id }) return@synchronized false
        pending += command
        savePendingCommands(pending.takeLast(MAX_PENDING_COMMANDS))
    }

    fun pendingRemoteCommands(): List<RemoteCommand> = synchronized(commandLock) {
        val encoded = preferences.getString(KEY_PENDING_REMOTE_COMMANDS, "[]").orEmpty()
        val array = runCatching { JSONArray(encoded) }.getOrElse { JSONArray() }
        buildList {
            for (index in 0 until array.length()) {
                val value = array.optJSONObject(index) ?: continue
                val id = value.optString("id")
                if (id.isBlank()) continue
                add(
                    RemoteCommand(
                        id = id,
                        type = value.optString("type"),
                        event = value.optString("event"),
                        callId = value.optString("callId"),
                        pairingId = value.optString("pairingId"),
                        phoneNumber = value.optString("phoneNumber"),
                        digit = value.optString("digit"),
                        muted = value.optString("muted"),
                        callVersion = value.optLong("callVersion", 0L),
                        createdAt = value.optLong("createdAt", 0L),
                    ),
                )
            }
        }
    }

    fun completeRemoteCommand(commandId: String) = synchronized(commandLock) {
        val pending = pendingRemoteCommands().filterNot { it.id == commandId }
        val processed = processedCommandIds().filterNot { it == commandId }.toMutableList().apply { add(commandId) }
        preferences.edit()
            .putString(KEY_PENDING_REMOTE_COMMANDS, encodeCommands(pending))
            .putString(KEY_PROCESSED_REMOTE_COMMANDS, processed.takeLast(MAX_PROCESSED_COMMANDS).joinToString("\n"))
            .commit()
        Unit
    }

    fun discardRemoteCommand(commandId: String) = synchronized(commandLock) {
        savePendingCommands(pendingRemoteCommands().filterNot { it.id == commandId })
        Unit
    }

    fun beginActiveCall(callId: String, direction: String): Long = synchronized(commandLock) {
        if (callId.isBlank()) return@synchronized activeCallGeneration
        if (activeCallId == callId) return@synchronized activeCallGeneration
        val nextGeneration = activeCallGeneration + 1L
        preferences.edit()
            .putString(KEY_ACTIVE_CALL_ID, callId)
            .putString(KEY_ACTIVE_CALL_DIRECTION, direction)
            .putLong(KEY_ACTIVE_CALL_GENERATION, nextGeneration)
            .putBoolean(KEY_ACTIVE_CALL_DIAL_ISSUED, false)
            .commit()
        nextGeneration
    }

    /** Persist before Telecom.placeCall so a process restart cannot double-dial. */
    fun markActiveCallDialIssued(expectedCallId: String): Boolean = synchronized(commandLock) {
        if (expectedCallId.isBlank() || activeCallId != expectedCallId || activeCallDialIssued) {
            return@synchronized false
        }
        preferences.edit().putBoolean(KEY_ACTIVE_CALL_DIAL_ISSUED, true).commit()
    }

    fun clearActiveCall(expectedCallId: String? = null) = synchronized(commandLock) {
        if (!expectedCallId.isNullOrBlank() && activeCallId != expectedCallId) return@synchronized
        preferences.edit()
            .remove(KEY_ACTIVE_CALL_ID)
            .remove(KEY_ACTIVE_CALL_DIRECTION)
            .remove(KEY_ACTIVE_CALL_DIAL_ISSUED)
            .commit()
        Unit
    }

    /**
     * Remove only peer-scoped state. The Firebase account and Android device
     * registration intentionally survive so onboarding can create a new QR
     * without unexpectedly signing the user out.
     */
    fun clearPairing() = synchronized(commandLock) {
        pairings().forEach { secureSecretStore.put(pairingSecretKey(it.id), "") }
        preferences.edit()
            .remove(KEY_PAIRING_ID)
            .remove(KEY_PAIRING_SECRET)
            .remove(KEY_PAIRING_CONFIRMED)
            .remove(KEY_PAIRINGS)
            .remove(KEY_PENDING_REMOTE_COMMANDS)
            .remove(KEY_PROCESSED_REMOTE_COMMANDS)
            .remove(KEY_ACTIVE_CALL_ID)
            .remove(KEY_ACTIVE_CALL_DIRECTION)
            .remove(KEY_ACTIVE_CALL_DIAL_ISSUED)
            .putBoolean(KEY_RELAY_READY_DESIRED, false)
            .commit()
        secureSecretStore.put("")
        Unit
    }

    private fun migrateLegacyPairing() = synchronized(commandLock) {
        if (preferences.contains(KEY_PAIRINGS)) return@synchronized
        val id = preferences.getString(KEY_PAIRING_ID, "").orEmpty()
        val secret = secureSecretStore.get()
            ?: preferences.getString(KEY_PAIRING_SECRET, "").orEmpty()
        if (id.isBlank() || secret.isBlank()) {
            preferences.edit().putString(KEY_PAIRINGS, "[]").apply()
            return@synchronized
        }
        secureSecretStore.put(pairingSecretKey(id), secret)
        savePairingMetadata(listOf(PairingRecord(
            id = id,
            secret = secret,
            confirmed = preferences.getBoolean(KEY_PAIRING_CONFIRMED, false),
        )))
        preferences.edit().remove(KEY_PAIRING_SECRET).apply()
    }

    private fun savePairingMetadata(records: List<PairingRecord>) {
        val array = JSONArray()
        records.distinctBy(PairingRecord::id).forEach { record ->
            array.put(JSONObject()
                .put("id", record.id)
                .put("confirmed", record.confirmed)
                .put("peerDeviceId", record.peerDeviceId)
                .put("peerPlatform", record.peerPlatform))
        }
        preferences.edit().putString(KEY_PAIRINGS, array.toString()).commit()
    }

    private fun pairingSecretKey(pairingId: String): String = "pairing_secret_v2_$pairingId"

    private fun processedCommandIds(): List<String> = preferences.getString(KEY_PROCESSED_REMOTE_COMMANDS, "")
        .orEmpty().lineSequence().filter(String::isNotBlank).toList()

    private fun savePendingCommands(commands: List<RemoteCommand>): Boolean =
        preferences.edit().putString(KEY_PENDING_REMOTE_COMMANDS, encodeCommands(commands)).commit()

    private fun encodeCommands(commands: List<RemoteCommand>): String {
        val array = JSONArray()
        commands.forEach { command ->
            array.put(
                JSONObject()
                    .put("id", command.id)
                    .put("type", command.type)
                    .put("event", command.event)
                    .put("callId", command.callId)
                    .put("pairingId", command.pairingId)
                    .put("phoneNumber", command.phoneNumber)
                    .put("digit", command.digit)
                    .put("muted", command.muted)
                    .put("callVersion", command.callVersion)
                    .put("createdAt", command.createdAt),
            )
        }
        return array.toString()
    }

    private fun clearEnvironmentIdentity() {
        pairings().forEach { secureSecretStore.put(pairingSecretKey(it.id), "") }
        preferences.edit()
            .remove(KEY_DEVICE_ID)
            .remove(KEY_PAIRING_ID)
            .remove(KEY_PAIRING_SECRET)
            .remove(KEY_PAIRING_CONFIRMED)
            .remove(KEY_PAIRINGS)
            .remove(KEY_PENDING_REMOTE_COMMANDS)
            .remove(KEY_PROCESSED_REMOTE_COMMANDS)
            .remove(KEY_ACTIVE_CALL_ID)
            .remove(KEY_ACTIVE_CALL_DIRECTION)
            .remove(KEY_ACTIVE_CALL_DIAL_ISSUED)
            .putBoolean(KEY_RELAY_READY_DESIRED, false)
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
        private const val KEY_PAIRINGS = "pairings_v2"
        private const val KEY_PHONE_ACCOUNT = "phone_account"
        private const val KEY_SIM_PROFILE_UPLOADED = "sim_profile_uploaded"
        private const val KEY_ACCOUNT_EMAIL = "account_email"
        private const val KEY_ENTITLEMENT_ACTIVE = "entitlement_active"
        private const val KEY_CAPTURE_GAIN = "capture_gain"
        private const val KEY_PLAYBACK_GAIN = "playback_gain"
        private const val KEY_RELAY_READY_DESIRED = "relay_ready_desired"
        private const val KEY_ACTIVE_CALL_ID = "active_call_id"
        private const val KEY_ACTIVE_CALL_DIRECTION = "active_call_direction"
        private const val KEY_ACTIVE_CALL_GENERATION = "active_call_generation"
        private const val KEY_ACTIVE_CALL_DIAL_ISSUED = "active_call_dial_issued"
        private const val KEY_PENDING_REMOTE_COMMANDS = "pending_remote_commands"
        private const val KEY_PROCESSED_REMOTE_COMMANDS = "processed_remote_commands"
        private const val MAX_PENDING_COMMANDS = 32
        private const val MAX_PROCESSED_COMMANDS = 128
        private const val DEFAULT_PLAYBACK_GAIN = 1.35
        private val OFFICIAL_API_ORIGINS = setOf(
            "https://call-relay-staging.zamadshakil.workers.dev",
            "https://call-relay.zamadshakil.workers.dev",
        )
        private val commandLock = Any()
    }
}
