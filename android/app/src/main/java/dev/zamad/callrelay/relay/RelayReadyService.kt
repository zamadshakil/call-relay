package dev.zamad.callrelay.relay

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import dev.zamad.callrelay.MainActivity
import dev.zamad.callrelay.crypto.CallKeyDeriver
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.telecom.NumberPolicy
import dev.zamad.callrelay.telecom.RelayInCallService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class RelayReadyService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var preferences: RelayPreferences
    private lateinit var api: RelayApiClient
    private lateinit var media: LiveKitRelaySession
    private var watchdog: Job? = null
    private var setupJob: Job? = null
    private var setupGeneration = 0L
    private var activeReportJob: Job? = null
    private var activeReportedCallId: String? = null
    private var mediaExpected = false
    private var mediaLostAt: Long? = null
    private var lastHeartbeatAt = 0L

    override fun onCreate() {
        super.onCreate()
        preferences = RelayPreferences(this)
        api = RelayApiClient(preferences)
        media = LiveKitRelaySession(this, preferences)
        createNotificationChannel()
        watchdog = scope.launch {
            while (isActive) {
                media.refreshRemoteVolume()
                enforceMediaWatchdog()
                sendHeartbeatIfDue()
                delay(1_000)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> arm()
            ACTION_STOP -> disarm()
            ACTION_INCOMING -> ifReady { beginIncoming() }
            ACTION_OUTGOING -> ifReady {
                beginOutgoing(
                    callId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty(),
                    number = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty(),
                )
            }
            ACTION_ACCEPT -> ifReady { acceptIncoming(intent.getStringExtra(EXTRA_CALL_ID)) }
            ACTION_CALL_ACTIVE -> ifReady { callBecameActive() }
            ACTION_END -> ifReady {
                val requestedCallId = intent.getStringExtra(EXTRA_CALL_ID)
                if (requestedCallId.isNullOrBlank() || isCurrentCall(requestedCallId)) endRelay(remoteRequest = !requestedCallId.isNullOrBlank())
            }
            ACTION_SET_MODE -> ifReady {
                val requestedCallId = intent.getStringExtra(EXTRA_CALL_ID)
                if (requestedCallId.isNullOrBlank() || isCurrentCall(requestedCallId)) {
                    val next = RelayMode.fromWire(intent.getStringExtra(EXTRA_MODE))
                    scope.launch {
                        media.applyMode(next)
                        if (requestedCallId.isNullOrBlank()) {
                            RelayRuntime.snapshot().callId?.let { runCatching { api.event(it, next.wireValue) } }
                        }
                    }
                }
            }
            ACTION_DTMF -> ifReady {
                if (isCurrentCall(intent.getStringExtra(EXTRA_CALL_ID))) RelayInCallService.sendDtmf(intent.getStringExtra(EXTRA_DTMF).orEmpty())
            }
            ACTION_MUTE -> ifReady {
                if (isCurrentCall(intent.getStringExtra(EXTRA_CALL_ID))) {
                    val muted = intent.getStringExtra(EXTRA_MUTED)?.toBooleanStrictOrNull()
                    if (muted == null) {
                        RelayRuntime.update { it.copy(error = "Invalid mute command") }
                    } else {
                        scope.launch { media.setMuted(muted) }
                    }
                }
            }
            ACTION_CONNECT -> ifReady {
                scope.launch {
                    runCatching {
                        connectMedia(
                            callId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty(),
                            serverUrl = intent.getStringExtra(EXTRA_SERVER_URL).orEmpty(),
                            token = intent.getStringExtra(EXTRA_TOKEN).orEmpty(),
                        )
                    }.onFailure(::reportFailure)
                }
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        watchdog?.cancel()
        invalidateSetup()
        activeReportJob?.cancel()
        media.disconnect()
        scope.cancel()
        RelayRuntime.update { RelayRuntime.Snapshot() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun arm() {
        startForeground(NOTIFICATION_ID, notification("Ready for one paired peer"))
        RelayRuntime.update { it.copy(ready = true, error = null) }
    }

    private fun disarm() {
        invalidateSetup()
        activeReportJob?.cancel()
        activeReportJob = null
        activeReportedCallId = null
        mediaExpected = false
        media.disconnect()
        RelayRuntime.update { it.copy(ready = false, callId = null) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ifReady(action: () -> Unit) {
        if (!RelayRuntime.snapshot().ready) {
            RelayRuntime.update { it.copy(error = "Relay Ready is off; remote request ignored") }
            stopSelf()
            return
        }
        action()
    }

    private fun beginIncoming() {
        if (!preferences.configured()) {
            RelayRuntime.update { it.copy(error = "Enroll and pair this Android before relaying") }
            return
        }
        if (RelayRuntime.snapshot().callId != null) return
        val generation = nextSetupGeneration()
        setupJob = scope.launch {
            var createdCallId: String? = null
            runCatching {
                check(RelayInCallService.activeCallCount() == 1) { "The cellular call ended before relay setup" }
                val call = api.createIncomingCall()
                createdCallId = call.callId
                checkSetupIsCurrent(generation)
                check(RelayInCallService.activeCallCount() == 1) { "The cellular call ended before relay setup" }
                activeReportedCallId = null
                RelayRuntime.update { it.copy(callId = call.callId, mediaState = "Fetching room token") }
                val credentials = api.token(call.callId)
                checkSetupIsCurrent(generation)
                check(RelayInCallService.activeCallCount() == 1) { "The cellular call ended before relay setup" }
                connectMedia(call.callId, credentials.serverUrl, credentials.participantToken)
                checkSetupIsCurrent(generation)
            }.onFailure { failure ->
                if (failure is CancellationException) {
                    createdCallId?.let { cancelledCallId ->
                        kotlinx.coroutines.withContext(NonCancellable) {
                            runCatching { api.event(cancelledCallId, "failed", "android_setup_cancelled") }
                        }
                    }
                    return@onFailure
                }
                createdCallId?.let { runCatching { api.event(it, "failed", "android_media_setup_failed") } }
                mediaExpected = false
                media.disconnect()
                if (generation == setupGeneration) RelayRuntime.update { it.copy(callId = null) }
                reportFailure(failure)
            }
            if (generation == setupGeneration) setupJob = null
        }
    }

    private fun beginOutgoing(callId: String, number: String) {
        if (callId.isBlank() || RelayRuntime.snapshot().callId != null) return
        val generation = nextSetupGeneration()
        activeReportedCallId = null
        RelayRuntime.update { it.copy(callId = callId, mediaState = "Validating outgoing request") }
        setupJob = scope.launch {
            runCatching {
                validateOutgoing(number)
                checkSetupIsCurrent(generation)
                RelayRuntime.update { it.copy(callId = callId, mediaState = "Fetching room token") }
                val credentials = api.token(callId)
                checkSetupIsCurrent(generation)
                connectMedia(callId, credentials.serverUrl, credentials.participantToken)
                checkSetupIsCurrent(generation)
                awaitPairedPeer(generation)
                placeCellularCall(number)
            }.onFailure { failure ->
                if (failure is CancellationException) return@onFailure
                runCatching { api.event(callId, "failed", "android_dial_rejected") }
                mediaExpected = false
                media.disconnect()
                if (generation == setupGeneration) RelayRuntime.update { it.copy(callId = null) }
                reportFailure(failure)
            }
            if (generation == setupGeneration) setupJob = null
        }
    }

    private fun acceptIncoming(requestedCallId: String?) {
        val activeCallId = RelayRuntime.snapshot().callId
        if (requestedCallId != null && activeCallId != null && requestedCallId != activeCallId) return
        RelayInCallService.answer()
        RelayInCallService.routeCurrentCallToSpeaker()
        if (RelayInCallService.isActive()) callBecameActive()
    }

    private fun callBecameActive() {
        val callId = RelayRuntime.snapshot().callId ?: return
        RelayInCallService.routeCurrentCallToSpeaker()
        if (activeReportedCallId == callId || activeReportJob?.isActive == true) return
        activeReportJob = scope.launch {
            runCatching { api.event(callId, "active") }
                .onSuccess { activeReportedCallId = callId }
                .onFailure { failure ->
                    if (failure !is CancellationException) reportFailure(failure)
                }
            activeReportJob = null
        }
    }

    private suspend fun connectMedia(callId: String, serverUrl: String, token: String) {
        if (callId.isBlank() || serverUrl.isBlank() || token.isBlank()) {
            RelayRuntime.update { it.copy(error = "Missing call media credentials") }
            error("Missing call media credentials")
        }
        val passphrase = CallKeyDeriver.derivePassphrase(preferences.pairingSecret, callId)
        mediaExpected = true
        try {
            media.connect(serverUrl, token, passphrase)
            media.applyMode(RelayRuntime.snapshot().mode)
            updateNotification("Media connected; waiting for paired peer")
        } catch (failure: Throwable) {
            mediaExpected = false
            throw failure
        }
    }

    private fun endRelay(remoteRequest: Boolean) {
        val callId = RelayRuntime.snapshot().callId
        invalidateSetup()
        activeReportJob?.cancel()
        activeReportJob = null
        activeReportedCallId = null
        if (remoteRequest) RelayInCallService.disconnect()
        mediaExpected = false
        mediaLostAt = null
        lastHeartbeatAt = 0L
        media.disconnect()
        RelayRuntime.update { it.copy(callId = null, mediaState = "Disconnected") }
        if (callId != null) scope.launch { runCatching { api.event(callId, "end") } }
        updateNotification("Ready for one paired peer")
    }

    private suspend fun enforceMediaWatchdog() {
        val cellularActive = RelayInCallService.isActive()
        if (!mediaExpected || !cellularActive || media.isPeerConnected()) {
            mediaLostAt = null
            return
        }
        val now = System.currentTimeMillis()
        val lostAt = mediaLostAt ?: now.also { mediaLostAt = it }
        if (now - lostAt >= MEDIA_LOSS_TIMEOUT_MS) {
            RelayRuntime.update { it.copy(error = "Internet media unavailable for 15 seconds; ending SIM call") }
            val callId = RelayRuntime.snapshot().callId
            RelayInCallService.disconnect()
            mediaExpected = false
            media.disconnect()
            if (callId != null) runCatching { api.event(callId, "failed", "media_timeout") }
        }
    }

    private suspend fun sendHeartbeatIfDue() {
        val callId = RelayRuntime.snapshot().callId ?: return
        if (!mediaExpected || !media.isPeerConnected()) return
        if (RelayInCallService.isActive() && activeReportedCallId != callId) {
            callBecameActive()
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return
        lastHeartbeatAt = now
        runCatching { api.event(callId, "media_heartbeat") }
            .onFailure { lastHeartbeatAt = 0L }
    }

    private fun isCurrentCall(requestedCallId: String?): Boolean {
        val currentCallId = RelayRuntime.snapshot().callId
        return !requestedCallId.isNullOrBlank() && currentCallId != null && requestedCallId == currentCallId
    }

    private fun nextSetupGeneration(): Long {
        invalidateSetup()
        return setupGeneration
    }

    private fun invalidateSetup() {
        setupGeneration += 1
        setupJob?.cancel()
        setupJob = null
    }

    private fun checkSetupIsCurrent(generation: Long) {
        if (generation != setupGeneration) throw CancellationException("Call setup was cancelled")
    }

    private suspend fun awaitPairedPeer(generation: Long) {
        val deadline = SystemClock.elapsedRealtime() + PEER_JOIN_TIMEOUT_MS
        while (!media.isPeerConnected()) {
            checkSetupIsCurrent(generation)
            check(SystemClock.elapsedRealtime() < deadline) { "Paired peer did not join; the SIM call was not placed" }
            delay(100)
        }
    }

    private fun validateOutgoing(number: String) {
        NumberPolicy.rejectionReason(number)?.let { error(it) }
        val telephony = getSystemService(TelephonyManager::class.java)
        check(!telephony.isEmergencyNumber(number)) { "Emergency numbers are blocked from relay" }
        check(RelayInCallService.activeCallCount() == 0) { "Only one cellular call is allowed" }
        check(checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED) {
            "Phone permission is not granted"
        }
        val telecom = getSystemService(TelecomManager::class.java)
        val accounts = if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) == PackageManager.PERMISSION_GRANTED) {
            telecom.callCapablePhoneAccounts
        } else {
            emptyList()
        }
        check(accounts.isNotEmpty()) { "No call-capable SIM is available" }
        check(accounts.size == 1 || selectedPhoneAccount(telecom) != null) { "Select exactly one SIM before remote dialing" }
    }

    private fun placeCellularCall(number: String) {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("Phone permission was revoked")
        }
        val telecom = getSystemService(TelecomManager::class.java)
        val extras = Bundle()
        selectedPhoneAccount(telecom)?.let { extras.putParcelable(TelecomManager.EXTRA_PHONE_ACCOUNT_HANDLE, it) }
        telecom.placeCall(Uri.fromParts("tel", number, null), extras)
    }

    private fun selectedPhoneAccount(telecom: TelecomManager): PhoneAccountHandle? {
        if (checkSelfPermission(Manifest.permission.READ_PHONE_STATE) != PackageManager.PERMISSION_GRANTED) {
            return null
        }
        val accounts = telecom.callCapablePhoneAccounts
        val selected = preferences.selectedPhoneAccount
        return accounts.firstOrNull { accountKey(it) == selected } ?: accounts.singleOrNull()
    }

    private fun accountKey(handle: PhoneAccountHandle): String =
        "${handle.componentName.flattenToString()}|${handle.id}"

    private fun reportFailure(failure: Throwable) {
        RelayRuntime.update { it.copy(error = failure.message ?: failure::class.java.simpleName) }
        updateNotification("Relay error — open app for details")
    }

    private fun createNotificationChannel() {
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Relay Ready", NotificationManager.IMPORTANCE_LOW),
        )
    }

    private fun notification(text: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Call Relay is ready")
            .setContentText(text)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .build()
    }

    private fun updateNotification(text: String) {
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION_ID, notification(text))
    }

    companion object {
        const val ACTION_START = "dev.zamad.callrelay.action.START_READY"
        const val ACTION_STOP = "dev.zamad.callrelay.action.STOP_READY"
        const val ACTION_INCOMING = "dev.zamad.callrelay.action.INCOMING"
        const val ACTION_OUTGOING = "dev.zamad.callrelay.action.OUTGOING"
        const val ACTION_ACCEPT = "dev.zamad.callrelay.action.ACCEPT"
        const val ACTION_CALL_ACTIVE = "dev.zamad.callrelay.action.CALL_ACTIVE"
        const val ACTION_END = "dev.zamad.callrelay.action.END"
        const val ACTION_SET_MODE = "dev.zamad.callrelay.action.SET_MODE"
        const val ACTION_CONNECT = "dev.zamad.callrelay.action.CONNECT"
        const val ACTION_DTMF = "dev.zamad.callrelay.action.DTMF"
        const val ACTION_MUTE = "dev.zamad.callrelay.action.MUTE"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_PHONE_NUMBER = "phone_number"
        const val EXTRA_MODE = "mode"
        const val EXTRA_SERVER_URL = "server_url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_DTMF = "dtmf"
        const val EXTRA_MUTED = "muted"
        private const val CHANNEL_ID = "relay-ready"
        private const val NOTIFICATION_ID = 2001
        private const val MEDIA_LOSS_TIMEOUT_MS = 15_000L
        private const val PEER_JOIN_TIMEOUT_MS = 20_000L
        private const val HEARTBEAT_INTERVAL_MS = 10_000L
    }
}
