package dev.zamad.callrelay.relay

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Bundle
import android.os.IBinder
import android.os.SystemClock
import android.telecom.PhoneAccountHandle
import android.telecom.TelecomManager
import android.telephony.TelephonyManager
import dev.zamad.callrelay.MainActivity
import dev.zamad.callrelay.R
import dev.zamad.callrelay.network.PairingSignalClient
import dev.zamad.callrelay.network.PairingSignalHub
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.telecom.NumberPolicy
import dev.zamad.callrelay.telecom.RelayInCallService
import java.util.UUID
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

class RelayReadyService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private lateinit var preferences: RelayPreferences
    private lateinit var api: RelayApiClient
    private lateinit var media: WebRtcRelaySession
    private lateinit var signal: PairingSignalHub
    private lateinit var connectivity: ConnectivityManager
    private var watchdog: Job? = null
    private var setupJob: Job? = null
    private var restoreJob: Job? = null
    private val incomingAnswerJobs = IncomingAnswerJobSlot()
    private val incomingAnswerGate = IncomingAnswerGate()
    private val callLifecycleBarrier = CallLifecycleBarrier()
    private var setupGeneration = 0L
    private var activeReportJob: Job? = null
    private var activeReportedCallId: String? = null
    private var mediaExpected = false
    private var mediaLostAt: Long? = null
    private var lastHeartbeatAt = 0L
    private var lastDeviceHeartbeatAt = 0L
    @Volatile private var signalState = "Disconnected"
    @Volatile private var lastErrorCode: String? = null
    private var commandDrainJob: Job? = null
    private var serviceArmed = false
    private val remoteCommandsInFlight = mutableSetOf<String>()

    override fun onCreate() {
        super.onCreate()
        preferences = RelayPreferences(this)
        api = RelayApiClient(preferences)
        signal = PairingSignalHub(preferences, api, signalListener)
        media = WebRtcRelaySession(this, preferences, api, signal, mediaListener)
        connectivity = getSystemService(ConnectivityManager::class.java)
        connectivity.registerDefaultNetworkCallback(networkCallback)
        createNotificationChannel()
        watchdog = scope.launch {
            while (isActive) {
                enforceMediaWatchdog()
                sendDeviceHeartbeatIfDue()
                sendHeartbeatIfDue()
                delay(1_000)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                preferences.relayReadyDesired = true
                arm()
            }
            ACTION_STOP -> disarm()
            ACTION_PROCESS_COMMANDS -> {
                ensureForeground()
                if (preferences.relayReadyDesired) {
                    arm()
                }
                drainRemoteCommands()
            }
            ACTION_INCOMING -> ifReady { beginIncoming() }
            ACTION_OUTGOING -> ifReady {
                beginOutgoing(
                    callId = intent.getStringExtra(EXTRA_CALL_ID).orEmpty(),
                    number = intent.getStringExtra(EXTRA_PHONE_NUMBER).orEmpty(),
                )
            }
            ACTION_ACCEPT -> ifReady { acceptIncoming(intent.getStringExtra(EXTRA_CALL_ID)) }
            ACTION_CALL_ACTIVE -> ifReady { callBecameActive() }
            ACTION_END -> {
                // Terminal cleanup must remain available even if entitlement,
                // pairing, or the in-memory runtime changed while a call was
                // active. A foreground-service wake still has to foreground
                // itself before performing the bounded server termination.
                ensureForeground()
                val requestedCallId = intent.getStringExtra(EXTRA_CALL_ID)
                val callId = PersistedCallRecoveryPolicy.resolveEndCallId(
                    explicitCallId = requestedCallId,
                    runtimeCallId = RelayRuntime.snapshot().callId,
                    persistedCallId = preferences.activeCallId,
                )
                if (requestedCallId.isNullOrBlank() || callId != null) {
                    endRelay(
                        remoteRequest = !requestedCallId.isNullOrBlank(),
                        requestedCallId = callId,
                    )
                }
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
            null -> {
                if (preferences.relayReadyDesired) arm() else stopSelf(startId)
            }
        }
        return if (preferences.relayReadyDesired) START_STICKY else START_NOT_STICKY
    }

    override fun onDestroy() {
        watchdog?.cancel()
        invalidateSetup()
        cancelIncomingAnswer()
        activeReportJob?.cancel()
        commandDrainJob?.cancel()
        media.close()
        signal.shutdown()
        runCatching { connectivity.unregisterNetworkCallback(networkCallback) }
        scope.cancel()
        RelayRuntime.update { RelayRuntime.Snapshot() }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun ensureForeground() {
        startForeground(NOTIFICATION_ID, notification("Restoring Relay Ready"))
    }

    private fun arm() {
        ensureForeground()
        if (serviceArmed) {
            signal.refreshPairings()
            drainRemoteCommands()
            return
        }
        serviceArmed = true
        lastDeviceHeartbeatAt = 0L
        RelayRuntime.update { it.copy(ready = true, error = null) }
        signal.start()
        restorePersistedCall()
        drainRemoteCommands()
    }

    private fun disarm() {
        preferences.relayReadyDesired = false
        serviceArmed = false
        invalidateSetup()
        cancelIncomingAnswer()
        activeReportJob?.cancel()
        activeReportJob = null
        activeReportedCallId = null
        mediaExpected = false
        media.disconnect()
        signal.close()
        preferences.clearActiveCall()
        RelayRuntime.update { it.copy(ready = false, callId = null) }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun handlePairingRevoked(revokedPairingId: String, reason: String) {
        if (revokedPairingId.isBlank() || preferences.pairing(revokedPairingId) == null) return
        val revokedSelectedPairing = signal.selectedPairingId() == revokedPairingId
        preferences.removePairing(revokedPairingId)
        signal.refreshPairings()
        if (preferences.configured() && (!revokedSelectedPairing || RelayRuntime.snapshot().callId == null)) {
            RelayRuntime.update { it.copy(error = "$reason: one peer pairing was revoked") }
            updateNotification("Ready for remaining paired peer")
            return
        }
        invalidateSetup()
        cancelIncomingAnswer()
        activeReportJob?.cancel()
        activeReportJob = null
        commandDrainJob?.cancel()
        commandDrainJob = null
        if (RelayInCallService.isActive()) RelayInCallService.disconnect()
        mediaExpected = false
        mediaLostAt = null
        media.disconnect()
        serviceArmed = false
        signal.close()
        RelayRuntime.update {
            it.copy(
                ready = false,
                callId = null,
                mediaState = "Pairing revoked",
                error = "The final paired peer was revoked ($reason). Open the app to pair again.",
            )
        }
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun ifReady(action: () -> Unit) {
        if (!preferences.relayReadyDesired || !preferences.configured() || !preferences.entitlementActive) {
            RelayRuntime.update { it.copy(error = "Relay Ready is paused or not configured") }
            return
        }
        arm()
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
                val call = createIncomingCallAfterPriorTermination()
                createdCallId = call.callId
                checkSetupIsCurrent(generation)
                check(RelayInCallService.activeCallCount() == 1) { "The cellular call ended before relay setup" }
                activeReportedCallId = null
                preferences.beginActiveCall(call.callId, "incoming")
                RelayRuntime.update { it.copy(callId = call.callId, mediaState = "Waiting for browser or iPhone") }
            }.onFailure { failure ->
                if (failure is CancellationException) {
                    // Service/process recreation is recoverable. Keep the persisted call so the
                    // restarted foreground service can re-adopt it instead of poisoning the call.
                    return@onFailure
                }
                createdCallId?.let { runCatching { api.event(it, "failed", "android_media_setup_failed") } }
                mediaExpected = false
                media.disconnect()
                if (generation == setupGeneration) {
                    preferences.clearActiveCall(createdCallId)
                    RelayRuntime.update { it.copy(callId = null) }
                }
                reportFailure(failure)
            }
            if (generation == setupGeneration) setupJob = null
        }
    }

    private fun beginOutgoing(callId: String, number: String) {
        if (callId.isBlank() || RelayRuntime.snapshot().callId != null) return
        val generation = nextSetupGeneration()
        activeReportedCallId = null
        preferences.beginActiveCall(callId, "outgoing")
        RelayRuntime.update { it.copy(callId = callId, mediaState = "Validating outgoing request") }
        setupJob = scope.launch {
            runCatching {
                validateOutgoing(number)
                checkSetupIsCurrent(generation)
                val authoritativeCall = api.call(callId)
                check(authoritativeCall.direction == "outgoing" && authoritativeCall.state !in setOf("ending", "ended", "failed")) {
                    "The outgoing relay session is no longer current"
                }
                signal.selectPairing(authoritativeCall.selectedPairingId)
                checkSetupIsCurrent(generation)
                RelayRuntime.update { it.copy(callId = callId, mediaState = "Preparing direct-first WebRTC") }
                connectMedia(callId)
                checkSetupIsCurrent(generation)
                awaitPairedPeer(generation)
                checkSetupIsCurrent(generation)
                check(RelayInCallService.activeCallCount() == 0) { "A cellular call started before remote dialing completed" }
                check(preferences.markActiveCallDialIssued(callId)) { "The outgoing SIM call was already issued" }
                checkSetupIsCurrent(generation)
                placeCellularCall(number)
            }.onFailure { failure ->
                if (failure is CancellationException) return@onFailure
                runCatching { api.event(callId, "failed", "android_dial_rejected") }
                mediaExpected = false
                media.disconnect()
                if (generation == setupGeneration) {
                    preferences.clearActiveCall(callId)
                    RelayRuntime.update { it.copy(callId = null) }
                }
                reportFailure(failure)
            }
            if (generation == setupGeneration) setupJob = null
        }
    }

    private fun acceptIncoming(requestedCallId: String?, commandId: String? = null, expectedVersion: Long = 0L) {
        val activeCallId = RelayRuntime.snapshot().callId ?: preferences.activeCallId.ifBlank { null }
        if (activeCallId == null || (requestedCallId != null && requestedCallId != activeCallId)) {
            commandId?.let { finishRemoteCommand(it, completed = false) }
            return
        }
        when (incomingAnswerGate.register(activeCallId, commandId, expectedVersion)) {
            IncomingAnswerGate.Decision.JOIN -> return
            IncomingAnswerGate.Decision.ALREADY_ISSUED -> {
                commandId?.let { finishRemoteCommand(it, completed = true) }
                if (RelayInCallService.isActive()) callBecameActive()
                return
            }
            IncomingAnswerGate.Decision.REJECTED -> {
                commandId?.let { finishRemoteCommand(it, completed = false) }
                return
            }
            IncomingAnswerGate.Decision.START -> Unit
        }
        val answerSetupGeneration = setupGeneration
        val gateGeneration = incomingAnswerGate.currentGeneration(activeCallId)
        val answerJob = scope.launch(start = CoroutineStart.LAZY) {
            val ownerJob = coroutineContext[Job] ?: error("Incoming answer job has no coroutine Job")
            var completed = false
            try {
                ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                adoptPersistedCall(activeCallId, "incoming")
                val authoritativeCall = api.currentCall()
                ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                check(authoritativeCall?.id == activeCallId && authoritativeCall.direction == "incoming") {
                    "The incoming relay session is no longer current"
                }
                val requiredVersion = incomingAnswerGate.expectedVersion(activeCallId, gateGeneration)
                check(requiredVersion <= 0L || authoritativeCall.version >= requiredVersion) {
                    "The incoming relay command is newer than the server session"
                }
                if (authoritativeCall.state == "active" || RelayInCallService.isActive()) {
                    ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                    incomingAnswerGate.markIssued(activeCallId, gateGeneration)
                    RelayInCallService.routeCurrentCallToSpeaker()
                    if (RelayInCallService.isActive()) callBecameActive()
                    completed = true
                    return@launch
                }
                check(authoritativeCall.state == "accepted") { "The incoming relay session is not accepted" }
                check(!authoritativeCall.selectedPairingId.isNullOrBlank()) { "The incoming relay session has no winning peer" }
                signal.selectPairing(authoritativeCall.selectedPairingId)
                if (!mediaExpected) connectMedia(activeCallId)
                ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                awaitPairedPeer(answerSetupGeneration)
                ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                check(RelayInCallService.activeCallCount() == 1) { "Incoming SIM call ended before WebRTC connected" }
                api.event(activeCallId, "answering_sim")
                ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                if (RelayInCallService.isActive()) {
                    incomingAnswerGate.markIssued(activeCallId, gateGeneration)
                    callBecameActive()
                    completed = true
                    return@launch
                }
                repeat(MAX_TELECOM_ANSWER_ATTEMPTS) { attempt ->
                    ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                    incomingAnswerGate.markIssued(activeCallId, gateGeneration)
                    RelayInCallService.answer()
                    if (awaitTelecomActivation(activeCallId, gateGeneration, answerSetupGeneration)) {
                        ensureIncomingAnswerCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                        runCatching { RelayInCallService.routeCurrentCallToSpeaker() }
                        callBecameActive()
                        completed = true
                        return@launch
                    }
                    incomingAnswerGate.clearIssued(activeCallId, gateGeneration)
                    if (attempt + 1 < MAX_TELECOM_ANSWER_ATTEMPTS) delay(250)
                }
                error("Android Telecom did not activate the incoming call after two answer attempts")
            } catch (failure: Throwable) {
                if (failure !is CancellationException) {
                    val recovered = reconcileIncomingAnswer(activeCallId, gateGeneration, answerSetupGeneration)
                    completed = recovered
                    if (!recovered) {
                        incomingAnswerGate.clearIssued(activeCallId, gateGeneration)
                        val markedFailed = failIncomingIfStillCurrent(activeCallId, gateGeneration, answerSetupGeneration)
                        reportFailure(
                            failure,
                            if (markedFailed) "media_not_ready_before_answer" else "incoming_answer_recoverable",
                        )
                    }
                }
            } finally {
                incomingAnswerGate.finish(activeCallId, gateGeneration).forEach {
                    finishRemoteCommand(it, completed = completed)
                }
                incomingAnswerJobs.clearIfOwner(ownerJob)
            }
        }
        incomingAnswerJobs.install(answerJob)?.cancel()
        answerJob.start()
    }

    private suspend fun reconcileIncomingAnswer(callId: String, gateGeneration: Long, setupGeneration: Long): Boolean {
        ensureIncomingAnswerCurrent(callId, gateGeneration, setupGeneration)
        if (RelayInCallService.isActive()) {
            incomingAnswerGate.markIssued(callId, gateGeneration)
            runCatching { RelayInCallService.routeCurrentCallToSpeaker() }
            callBecameActive()
            return true
        }
        val serverResult = runCatching { api.currentCall() }
        ensureIncomingAnswerCurrent(callId, gateGeneration, setupGeneration)
        if (serverResult.isFailure) return false
        val serverCall = serverResult.getOrNull() ?: return true
        if (serverCall.id == callId && serverCall.state == "active") {
            incomingAnswerGate.markIssued(callId, gateGeneration)
            runCatching { RelayInCallService.routeCurrentCallToSpeaker() }
            return true
        }
        // A closed or replaced call must not be overwritten with a late failed
        // event from an obsolete local job.
        return serverCall.id != callId || serverCall.state in setOf("ending", "ended", "failed")
    }

    private suspend fun failIncomingIfStillCurrent(callId: String, gateGeneration: Long, setupGeneration: Long): Boolean {
        ensureIncomingAnswerCurrent(callId, gateGeneration, setupGeneration)
        if (RelayInCallService.isActive()) return false
        val serverCall = runCatching { api.currentCall() }.getOrNull() ?: return false
        ensureIncomingAnswerCurrent(callId, gateGeneration, setupGeneration)
        if (serverCall.id != callId || serverCall.state != "accepted") return false
        return runCatching {
            api.event(callId, "failed", "media_not_ready_before_answer")
            true
        }.getOrDefault(false)
    }

    private suspend fun awaitTelecomActivation(callId: String, gateGeneration: Long, setupGeneration: Long): Boolean {
        val deadline = SystemClock.elapsedRealtime() + TELECOM_ANSWER_CONFIRM_TIMEOUT_MS
        while (SystemClock.elapsedRealtime() < deadline) {
            ensureIncomingAnswerCurrent(callId, gateGeneration, setupGeneration)
            if (RelayInCallService.isActive()) return true
            if (RelayRuntime.snapshot().callId != callId || RelayInCallService.activeCallCount() != 1) return false
            delay(100)
        }
        return RelayInCallService.isActive()
    }

    private fun ensureIncomingAnswerCurrent(callId: String, gateGeneration: Long, expectedSetupGeneration: Long) {
        if (
            !incomingAnswerGate.isCurrent(callId, gateGeneration) ||
            setupGeneration != expectedSetupGeneration ||
            RelayRuntime.snapshot().callId != callId
        ) {
            throw CancellationException("Incoming answer workflow was superseded")
        }
    }

    private fun cancelIncomingAnswer(callId: String? = null) {
        incomingAnswerJobs.take()?.cancel()
        incomingAnswerGate.cancel(callId).forEach { finishRemoteCommand(it, completed = false) }
    }

    private fun callBecameActive() {
        val callId = RelayRuntime.snapshot().callId ?: return
        incomingAnswerGate.markIssued(callId)
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

    private suspend fun connectMedia(callId: String) {
        require(callId.isNotBlank()) { "Missing call ID" }
        mediaExpected = true
        try {
            api.event(callId, "media_connecting")
            signal.awaitConnected()
            media.connect(callId)
            media.applyMode(RelayRuntime.snapshot().mode)
            updateNotification("WebRTC connecting; SIM remains gated")
        } catch (failure: Throwable) {
            mediaExpected = false
            throw failure
        }
    }

    private fun endRelay(remoteRequest: Boolean, requestedCallId: String? = null) {
        val callId = requestedCallId?.takeIf(String::isNotBlank)
            ?: PersistedCallRecoveryPolicy.resolveEndCallId(
                explicitCallId = null,
                runtimeCallId = RelayRuntime.snapshot().callId,
                persistedCallId = preferences.activeCallId,
            )
        invalidateSetup()
        cancelIncomingAnswer(callId)
        activeReportJob?.cancel()
        activeReportJob = null
        activeReportedCallId = null
        if (remoteRequest) RelayInCallService.disconnect()
        mediaExpected = false
        mediaLostAt = null
        lastHeartbeatAt = 0L
        media.disconnect()
        preferences.clearActiveCall(callId)
        RelayRuntime.update { current ->
            if (callId == null || current.callId == null || current.callId == callId) {
                current.copy(callId = null, mediaState = "Disconnected")
            } else {
                current
            }
        }
        val termination = if (callId != null) {
            // Terminalization gates the next incoming call. Optional media
            // telemetry must never sit in front of this authoritative end.
            callLifecycleBarrier.begin(scope, callId) { terminateCallOnServer(callId) }
        } else {
            null
        }
        if (!preferences.entitlementActive) {
            if (termination == null) {
                disarm()
            } else {
                scope.launch {
                    runCatching { termination.await() }
                    disarm()
                }
            }
            return
        }
        updateNotification("Ready for paired browser or iPhone")
    }

    private suspend fun createIncomingCallAfterPriorTermination(): RelayApiClient.CreatedCall {
        val priorTermination = callLifecycleBarrier.awaitPending()
        val requestId = UUID.randomUUID().toString()
        var lastFailure: Throwable? = priorTermination?.failure
        repeat(2) { attempt ->
            try {
                return api.createIncomingCall(requestId, RelayInCallService.incomingNumber())
            } catch (failure: Throwable) {
                if (failure is CancellationException) throw failure
                lastFailure = failure
                val staleCallId = priorTermination?.callId ?: callLifecycleBarrier.lastCallId()
                val conflict = failure is RelayApiClient.RelayApiException && failure.status == 409
                val current = if (conflict) runCatching { api.currentCall() }.getOrNull() else null
                if (!conflict || staleCallId.isNullOrBlank() || current?.id != staleCallId || attempt == 1) throw failure
                terminateCallOnServer(staleCallId)
                delay(250)
            }
        }
        throw lastFailure ?: IllegalStateException("Could not create incoming relay session")
    }

    private suspend fun terminateCallOnServer(callId: String) {
        var lastFailure: Throwable? = null
        repeat(CALL_END_ATTEMPTS) { attempt ->
            try {
                api.event(
                    callId = callId,
                    type = "end",
                    attempts = 1,
                    connectTimeoutMs = CALL_END_CONNECT_TIMEOUT_MS,
                    readTimeoutMs = CALL_END_READ_TIMEOUT_MS,
                )
                return
            } catch (failure: Throwable) {
                if (failure is CancellationException) throw failure
                if (failure is RelayApiClient.RelayApiException && failure.status == 409) return
                lastFailure = failure
                if (attempt + 1 < CALL_END_ATTEMPTS) delay(250L * (attempt + 1))
            }
        }
        throw lastFailure ?: IllegalStateException("Could not terminate the previous relay session")
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
        if (!RelayInCallService.isActive()) return
        if (activeReportedCallId != callId) {
            callBecameActive()
            return
        }
        val now = System.currentTimeMillis()
        if (now - lastHeartbeatAt < HEARTBEAT_INTERVAL_MS) return
        lastHeartbeatAt = now
        runCatching { api.event(callId, "media_heartbeat") }
            .onFailure { lastHeartbeatAt = 0L }
    }

    private suspend fun sendDeviceHeartbeatIfDue() {
        if (!preferences.relayReadyDesired || !preferences.configured()) return
        val now = System.currentTimeMillis()
        if (now - lastDeviceHeartbeatAt < DEVICE_HEARTBEAT_INTERVAL_MS) return
        lastDeviceHeartbeatAt = now
        val heartbeat = DeviceHeartbeat(
            serviceInstanceId = DeviceHeartbeatIdentity.serviceInstanceId,
            sequence = DeviceHeartbeatIdentity.nextSequence(),
            relayReady = serviceArmed && preferences.entitlementActive,
            signalState = signalState,
            activeCallId = RelayRuntime.snapshot().callId,
            processStartedAt = DeviceHeartbeatIdentity.processStartedAt,
            lastErrorCode = lastErrorCode,
        )
        runCatching { api.deviceHeartbeat(heartbeat) }
            .onFailure { lastErrorCode = "heartbeat_failed" }
    }

    private fun isCurrentCall(requestedCallId: String?): Boolean {
        val currentCallId = RelayRuntime.snapshot().callId
        return !requestedCallId.isNullOrBlank() && currentCallId != null && requestedCallId == currentCallId
    }

    private fun isKnownCall(requestedCallId: String?): Boolean =
        isCurrentCall(requestedCallId) ||
            (!requestedCallId.isNullOrBlank() && requestedCallId == preferences.activeCallId)

    private fun restorePersistedCall() {
        val generation = setupGeneration
        val nextRestore = scope.launch(start = CoroutineStart.LAZY) {
            val ownerJob = coroutineContext[Job] ?: error("Restore job has no coroutine Job")
            try {
                val serverCall = api.currentCall()
                checkSetupIsCurrent(generation)
                if (serverCall == null) {
                    if (RelayInCallService.activeCallCount() == 0) {
                        preferences.clearActiveCall()
                        RelayRuntime.update { it.copy(callId = null) }
                    }
                    return@launch
                }
                adoptPersistedCall(serverCall.id, serverCall.direction)
                checkSetupIsCurrent(generation)
                signal.selectPairing(serverCall.selectedPairingId)
                media.applyMode(RelayMode.fromWire(serverCall.relayMode))
                val outgoingAction = PersistedCallRecoveryPolicy.outgoingAction(
                    direction = serverCall.direction,
                    state = serverCall.state,
                    phoneNumber = serverCall.phoneNumber,
                    activeTelecomCalls = RelayInCallService.activeCallCount(),
                    dialAlreadyIssued = preferences.activeCallDialIssued,
                )
                when (outgoingAction) {
                    PersistedCallRecoveryPolicy.OutgoingAction.TERMINALIZE -> {
                        terminalizeRestoredOutgoing(serverCall.id, generation, "android_restart_unsafe_to_redial")
                    }
                    PersistedCallRecoveryPolicy.OutgoingAction.RESUME_DIAL -> {
                        try {
                            if (!mediaExpected) connectMedia(serverCall.id)
                            resumeRestoredOutgoing(serverCall.id, checkNotNull(serverCall.phoneNumber), generation)
                        } catch (failure: Throwable) {
                            if (failure is CancellationException) throw failure
                            if (generation == setupGeneration) {
                                runCatching {
                                    terminalizeRestoredOutgoing(serverCall.id, generation, "android_restart_dial_failed")
                                }
                            }
                            throw failure
                        }
                    }
                    PersistedCallRecoveryPolicy.OutgoingAction.KEEP_EXISTING_TELECOM_CALL,
                    PersistedCallRecoveryPolicy.OutgoingAction.NONE,
                    -> {
                        val mediaMayStart = serverCall.direction == "outgoing" ||
                            serverCall.state in setOf("accepted", "answering_sim", "active")
                        if (mediaMayStart && !mediaExpected) connectMedia(serverCall.id)
                        if (!mediaMayStart) {
                            RelayRuntime.update { it.copy(mediaState = "Waiting for browser or iPhone") }
                        }
                        checkSetupIsCurrent(generation)
                        if (
                            serverCall.direction == "incoming" && serverCall.state == "accepted" &&
                            RelayInCallService.activeCallCount() == 1 && !RelayInCallService.isActive()
                        ) {
                            acceptIncoming(serverCall.id)
                        }
                    }
                }
            } catch (failure: Throwable) {
                if (failure !is CancellationException) reportFailure(failure)
            } finally {
                if (restoreJob === ownerJob) restoreJob = null
            }
        }
        restoreJob?.cancel()
        restoreJob = nextRestore
        nextRestore.start()
    }

    private suspend fun resumeRestoredOutgoing(callId: String, phoneNumber: String, generation: Long) {
        validateOutgoing(phoneNumber)
        checkSetupIsCurrent(generation)
        awaitPairedPeer(generation)
        checkSetupIsCurrent(generation)
        check(RelayInCallService.activeCallCount() == 0) { "A cellular call appeared before outgoing recovery" }
        check(preferences.markActiveCallDialIssued(callId)) { "The outgoing SIM call was already issued" }
        checkSetupIsCurrent(generation)
        if (RelayInCallService.activeCallCount() == 0) {
            placeCellularCall(phoneNumber)
        }
    }

    private suspend fun terminalizeRestoredOutgoing(callId: String, generation: Long, code: String) {
        checkSetupIsCurrent(generation)
        api.event(callId, "failed", code)
        checkSetupIsCurrent(generation)
        mediaExpected = false
        media.disconnect()
        preferences.clearActiveCall(callId)
        RelayRuntime.update { current ->
            if (current.callId == callId) current.copy(callId = null, mediaState = "Disconnected") else current
        }
    }

    private fun adoptPersistedCall(callId: String, direction: String) {
        preferences.beginActiveCall(callId, direction)
        if (RelayRuntime.snapshot().callId != callId) {
            activeReportedCallId = null
            RelayRuntime.update {
                it.copy(callId = callId, mediaState = "Recovering direct-first WebRTC", error = null)
            }
        }
    }

    private fun drainRemoteCommands() {
        if (commandDrainJob?.isActive == true) return
        commandDrainJob = scope.launch {
            for (command in preferences.pendingRemoteCommands()) {
                if (!remoteCommandsInFlight.add(command.id)) continue
                val expired = command.createdAt > 0L &&
                    System.currentTimeMillis() - command.createdAt > REMOTE_COMMAND_MAX_AGE_MS &&
                    command.event !in setOf("end", "reject", "failed")
                if (expired) {
                    preferences.discardRemoteCommand(command.id)
                    remoteCommandsInFlight.remove(command.id)
                    continue
                }
                if (!preferences.relayReadyDesired || !preferences.configured() || !preferences.entitlementActive) {
                    if (command.callId.isNotBlank() && command.type == "outgoing_call") {
                        runCatching { api.event(command.callId, "failed", "relay_paused") }
                    }
                    finishRemoteCommand(command.id, completed = true)
                    continue
                }
                runCatching {
                    when (command.type) {
                        "outgoing_call" -> {
                            signal.selectPairing(command.pairingId)
                            beginOutgoing(command.callId, command.phoneNumber)
                            finishRemoteCommand(command.id, completed = true)
                        }
                        "call_event" -> when (command.event) {
                            "accept" -> {
                                signal.selectPairing(command.pairingId)
                                adoptPersistedCall(command.callId, "incoming")
                                acceptIncoming(command.callId, command.id, command.callVersion)
                            }
                            "end", "reject", "failed" -> {
                                if (command.callId == preferences.activeCallId || isCurrentCall(command.callId)) {
                                    endRelay(remoteRequest = true)
                                }
                                finishRemoteCommand(command.id, completed = true)
                            }
                            "full_duplex", "listen", "talk" -> {
                                if (command.callId == preferences.activeCallId || isCurrentCall(command.callId)) {
                                    media.applyMode(RelayMode.fromWire(command.event))
                                }
                                finishRemoteCommand(command.id, completed = true)
                            }
                            "dtmf" -> {
                                if (command.callId == preferences.activeCallId || isCurrentCall(command.callId)) {
                                    RelayInCallService.sendDtmf(command.digit)
                                }
                                finishRemoteCommand(command.id, completed = true)
                            }
                            "mute" -> {
                                val muted = command.muted.toBooleanStrictOrNull()
                                    ?: error("Invalid mute command")
                                if (command.callId == preferences.activeCallId || isCurrentCall(command.callId)) {
                                    media.setMuted(muted)
                                }
                                finishRemoteCommand(command.id, completed = true)
                            }
                            else -> finishRemoteCommand(command.id, completed = true)
                        }
                        else -> finishRemoteCommand(command.id, completed = true)
                    }
                }.onFailure { failure ->
                    remoteCommandsInFlight.remove(command.id)
                    if (failure !is CancellationException) reportFailure(failure)
                }
            }
            commandDrainJob = null
            if (!preferences.relayReadyDesired) {
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
    }

    private fun finishRemoteCommand(commandId: String, completed: Boolean) {
        if (completed) preferences.completeRemoteCommand(commandId) else preferences.discardRemoteCommand(commandId)
        remoteCommandsInFlight.remove(commandId)
    }

    private fun nextSetupGeneration(): Long {
        invalidateSetup()
        return setupGeneration
    }

    private fun invalidateSetup() {
        setupGeneration += 1
        setupJob?.cancel()
        setupJob = null
        restoreJob?.cancel()
        restoreJob = null
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

    private fun reportFailure(failure: Throwable, code: String = "relay_error") {
        lastErrorCode = code
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
            .setSmallIcon(R.drawable.ic_call_relay)
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
        const val ACTION_PROCESS_COMMANDS = "dev.zamad.callrelay.action.PROCESS_COMMANDS"
        const val ACTION_INCOMING = "dev.zamad.callrelay.action.INCOMING"
        const val ACTION_OUTGOING = "dev.zamad.callrelay.action.OUTGOING"
        const val ACTION_ACCEPT = "dev.zamad.callrelay.action.ACCEPT"
        const val ACTION_CALL_ACTIVE = "dev.zamad.callrelay.action.CALL_ACTIVE"
        const val ACTION_END = "dev.zamad.callrelay.action.END"
        const val ACTION_SET_MODE = "dev.zamad.callrelay.action.SET_MODE"
        const val ACTION_DTMF = "dev.zamad.callrelay.action.DTMF"
        const val ACTION_MUTE = "dev.zamad.callrelay.action.MUTE"
        const val EXTRA_CALL_ID = "call_id"
        const val EXTRA_PHONE_NUMBER = "phone_number"
        const val EXTRA_MODE = "mode"
        const val EXTRA_DTMF = "dtmf"
        const val EXTRA_MUTED = "muted"
        private const val CHANNEL_ID = "relay-ready"
        private const val NOTIFICATION_ID = 2001
        private const val MEDIA_LOSS_TIMEOUT_MS = 15_000L
        private const val PEER_JOIN_TIMEOUT_MS = 20_000L
        private const val TELECOM_ANSWER_CONFIRM_TIMEOUT_MS = 4_000L
        private const val MAX_TELECOM_ANSWER_ATTEMPTS = 2
        private const val CALL_END_ATTEMPTS = 2
        private const val CALL_END_CONNECT_TIMEOUT_MS = 2_000
        private const val CALL_END_READ_TIMEOUT_MS = 3_000
        private const val HEARTBEAT_INTERVAL_MS = 30_000L
        private const val DEVICE_HEARTBEAT_INTERVAL_MS = 30_000L
        private const val REMOTE_COMMAND_MAX_AGE_MS = 2 * 60_000L
    }

    private val signalListener = object : PairingSignalClient.Listener {
        override fun onSignalState(state: String) {
            signalState = state
            RelayRuntime.update { current ->
                if (current.callId == null) current.copy(mediaState = "Signaling: $state") else current
            }
            if (state == "Connected" && mediaExpected && RelayRuntime.snapshot().callId != null && !media.isPeerConnected()) {
                scope.launch {
                    runCatching { media.ensureOffer() }
                        .onFailure { reportFailure(it, "offer_regeneration_failed") }
                }
            }
        }

        override fun onPeerPresence(online: Boolean) {
            if (RelayRuntime.snapshot().callId == null) updateNotification(if (online) "Paired peer online" else "Ready; paired peer offline")
        }

        override fun onCallSnapshot(call: PairingSignalClient.CallSnapshot) {
            scope.launch {
                // END clears local state before its bounded network request
                // completes. Ignore snapshots for that exact terminalizing
                // call so a delayed accepted/dialing snapshot cannot re-adopt
                // it while Telecom is still unwinding.
                if (callLifecycleBarrier.isTerminating(call.id)) return@launch
                if (call.state == "ending" || call.state == "ended" || call.state == "failed") {
                    if (isKnownCall(call.id)) endRelay(remoteRequest = true, requestedCallId = call.id)
                    return@launch
                }
                if (call.direction == "incoming" && RelayRuntime.snapshot().callId == null && RelayInCallService.activeCallCount() == 1) {
                    adoptPersistedCall(call.id, call.direction)
                    val mediaMayStart = !call.selectedPairingId.isNullOrBlank() &&
                        call.state in setOf("accepted", "answering_sim", "active")
                    if (mediaMayStart) {
                        signal.selectPairing(call.selectedPairingId)
                        if (!mediaExpected) connectMedia(call.id)
                    } else {
                        RelayRuntime.update { it.copy(mediaState = "Waiting for browser or iPhone") }
                    }
                }
                if (
                    call.direction == "outgoing" && call.state == "dialing_sim" &&
                    RelayRuntime.snapshot().callId == null && !call.phoneNumber.isNullOrBlank()
                ) {
                    beginOutgoing(call.id, call.phoneNumber)
                    return@launch
                }
                if (isCurrentCall(call.id)) {
                    signal.selectPairing(call.selectedPairingId)
                    media.applyMode(RelayMode.fromWire(call.relayMode))
                    if (call.direction == "incoming" && call.state == "accepted" && !RelayInCallService.isActive()) acceptIncoming(call.id)
                }
            }
        }

        override fun onEnvelope(type: String, payload: org.json.JSONObject, callId: String, negotiationId: String?) {
            scope.launch {
                runCatching { media.handleSignal(type, payload, callId, negotiationId) }
                    .onFailure(::reportFailure)
            }
        }

        override fun onPairingRevoked(pairingId: String, reason: String) {
            scope.launch { handlePairingRevoked(pairingId, reason) }
        }

        override fun onSignalError(message: String) {
            lastErrorCode = "signaling_error"
            RelayRuntime.update { it.copy(error = message) }
        }
    }

    private val mediaListener = object : WebRtcRelaySession.Listener {
        override fun onMediaConnected(candidateType: String, icePolicy: String) {
            lastErrorCode = null
            val callId = RelayRuntime.snapshot().callId ?: return
            scope.launch {
                runCatching {
                    api.event(
                        callId,
                        "media_connected",
                        payload = org.json.JSONObject().put("candidateType", candidateType).put("icePolicy", icePolicy),
                    )
                }
            }
            updateNotification("WebRTC connected; safe for SIM call")
        }

        override fun onMediaFailed(code: String, message: String) {
            val failedCallId = RelayRuntime.snapshot().callId ?: return
            scope.launch {
                mediaExpected = false
                val summary = media.summary().json()
                media.disconnect()
                if (RelayInCallService.isActive()) RelayInCallService.disconnect()
                runCatching { api.event(failedCallId, "media_summary", payload = summary) }
                runCatching { api.event(failedCallId, "failed", code) }
                reportFailure(IllegalStateException(message), code)
            }
        }
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = media.networkChanged()
        override fun onLost(network: Network) = media.networkChanged()
    }
}
