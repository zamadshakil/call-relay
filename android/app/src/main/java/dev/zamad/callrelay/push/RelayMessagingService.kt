package dev.zamad.callrelay.push

import android.annotation.SuppressLint
import android.content.Intent
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
        if (!preferences.claimRemoteCommand(commandId)) return
        if (!RelayRuntime.snapshot().ready) {
            if (callId.isNotBlank() && preferences.configured()) {
                RelaySyncWorker.enqueueFailure(this, callId, "relay_not_ready")
            }
            return
        }
        val action = when (data["type"]) {
            "outgoing_call" -> RelayReadyService.ACTION_OUTGOING
            "call_event" -> when (data["event"]) {
                "accept" -> RelayReadyService.ACTION_ACCEPT
                "end", "reject", "failed" -> RelayReadyService.ACTION_END
                "full_duplex", "listen", "talk" -> RelayReadyService.ACTION_SET_MODE
                "dtmf" -> RelayReadyService.ACTION_DTMF
                "mute" -> RelayReadyService.ACTION_MUTE
                else -> return
            }
            else -> return
        }
        runCatching {
            startService(Intent(this, RelayReadyService::class.java)
                .setAction(action)
                .putExtra(RelayReadyService.EXTRA_CALL_ID, callId)
                .putExtra(RelayReadyService.EXTRA_PHONE_NUMBER, data["phoneNumber"])
                .putExtra(RelayReadyService.EXTRA_MODE, data["event"])
                .putExtra(RelayReadyService.EXTRA_DTMF, data["digit"])
                .putExtra(RelayReadyService.EXTRA_MUTED, data["muted"]))
        }.onFailure {
            if (callId.isNotBlank() && preferences.configured()) {
                RelaySyncWorker.enqueueFailure(this, callId, "relay_dispatch_failed")
            }
        }
    }

    companion object {
        const val ACTION_PAIRING_CHANGED = "dev.zamad.callrelay.PAIRING_CHANGED"
        const val ACTION_ENTITLEMENT_CHANGED = "dev.zamad.callrelay.ENTITLEMENT_CHANGED"
    }
}
