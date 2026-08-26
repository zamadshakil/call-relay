package dev.zamad.callrelay.telecom

import android.os.Build
import android.os.OutcomeReceiver
import android.os.Handler
import android.os.Looper
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.telecom.Call
import android.telecom.CallAudioState
import android.telecom.CallEndpoint
import android.telecom.CallEndpointException
import android.telecom.InCallService
import android.content.Intent
import dev.zamad.callrelay.MainActivity
import dev.zamad.callrelay.R
import dev.zamad.callrelay.relay.RelayReadyService
import dev.zamad.callrelay.relay.RelayPreferences
import dev.zamad.callrelay.relay.RelayRuntime
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

@Suppress("DEPRECATION", "OVERRIDE_DEPRECATION")
class RelayInCallService : InCallService() {
    private val availableEndpoints = mutableListOf<CallEndpoint>()
    private val callbacks = ConcurrentHashMap<Call, Call.Callback>()
    private val relayEligibleCalls = ConcurrentHashMap.newKeySet<Call>()

    override fun onCreate() {
        super.onCreate()
        serviceInstance.set(this)
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CALL_CHANNEL_ID, "Cellular calls", NotificationManager.IMPORTANCE_HIGH),
        )
    }

    override fun onDestroy() {
        serviceInstance.compareAndSet(this, null)
        super.onDestroy()
    }

    override fun onCallAdded(call: Call) {
        super.onCallAdded(call)
        if (RelayRuntime.snapshot().ready && activeCalls.any { it.state != Call.STATE_DISCONNECTED }) {
            RelayRuntime.update { it.copy(error = "Call waiting and conference calls are blocked while Relay Ready is on") }
            call.disconnect()
            return
        }
        if (RelayRuntime.snapshot().ready && isSelectedPhoneAccount(call)) relayEligibleCalls.add(call)
        val callback = object : Call.Callback() {
            override fun onStateChanged(changedCall: Call, state: Int) {
                currentCall.set(changedCall)
                callState.set(stateName(state))
                RelayRuntime.update { it.copy(callState = stateName(state)) }
                showCallNotification(changedCall)
                if (RelayRuntime.snapshot().ready && changedCall in relayEligibleCalls && state == Call.STATE_ACTIVE) {
                    routeToSpeaker()
                    notifyRelay(RelayReadyService.ACTION_CALL_ACTIVE)
                }
            }

            override fun onDetailsChanged(changedCall: Call, details: Call.Details) {
                if (RelayRuntime.snapshot().ready && isSelectedPhoneAccount(changedCall)) {
                    relayEligibleCalls.add(changedCall)
                }
                showCallNotification(changedCall)
            }

        }
        callbacks[call] = callback
        activeCalls.addIfAbsent(call)
        currentCall.set(call)
        callState.set(stateName(call.state))
        RelayRuntime.update { it.copy(callState = stateName(call.state)) }
        call.registerCallback(callback)
        showCallNotification(call)
        if (RelayRuntime.snapshot().ready && call in relayEligibleCalls && call.state == Call.STATE_RINGING) {
            notifyRelay(RelayReadyService.ACTION_INCOMING)
        }
    }

    override fun onCallRemoved(call: Call) {
        val wasRelayEligible = relayEligibleCalls.remove(call)
        callbacks.remove(call)?.let(call::unregisterCallback)
        getSystemService(NotificationManager::class.java).cancel(CALL_NOTIFICATION_ID)
        activeCalls.remove(call)
        if (currentCall.compareAndSet(call, activeCalls.lastOrNull())) {
            callState.set(activeCalls.lastOrNull()?.let { stateName(it.state) } ?: "No call")
        }
        RelayRuntime.update { it.copy(callState = callState.get()) }
        if (RelayRuntime.snapshot().ready && wasRelayEligible && relayEligibleCalls.isEmpty()) {
            notifyRelay(RelayReadyService.ACTION_END)
        }
        super.onCallRemoved(call)
    }

    private fun notifyRelay(action: String) {
        startService(Intent(this, RelayReadyService::class.java).setAction(action))
    }

    private fun showCallNotification(call: Call) {
        val state = call.state
        if (state == Call.STATE_DISCONNECTED) return
        val openApp = PendingIntent.getActivity(
            this,
            10,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val answer = PendingIntent.getBroadcast(
            this,
            11,
            Intent(this, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_ANSWER),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val end = PendingIntent.getBroadcast(
            this,
            12,
            Intent(this, CallActionReceiver::class.java).setAction(CallActionReceiver.ACTION_END),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = Notification.Builder(this, CALL_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_call_relay)
            .setContentTitle(if (state == Call.STATE_RINGING) "Incoming cellular call" else "Cellular call")
            .setContentText(stateName(state))
            .setCategory(Notification.CATEGORY_CALL)
            .setContentIntent(openApp)
            .setOngoing(true)
            .setFullScreenIntent(openApp, state == Call.STATE_RINGING)
            .addAction(Notification.Action.Builder(null, "End", end).build())
        if (state == Call.STATE_RINGING) {
            builder.addAction(Notification.Action.Builder(null, "Answer", answer).build())
        }
        getSystemService(NotificationManager::class.java).notify(CALL_NOTIFICATION_ID, builder.build())
    }

    private fun isSelectedPhoneAccount(call: Call): Boolean {
        val selected = RelayPreferences(this).selectedPhoneAccount
        if (selected.isBlank()) return true
        val account = call.details.accountHandle ?: return false
        return "${account.componentName.flattenToString()}|${account.id}" == selected
    }

    @Suppress("DEPRECATION")
    override fun onCallAudioStateChanged(audioState: CallAudioState) {
        super.onCallAudioStateChanged(audioState)
        audioRoute.set(routeName(audioState.route))
        if (
            RelayRuntime.snapshot().ready && currentCallIsRelayEligible() &&
            Build.VERSION.SDK_INT < 34 && audioState.route != CallAudioState.ROUTE_SPEAKER
        ) {
            setAudioRoute(CallAudioState.ROUTE_SPEAKER)
        }
    }

    override fun onAvailableCallEndpointsChanged(endpoints: MutableList<CallEndpoint>) {
        super.onAvailableCallEndpointsChanged(endpoints)
        availableEndpoints.clear()
        availableEndpoints.addAll(endpoints)
        if (RelayRuntime.snapshot().ready && currentCallIsRelayEligible()) routeToSpeaker()
    }

    @android.annotation.TargetApi(34)
    override fun onCallEndpointChanged(callEndpoint: CallEndpoint) {
        super.onCallEndpointChanged(callEndpoint)
        audioRoute.set(endpointName(callEndpoint.endpointType))
    }

    private fun currentCallIsRelayEligible(): Boolean = currentCall.get()?.let(relayEligibleCalls::contains) == true

    @Suppress("DEPRECATION")
    fun routeToSpeaker() {
        if (Build.VERSION.SDK_INT >= 34) {
            val speaker = availableEndpoints.firstOrNull {
                it.endpointType == CallEndpoint.TYPE_SPEAKER
            } ?: return

            requestCallEndpointChange(
                speaker,
                mainExecutor,
                object : OutcomeReceiver<Void?, CallEndpointException> {
                    override fun onResult(result: Void?) {
                        audioRoute.set("Speaker")
                    }

                    override fun onError(error: CallEndpointException) {
                        audioRoute.set("Speaker request failed (${error.code})")
                    }
                },
            )
        } else {
            setAudioRoute(CallAudioState.ROUTE_SPEAKER)
        }
    }

    companion object {
        private const val CALL_CHANNEL_ID = "cellular-call"
        private const val CALL_NOTIFICATION_ID = 3001
        private val currentCall = AtomicReference<Call?>(null)
        private val activeCalls = CopyOnWriteArrayList<Call>()
        private val callState = AtomicReference("No call")
        private val audioRoute = AtomicReference("Unknown")
        private val serviceInstance = AtomicReference<RelayInCallService?>(null)

        fun activeCall(): Call? = currentCall.get()
        fun callState(): String = callState.get()
        fun audioRoute(): String = audioRoute.get()
        fun activeCallCount(): Int = activeCalls.count {
            it.state != Call.STATE_DISCONNECTED
        }
        fun isActive(): Boolean = currentCall.get()?.state == Call.STATE_ACTIVE

        fun answer() {
            val call = currentCall.get() ?: return
            call.answer(call.details.videoState)
        }

        fun disconnect() {
            currentCall.get()?.disconnect()
        }

        fun routeCurrentCallToSpeaker() {
            serviceInstance.get()?.routeToSpeaker()
        }

        fun sendDtmf(value: String) {
            val digit = value.singleOrNull()?.takeIf { it in "0123456789*#" } ?: return
            val call = currentCall.get() ?: return
            call.playDtmfTone(digit)
            Handler(Looper.getMainLooper()).postDelayed({ call.stopDtmfTone() }, 140)
        }

        private fun stateName(state: Int): String = when (state) {
            Call.STATE_NEW -> "New"
            Call.STATE_DIALING -> "Dialing"
            Call.STATE_RINGING -> "Ringing"
            Call.STATE_HOLDING -> "Holding"
            Call.STATE_ACTIVE -> "Active"
            Call.STATE_DISCONNECTED -> "Disconnected"
            Call.STATE_CONNECTING -> "Connecting"
            Call.STATE_DISCONNECTING -> "Disconnecting"
            Call.STATE_SELECT_PHONE_ACCOUNT -> "Choose SIM"
            else -> "State $state"
        }

        private fun routeName(route: Int): String = when (route) {
            CallAudioState.ROUTE_EARPIECE -> "Earpiece"
            CallAudioState.ROUTE_BLUETOOTH -> "Bluetooth"
            CallAudioState.ROUTE_SPEAKER -> "Speaker"
            CallAudioState.ROUTE_WIRED_HEADSET -> "Wired headset"
            else -> "Route $route"
        }

        private fun endpointName(type: Int): String = when (type) {
            CallEndpoint.TYPE_EARPIECE -> "Earpiece"
            CallEndpoint.TYPE_BLUETOOTH -> "Bluetooth"
            CallEndpoint.TYPE_SPEAKER -> "Speaker"
            CallEndpoint.TYPE_WIRED_HEADSET -> "Wired headset"
            CallEndpoint.TYPE_STREAMING -> "Streaming"
            else -> "Endpoint $type"
        }
    }
}
