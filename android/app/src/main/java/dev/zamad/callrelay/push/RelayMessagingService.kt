package dev.zamad.callrelay.push

import android.annotation.SuppressLint
import android.content.Intent
import androidx.core.content.ContextCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import dev.zamad.callrelay.relay.RelayReadyService
import dev.zamad.callrelay.relay.RelayPreferences
import dev.zamad.callrelay.relay.RelayRuntime

class RelayMessagingService : FirebaseMessagingService() {
    @SuppressLint("MissingFirebaseInstanceTokenRefresh")
    override fun onRegistered(installationId: String) {
        val preferences = RelayPreferences(this)
        preferences.fcmToken = installationId
        if (preferences.apiBaseUrl.startsWith("https://") && preferences.deviceId.isNotBlank()) {
            RelaySyncWorker.enqueuePushToken(this, installationId)
        }
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        val preferences = RelayPreferences(this)
        if (data["type"] == "entitlement_changed") {
            preferences.entitlementActive = data["status"] == "active"
            if (!preferences.entitlementActive && RelayRuntime.snapshot().callId == null) {
                preferences.relayReadyDesired = false
                stopService(Intent(this, RelayReadyService::class.java))
            }
            sendBroadcast(Intent(ACTION_ENTITLEMENT_CHANGED).setPackage(packageName))
            return
        }
        if (data["type"] == "pairing_invitation_consumed") {
            sendBroadcast(Intent(ACTION_PAIRING_CHANGED).setPackage(packageName))
            return
        }
        val callId = data["callId"].orEmpty()
        val commandId = data["commandId"] ?: "${data["type"]}:${data["event"]}:$callId"
        val type = data["type"].orEmpty()
        val event = data["event"].orEmpty()
        if (type != "outgoing_call" && type != "call_event") return
        if (type == "call_event" && event !in SUPPORTED_CALL_EVENTS) return
        val persisted = preferences.enqueueRemoteCommand(
            RelayPreferences.RemoteCommand(
                id = commandId,
                type = type,
                event = event,
                callId = callId,
                pairingId = data["pairingId"].orEmpty(),
                phoneNumber = data["phoneNumber"].orEmpty(),
                digit = data["digit"].orEmpty(),
                muted = data["muted"].orEmpty(),
                callVersion = data["callVersion"]?.toLongOrNull() ?: 0L,
                createdAt = System.currentTimeMillis(),
            ),
        )
        if (!persisted) return
        runCatching {
            ContextCompat.startForegroundService(
                this,
                Intent(this, RelayReadyService::class.java).setAction(RelayReadyService.ACTION_PROCESS_COMMANDS),
            )
        }.onFailure {
            // The command remains durable and is drained when Relay Ready next starts.
            sendBroadcast(Intent(ACTION_RELAY_WAKE_FAILED).setPackage(packageName))
        }
    }

    companion object {
        const val ACTION_PAIRING_CHANGED = "dev.zamad.callrelay.PAIRING_CHANGED"
        const val ACTION_ENTITLEMENT_CHANGED = "dev.zamad.callrelay.ENTITLEMENT_CHANGED"
        const val ACTION_RELAY_WAKE_FAILED = "dev.zamad.callrelay.RELAY_WAKE_FAILED"
        private val SUPPORTED_CALL_EVENTS = setOf(
            "accept", "end", "reject", "failed", "full_duplex", "listen", "talk", "dtmf", "mute",
        )
    }
}
