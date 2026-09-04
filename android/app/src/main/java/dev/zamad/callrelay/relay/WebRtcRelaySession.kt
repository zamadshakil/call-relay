package dev.zamad.callrelay.relay

import android.content.Context
import android.os.SystemClock
import dev.zamad.callrelay.audio.DuplexEchoGuard
import dev.zamad.callrelay.audio.PcmGainProcessor
import dev.zamad.callrelay.network.RelayApiClient
import dev.zamad.callrelay.network.SignalTransport
import java.nio.ByteBuffer
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.suspendCancellableCoroutine
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.ExternalAudioProcessingFactory
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import org.json.JSONArray
import org.json.JSONObject

private typealias ConnectionBinding = ConnectionGenerationGate.Binding<PeerConnection>

class WebRtcRelaySession(
    context: Context,
    private val preferences: RelayPreferences,
    private val api: RelayApiClient,
    private val signal: SignalTransport,
    private val listener: Listener,
) {
    data class StatsSummary(
        val setupDurationMs: Long = 0,
        val candidateType: String = "unknown",
        val protocol: String = "unknown",
        val rttMs: Double = 0.0,
        val jitterMs: Double = 0.0,
        val packetsLost: Long = 0,
        val concealedSamples: Long = 0,
        val bytesSent: Long = 0,
        val bytesReceived: Long = 0,
        val iceRestartCount: Int = 0,
    ) {
        fun json(): JSONObject = JSONObject()
            .put("setupDurationMs", setupDurationMs)
            .put("candidateType", candidateType)
            .put("protocol", protocol)
            .put("rttMs", rttMs)
            .put("jitterMs", jitterMs)
            .put("packetsLost", packetsLost)
            .put("concealedSamples", concealedSamples)
            .put("bytesSent", bytesSent)
            .put("bytesReceived", bytesReceived)
            .put("iceRestartCount", iceRestartCount)
    }

    interface Listener {
        fun onMediaConnected(candidateType: String, icePolicy: String)
        fun onMediaFailed(code: String, message: String)
    }

    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val mode = AtomicReference(RelayMode.FULL_DUPLEX)
    private val explicitlyMuted = AtomicBoolean(false)
    private val connected = AtomicBoolean(false)
    private val gainProcessor = PcmGainProcessor()
    private val echoGuard = DuplexEchoGuard()
    private val iceGenerationRouter = IceGenerationRouter()
    private val connectionGenerationGate = ConnectionGenerationGate<PeerConnection>()
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private val engineLeaseDelegate = lazy {
        ProcessWebRtcEngine.attach(appContext, captureProcessor, renderProcessor)
    }
    private val engineLease by engineLeaseDelegate
    private val connectMutex = Mutex()
    private val negotiationMutex = Mutex()
    private val sessionGeneration = AtomicLong()
    private var audioSource: AudioSource? = null
    private var localTrack: AudioTrack? = null
    private var remoteTrack: AudioTrack? = null
    @Volatile private var peerConnection: PeerConnection? = null
    @Volatile private var callId = ""
    private var mediaConfig: RelayApiClient.MediaConfig? = null
    private var icePolicy = "all"
    private var setupStartedAt = 0L
    private var setupDurationMs = 0L
    private var directTimer: Job? = null
    private var failureTimer: Job? = null
    private var refreshTimer: Job? = null
    private var statsTimer: Job? = null
    private var restartCount = 0
    @Volatile private var currentNegotiationId: String? = null
    @Volatile private var lifecycleState = MediaLifecycle.IDLE
    @Volatile private var statsSummary = StatsSummary()

    suspend fun connect(nextCallId: String) = connectMutex.withLock {
        require(nextCallId.matches(Regex("^call_[a-f0-9]{32}$"))) { "Call ID is invalid" }
        if (callId == nextCallId && peerConnection != null) return@withLock
        disconnect()
        val generation = sessionGeneration.incrementAndGet()
        signal.awaitConnected()
        checkGeneration(generation)
        callId = nextCallId
        lifecycleState = MediaLifecycle.CONNECTING
        setupStartedAt = System.currentTimeMillis()
        setupDurationMs = 0L
        icePolicy = "all"
        restartCount = 0
        RelayRuntime.update { it.copy(mediaState = "Requesting Cloudflare STUN/TURN", error = null) }
        mediaConfig = api.mediaConfig(nextCallId)
        checkGeneration(generation)
        engineLease.factory
        createPeerConnection(generation, nextCallId)
        checkGeneration(generation)
        createAndSendOffer(iceRestart = false)
        checkGeneration(generation)
        RelayRuntime.update { it.copy(mediaState = "Connecting direct-first WebRTC") }
        startDeadlines()
        scheduleCredentialRefresh()
    }

    suspend fun handleSignal(type: String, payload: JSONObject, envelopeCallId: String, negotiationId: String? = null) {
        if (envelopeCallId != callId || callId.isBlank()) return
        if (
            type in NEGOTIATION_SCOPED_MESSAGES && negotiationId != null &&
            currentNegotiationId != null && negotiationId != currentNegotiationId
        ) {
            // Safari can flush candidates or an answer after a reconnect. They
            // belong to the old DTLS/ICE exchange and must not contaminate the
            // replacement peer connection negotiation.
            return
        }
        when (type) {
            "answer" -> {
                val binding = currentConnectionBinding() ?: return
                val answer = SessionDescription(SessionDescription.Type.ANSWER, payload.getString("sdp"))
                setRemoteDescription(answer, binding)
                if (!isCurrent(binding)) return
                synchronized(pendingCandidates) {
                    pendingCandidates.toList().also { pendingCandidates.clear() }
                }.forEach { binding.connection.addIceCandidate(it) }
            }
            "ice_candidates" -> {
                val binding = currentConnectionBinding() ?: return
                val candidates = payload.getJSONArray("candidates")
                check(candidates.length() <= 128) { "Too many ICE candidates" }
                for (index in 0 until candidates.length()) {
                    val value = candidates.getJSONObject(index)
                    val candidate = IceCandidate(
                        value.optString("sdpMid", "0"),
                        value.getInt("sdpMLineIndex"),
                        value.getString("candidate"),
                    )
                    if (!isCurrent(binding)) return
                    if (binding.connection.remoteDescription != null) binding.connection.addIceCandidate(candidate)
                    else synchronized(pendingCandidates) { pendingCandidates += candidate }
                }
            }
            "ice_complete" -> Unit
            "ice_restart_request" -> {
                val binding = currentConnectionBinding() ?: return
                restartIce(
                    reason = payload.optString("reason", "peer_request"),
                    forceRelay = true,
                    negotiationId = negotiationId,
                    expectedBinding = binding,
                )
            }
            "offer_request" -> {
                require(negotiationId != null) { "Offer request is missing its negotiation ID" }
                ensureOffer(
                    iceRestart = payload.optBoolean("iceRestart", payload.optBoolean("ice_restart", false)),
                    negotiationId = negotiationId,
                    forceRelay = payload.optString("icePolicy", payload.optString("ice_policy")) == "relay",
                )
            }
            "media_failed" -> fail("peer_media_failed", payload.optString("reason", "Paired peer media failed"))
        }
    }

    suspend fun applyMode(next: RelayMode) {
        mode.set(next)
        applyAudioDirection()
        RelayRuntime.update { it.copy(mode = next) }
    }

    suspend fun setMuted(muted: Boolean) {
        explicitlyMuted.set(muted)
        applyAudioDirection()
        RelayRuntime.update { it.copy(muted = muted) }
    }

    fun isPeerConnected(): Boolean = connected.get()

    fun summary(): StatsSummary = statsSummary.copy(iceRestartCount = restartCount)

    fun networkChanged() {
        val binding = currentConnectionBinding() ?: return
        scope.launch { restartIce("network_change", forceRelay = false, expectedBinding = binding) }
    }

    @Synchronized
    fun disconnect() {
        if (lifecycleState == MediaLifecycle.CLOSING) return
        lifecycleState = MediaLifecycle.CLOSING
        sessionGeneration.incrementAndGet()
        directTimer?.cancel()
        failureTimer?.cancel()
        refreshTimer?.cancel()
        statsTimer?.cancel()
        directTimer = null
        failureTimer = null
        refreshTimer = null
        statsTimer = null
        connected.set(false)
        echoGuard.reset()
        remoteTrack = null
        val connection = peerConnection.also { peerConnection = null }
        val track = localTrack.also { localTrack = null }
        val source = audioSource.also { audioSource = null }
        // Clear the call before closing native objects so late WebRTC callbacks
        // cannot re-enter failure handling for a call that is already ending.
        callId = ""
        connectionGenerationGate.invalidate()
        currentNegotiationId = null
        iceGenerationRouter.reset()
        mediaConfig = null
        connection?.close()
        connection?.dispose()
        track?.dispose()
        source?.dispose()
        synchronized(pendingCandidates) { pendingCandidates.clear() }
        lifecycleState = MediaLifecycle.IDLE
        RelayRuntime.update { it.copy(mediaState = "Disconnected", captureRms = 0.0, capturePeak = 0) }
    }

    fun close() {
        disconnect()
        if (engineLeaseDelegate.isInitialized()) engineLease.detach()
        scope.cancel()
    }

    private fun createPeerConnection(generation: Long, expectedCallId: String) {
        val createdFactory = engineLease.factory
        val config = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val connectionReference = AtomicReference<PeerConnection?>()
        val connection = checkNotNull(
            createdFactory.createPeerConnection(
                config,
                createPeerObserver(generation, expectedCallId, connectionReference),
            ),
        ) { "WebRTC peer connection creation failed" }
        connectionReference.set(connection)
        val constraints = MediaConstraints().apply {
            mandatory += MediaConstraints.KeyValuePair("googEchoCancellation", "true")
            mandatory += MediaConstraints.KeyValuePair("googAutoGainControl", "false")
            mandatory += MediaConstraints.KeyValuePair("googNoiseSuppression", "false")
            mandatory += MediaConstraints.KeyValuePair("googHighpassFilter", "true")
        }
        val source = createdFactory.createAudioSource(constraints)
        val track = createdFactory.createAudioTrack("relay-audio-$callId", source)
        connection.addTransceiver(
            track,
            RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV),
        )
        audioSource = source
        localTrack = track
        peerConnection = connection
        connectionGenerationGate.activate(generation, expectedCallId, connection)
        applyAudioDirection()
    }

    private suspend fun createAndSendOffer(
        iceRestart: Boolean,
        negotiationId: String? = null,
        expectedBinding: ConnectionBinding? = null,
    ) = negotiationMutex.withLock {
        val binding = expectedBinding ?: currentConnectionBinding() ?: return@withLock
        if (!isCurrent(binding)) return@withLock
        createAndSendOfferLocked(iceRestart, negotiationId, binding)
    }

    suspend fun ensureOffer(
        iceRestart: Boolean = false,
        negotiationId: String? = null,
        forceRelay: Boolean = false,
    ) = negotiationMutex.withLock {
        val binding = currentConnectionBinding() ?: return@withLock
        val connection = binding.connection
        val activeCallId = binding.callId
        val relayPolicyChanged = forceRelay && icePolicy != "relay"
        if (relayPolicyChanged) configureIcePolicy(connection, relayOnly = true)
        val shouldRestart = iceRestart || relayPolicyChanged
        if (shouldRestart) {
            restartCount += 1
            connected.set(false)
            connection.restartIce()
        }
        val existing = connection.localDescription
        if (!shouldRestart && existing?.type == SessionDescription.Type.OFFER) {
            currentNegotiationId = negotiationId ?: currentNegotiationId ?: UUID.randomUUID().toString()
            iceGenerationRouter.activate(checkNotNull(currentNegotiationId))
            iceGenerationRouter.bindLocalDescription(checkNotNull(currentNegotiationId), existing.description)
            signal.send(
                "offer",
                activeCallId,
                JSONObject().put("sdp", existing.description).put("icePolicy", icePolicy),
                currentNegotiationId,
            )
        } else {
            createAndSendOfferLocked(shouldRestart, negotiationId, binding)
        }
    }

    private suspend fun createAndSendOfferLocked(
        iceRestart: Boolean,
        negotiationId: String?,
        binding: ConnectionBinding,
    ) {
        if (!isCurrent(binding)) return
        val activeCallId = binding.callId
        val activeNegotiationId = negotiationId ?: UUID.randomUUID().toString()
        currentNegotiationId = activeNegotiationId
        iceGenerationRouter.activate(activeNegotiationId)
        synchronized(pendingCandidates) { pendingCandidates.clear() }
        val constraints = MediaConstraints()
        if (iceRestart) constraints.mandatory += MediaConstraints.KeyValuePair("IceRestart", "true")
        val offer = createOffer(constraints, binding)
        if (!isCurrent(binding)) return
        iceGenerationRouter.bindLocalDescription(activeNegotiationId, offer.description)
        setLocalDescription(offer, binding)
        if (!isCurrent(binding)) return
        signal.send(
            "offer",
            activeCallId,
            JSONObject().put("sdp", offer.description).put("icePolicy", icePolicy),
            activeNegotiationId,
        )
    }

    private suspend fun createOffer(
        constraints: MediaConstraints,
        binding: ConnectionBinding,
    ): SessionDescription = suspendCancellableCoroutine { continuation ->
        if (!isCurrent(binding)) {
            continuation.resumeWithException(CancellationException("WebRTC connection was superseded"))
            return@suspendCancellableCoroutine
        }
        binding.connection.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resume(description)
                else continuation.resumeWithException(CancellationException("WebRTC offer callback was superseded"))
            }
            override fun onCreateFailure(error: String) {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resumeWithException(IllegalStateException(error))
                else continuation.resumeWithException(CancellationException("WebRTC offer callback was superseded"))
            }
        }, constraints)
    }

    private fun checkGeneration(expected: Long) {
        if (sessionGeneration.get() != expected) throw CancellationException("WebRTC session was superseded")
    }

    private fun currentConnectionBinding(): ConnectionBinding? {
        val connection = peerConnection ?: return null
        val activeCallId = callId.takeIf(String::isNotBlank) ?: return null
        return ConnectionBinding(sessionGeneration.get(), activeCallId, connection).takeIf(::isCurrent)
    }

    private fun isCurrent(binding: ConnectionBinding): Boolean =
        lifecycleState != MediaLifecycle.IDLE &&
            lifecycleState != MediaLifecycle.CLOSING &&
            connectionGenerationGate.isCurrent(binding) &&
            sessionGeneration.get() == binding.generation &&
            callId == binding.callId &&
            peerConnection === binding.connection

    private suspend fun setLocalDescription(
        description: SessionDescription,
        binding: ConnectionBinding,
    ): Unit = suspendCancellableCoroutine { continuation ->
        if (!isCurrent(binding)) {
            continuation.resumeWithException(CancellationException("WebRTC connection was superseded"))
            return@suspendCancellableCoroutine
        }
        binding.connection.setLocalDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resume(Unit)
                else continuation.resumeWithException(CancellationException("WebRTC local-description callback was superseded"))
            }
            override fun onSetFailure(error: String) {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resumeWithException(IllegalStateException(error))
                else continuation.resumeWithException(CancellationException("WebRTC local-description callback was superseded"))
            }
        }, description)
    }

    private suspend fun setRemoteDescription(
        description: SessionDescription,
        binding: ConnectionBinding,
    ): Unit = suspendCancellableCoroutine { continuation ->
        if (!isCurrent(binding)) {
            continuation.resumeWithException(CancellationException("WebRTC connection was superseded"))
            return@suspendCancellableCoroutine
        }
        binding.connection.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resume(Unit)
                else continuation.resumeWithException(CancellationException("WebRTC remote-description callback was superseded"))
            }
            override fun onSetFailure(error: String) {
                if (!continuation.isActive) return
                if (isCurrent(binding)) continuation.resumeWithException(IllegalStateException(error))
                else continuation.resumeWithException(CancellationException("WebRTC remote-description callback was superseded"))
            }
        }, description)
    }

    private fun createPeerObserver(
        generation: Long,
        expectedCallId: String,
        connectionReference: AtomicReference<PeerConnection?>,
    ): PeerConnection.Observer = object : PeerConnection.Observer {
        private fun binding(): ConnectionBinding? {
            val connection = connectionReference.get() ?: return null
            return ConnectionBinding(generation, expectedCallId, connection).takeIf(::isCurrent)
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit

        override fun onIceCandidate(candidate: IceCandidate) {
            val active = binding() ?: return
            val candidateNegotiationId = iceGenerationRouter.negotiationForCandidate(candidate.sdp) ?: return
            val payload = JSONObject().put(
                "candidates",
                JSONArray().put(
                    JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex),
                ),
            )
            runCatching { signal.send("ice_candidates", active.callId, payload, candidateNegotiationId) }
                .onFailure { fail("signaling_send_failed", it.message ?: "ICE signaling failed", active) }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            val active = binding() ?: return
            if (state == PeerConnection.IceConnectionState.FAILED) {
                connected.set(false)
                scope.launch { forceRelayAndRestart("ice_failed", active) }
            }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            val active = binding() ?: return
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> becameConnected(active)
                PeerConnection.PeerConnectionState.DISCONNECTED -> connected.set(false)
                PeerConnection.PeerConnectionState.FAILED -> {
                    connected.set(false)
                    scope.launch { forceRelayAndRestart("connection_failed", active) }
                }
                else -> Unit
            }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            if (binding() == null) return
            val track = transceiver.receiver.track() as? AudioTrack ?: return
            remoteTrack = track
            applyAudioDirection()
        }
    }

    private fun becameConnected(binding: ConnectionBinding) {
        if (!isCurrent(binding)) return
        if (!connected.compareAndSet(false, true)) return
        lifecycleState = MediaLifecycle.ACTIVE
        if (setupDurationMs == 0L) setupDurationMs = (System.currentTimeMillis() - setupStartedAt).coerceAtLeast(0)
        directTimer?.cancel()
        failureTimer?.cancel()
        RelayRuntime.update { it.copy(mediaState = "Connected WebRTC ($icePolicy)") }
        runCatching { signal.send("media_ready", binding.callId, JSONObject().put("icePolicy", icePolicy), currentNegotiationId) }
        updateStats(binding) { route -> listener.onMediaConnected(route.candidateType, icePolicy) }
        statsTimer?.cancel()
        statsTimer = scope.launch {
            while (connected.get() && isCurrent(binding)) {
                delay(5_000)
                updateStats(binding)
            }
        }
    }

    private fun startDeadlines() {
        val binding = currentConnectionBinding() ?: return
        directTimer = scope.launch {
            delay(DIRECT_TIMEOUT_MS)
            if (!connected.get() && isCurrent(binding)) forceRelayAndRestart("direct_timeout", binding)
        }
        failureTimer = scope.launch {
            delay(SETUP_TIMEOUT_MS)
            if (!connected.get() && isCurrent(binding)) {
                fail("ice_timeout", "WebRTC did not connect within 20 seconds", binding)
            }
        }
    }

    private suspend fun forceRelayAndRestart(reason: String, expectedBinding: ConnectionBinding? = null) {
        val binding = expectedBinding ?: currentConnectionBinding() ?: return
        if (!isCurrent(binding) || connected.get() || icePolicy == "relay") return
        restartIce(reason, forceRelay = true, expectedBinding = binding)
    }

    private suspend fun restartIce(
        reason: String,
        forceRelay: Boolean,
        negotiationId: String? = null,
        expectedBinding: ConnectionBinding? = null,
    ) {
        val binding = expectedBinding ?: currentConnectionBinding() ?: return
        if (!isCurrent(binding)) return
        val connection = binding.connection
        if (forceRelay) configureIcePolicy(connection, relayOnly = true)
        restartCount += 1
        connected.set(false)
        RelayRuntime.update { it.copy(mediaState = "Restarting WebRTC: $reason") }
        runCatching {
            api.event(
                binding.callId,
                "media_restarting",
                payload = JSONObject().put("reason", reason).put("icePolicy", icePolicy),
            )
        }
        if (!isCurrent(binding)) return
        connection.restartIce()
        createAndSendOffer(iceRestart = true, negotiationId = negotiationId, expectedBinding = binding)
    }

    private fun configureIcePolicy(connection: PeerConnection, relayOnly: Boolean) {
        icePolicy = if (relayOnly) "relay" else "all"
        val config = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
            iceTransportsType = if (relayOnly) {
                PeerConnection.IceTransportsType.RELAY
            } else {
                PeerConnection.IceTransportsType.ALL
            }
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        check(connection.setConfiguration(config)) {
            if (relayOnly) "Could not force Cloudflare TURN" else "Could not restore direct-first ICE"
        }
    }

    private fun scheduleCredentialRefresh(expectedBinding: ConnectionBinding? = null) {
        refreshTimer?.cancel()
        val binding = expectedBinding ?: currentConnectionBinding() ?: return
        if (!isCurrent(binding)) return
        val config = mediaConfig ?: return
        val delayMs = ((config.credentialsExpiresAt - System.currentTimeMillis()) * 3 / 4).coerceAtLeast(60_000L)
        refreshTimer = scope.launch {
            delay(delayMs)
            if (!isCurrent(binding)) return@launch
            runCatching {
                mediaConfig = api.mediaConfig(binding.callId)
                if (!isCurrent(binding)) return@runCatching
                val connection = binding.connection
                val updated = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
                    iceTransportsType = if (icePolicy == "relay") PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
                    bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                    rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                }
                check(connection.setConfiguration(updated)) { "TURN credential refresh was rejected" }
                scheduleCredentialRefresh(binding)
            }.onFailure { fail("turn_refresh_failed", it.message ?: "TURN credential refresh failed", binding) }
        }
    }

    private fun updateStats(binding: ConnectionBinding, onComplete: ((Route) -> Unit)? = null) {
        if (!isCurrent(binding)) return
        binding.connection.getStats { report ->
            if (!isCurrent(binding)) return@getStats
            val route = selectedRoute(report)
            var rtt = 0.0
            var jitter = 0.0
            var lost = 0L
            var concealed = 0L
            var sent = 0L
            var received = 0L
            report.statsMap.values.forEach { stat ->
                val members = stat.members
                if (stat.type == "candidate-pair" && members["state"] == "succeeded") {
                    rtt = (members["currentRoundTripTime"] as? Number)?.toDouble()?.times(1000) ?: rtt
                }
                if (stat.type == "inbound-rtp" && members["kind"] == "audio") {
                    jitter = (members["jitter"] as? Number)?.toDouble()?.times(1000) ?: jitter
                    lost = (members["packetsLost"] as? Number)?.toLong() ?: lost
                    concealed = (members["concealedSamples"] as? Number)?.toLong() ?: concealed
                    received = (members["bytesReceived"] as? Number)?.toLong() ?: received
                }
                if (stat.type == "outbound-rtp" && members["kind"] == "audio") {
                    sent = (members["bytesSent"] as? Number)?.toLong() ?: sent
                }
            }
            statsSummary = StatsSummary(
                setupDurationMs = setupDurationMs,
                candidateType = route.candidateType,
                protocol = route.protocol,
                rttMs = rtt,
                jitterMs = jitter,
                packetsLost = lost,
                concealedSamples = concealed,
                bytesSent = sent,
                bytesReceived = received,
                iceRestartCount = restartCount,
            )
            onComplete?.invoke(route)
        }
    }

    private fun selectedRoute(report: RTCStatsReport): Route {
        val selectedPair = report.statsMap.values.firstOrNull { stat ->
            stat.type == "candidate-pair" && stat.members["state"] == "succeeded" &&
                (stat.members["nominated"] == true || stat.members["selected"] == true)
        }
        val localId = selectedPair?.members?.get("localCandidateId") as? String
        val local = localId?.let(report.statsMap::get)
        return Route(
            candidateType = (local?.members?.get("candidateType") as? String)?.takeIf { it in setOf("host", "srflx", "relay") } ?: "host",
            protocol = local?.members?.get("relayProtocol") as? String
                ?: local?.members?.get("protocol") as? String
                ?: "unknown",
        )
    }

    private fun applyAudioDirection() {
        localTrack?.setEnabled(mode.get() != RelayMode.TALK && !explicitlyMuted.get())
        // Playback gain is applied exactly once by renderProcessor so the
        // samples used by the echo guard match what reaches Android's speaker.
        remoteTrack?.setVolume(1.0)
    }

    private fun fail(code: String, message: String, expectedBinding: ConnectionBinding? = null) {
        val binding = expectedBinding ?: currentConnectionBinding() ?: return
        if (!isCurrent(binding)) return
        runCatching { signal.send("media_failed", binding.callId, JSONObject().put("reason", code)) }
        RelayRuntime.update { it.copy(mediaState = "Failed", error = message) }
        listener.onMediaFailed(code, message)
    }

    private fun iceServer(server: RelayApiClient.IceServer): PeerConnection.IceServer =
        PeerConnection.IceServer.builder(server.urls)
            .setUsername(server.username)
            .setPassword(server.credential)
            .createIceServer()

    private val captureProcessor = object : ExternalAudioProcessingFactory.AudioProcessing {
        override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
        override fun reset(newRate: Int) = Unit
        override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) {
            val echoGuardActive = mode.get() == RelayMode.FULL_DUPLEX &&
                echoGuard.shouldGateCapture(SystemClock.elapsedRealtime())
            val level = gainProcessor.processPcm16(
                buffer,
                buffer.capacity(),
                preferences.captureGain,
                mode.get() == RelayMode.TALK || explicitlyMuted.get() || echoGuardActive,
            )
            RelayRuntime.update { it.copy(captureRms = level.rms, capturePeak = level.peak) }
        }
    }

    private val renderProcessor = object : ExternalAudioProcessingFactory.AudioProcessing {
        override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
        override fun reset(newRate: Int) = Unit
        override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) {
            val level = gainProcessor.processPcm16(
                buffer,
                buffer.capacity(),
                preferences.playbackGain.toFloat(),
                mode.get() == RelayMode.LISTEN,
            )
            if (mode.get() != RelayMode.LISTEN) {
                echoGuard.observePeerRender(level.rms, level.peak, SystemClock.elapsedRealtime())
            }
        }
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    private data class Route(val candidateType: String, val protocol: String)

    private enum class MediaLifecycle { IDLE, CONNECTING, ACTIVE, CLOSING }

    companion object {
        private const val DIRECT_TIMEOUT_MS = 8_000L
        private const val SETUP_TIMEOUT_MS = 20_000L
        private val NEGOTIATION_SCOPED_MESSAGES = setOf("answer", "ice_candidates", "ice_complete")
    }
}
