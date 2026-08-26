package dev.zamad.callrelay.relay

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaRecorder
import dev.zamad.callrelay.audio.CaptureSampleRateSelector
import dev.zamad.callrelay.audio.PcmGainProcessor
import dev.zamad.callrelay.network.PairingSignalClient
import dev.zamad.callrelay.network.RelayApiClient
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONArray
import org.json.JSONObject

class WebRtcRelaySession(
    context: Context,
    private val preferences: RelayPreferences,
    private val api: RelayApiClient,
    private val signal: PairingSignalClient,
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
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var factory: PeerConnectionFactory? = null
    private var audioModule: JavaAudioDeviceModule? = null
    private var audioProcessing: ExternalAudioProcessingFactory? = null
    private var audioSource: AudioSource? = null
    private var localTrack: AudioTrack? = null
    private var remoteTrack: AudioTrack? = null
    private var peerConnection: PeerConnection? = null
    private var callId = ""
    private var mediaConfig: RelayApiClient.MediaConfig? = null
    private var icePolicy = "all"
    private var setupStartedAt = 0L
    private var setupDurationMs = 0L
    private var directTimer: Job? = null
    private var failureTimer: Job? = null
    private var refreshTimer: Job? = null
    private var statsTimer: Job? = null
    private var restartCount = 0
    @Volatile private var statsSummary = StatsSummary()

    suspend fun connect(nextCallId: String) {
        require(nextCallId.matches(Regex("^call_[a-f0-9]{32}$"))) { "Call ID is invalid" }
        disconnect()
        signal.awaitConnected()
        callId = nextCallId
        setupStartedAt = System.currentTimeMillis()
        setupDurationMs = 0L
        icePolicy = "all"
        restartCount = 0
        RelayRuntime.update { it.copy(mediaState = "Requesting Cloudflare STUN/TURN", error = null) }
        mediaConfig = api.mediaConfig(nextCallId)
        initializeFactory()
        createPeerConnection()
        createAndSendOffer(iceRestart = false)
        RelayRuntime.update { it.copy(mediaState = "Connecting direct-first WebRTC") }
        startDeadlines()
        scheduleCredentialRefresh()
    }

    suspend fun handleSignal(type: String, payload: JSONObject, envelopeCallId: String) {
        if (envelopeCallId != callId || callId.isBlank()) return
        when (type) {
            "answer" -> {
                val answer = SessionDescription(SessionDescription.Type.ANSWER, payload.getString("sdp"))
                setRemoteDescription(answer)
                synchronized(pendingCandidates) {
                    pendingCandidates.toList().also { pendingCandidates.clear() }
                }.forEach { peerConnection?.addIceCandidate(it) }
            }
            "ice_candidates" -> {
                val candidates = payload.getJSONArray("candidates")
                check(candidates.length() <= 128) { "Too many ICE candidates" }
                for (index in 0 until candidates.length()) {
                    val value = candidates.getJSONObject(index)
                    val candidate = IceCandidate(
                        value.optString("sdpMid", "0"),
                        value.getInt("sdpMLineIndex"),
                        value.getString("candidate"),
                    )
                    if (peerConnection?.remoteDescription != null) peerConnection?.addIceCandidate(candidate)
                    else synchronized(pendingCandidates) { pendingCandidates += candidate }
                }
            }
            "ice_complete" -> Unit
            "ice_restart_request" -> restartIce(payload.optString("reason", "peer_request"), forceRelay = true)
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
        if (callId.isNotBlank() && peerConnection != null) scope.launch { restartIce("network_change", forceRelay = false) }
    }

    fun disconnect() {
        directTimer?.cancel()
        failureTimer?.cancel()
        refreshTimer?.cancel()
        statsTimer?.cancel()
        directTimer = null
        failureTimer = null
        refreshTimer = null
        statsTimer = null
        connected.set(false)
        remoteTrack = null
        peerConnection?.close()
        peerConnection?.dispose()
        peerConnection = null
        localTrack?.dispose()
        localTrack = null
        audioSource?.dispose()
        audioSource = null
        factory?.dispose()
        factory = null
        audioModule?.release()
        audioModule = null
        audioProcessing?.destroy()
        audioProcessing = null
        synchronized(pendingCandidates) { pendingCandidates.clear() }
        callId = ""
        mediaConfig = null
        RelayRuntime.update { it.copy(mediaState = "Disconnected", captureRms = 0.0, capturePeak = 0) }
    }

    private fun initializeFactory() {
        synchronized(initializationLock) {
            if (!initialized) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(appContext)
                        .createInitializationOptions(),
                )
                initialized = true
            }
        }
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        appContext.getSystemService(AudioManager::class.java).mode = AudioManager.MODE_NORMAL
        val processing = ExternalAudioProcessingFactory().apply {
            setCapturePostProcessing(captureProcessor)
            setRenderPreProcessing(renderProcessor)
        }
        val module = JavaAudioDeviceModule.builder(appContext)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
            .setInputSampleRate(CaptureSampleRateSelector.choose(appContext))
            .setOutputSampleRate(SAMPLE_RATE_HZ)
            .setAudioAttributes(attributes)
            .setUseLowLatency(true)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoInput(false)
            .setUseStereoOutput(false)
            .createAudioDeviceModule()
        audioProcessing = processing
        audioModule = module
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(module)
            .setAudioProcessingFactory(processing)
            .createPeerConnectionFactory()
    }

    private fun createPeerConnection() {
        val createdFactory = checkNotNull(factory)
        val config = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
            iceTransportsType = PeerConnection.IceTransportsType.ALL
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        val connection = checkNotNull(createdFactory.createPeerConnection(config, observer)) { "WebRTC peer connection creation failed" }
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
        applyAudioDirection()
    }

    private suspend fun createAndSendOffer(iceRestart: Boolean) {
        val constraints = MediaConstraints()
        if (iceRestart) constraints.mandatory += MediaConstraints.KeyValuePair("IceRestart", "true")
        val offer = createOffer(constraints)
        setLocalDescription(offer)
        signal.send(
            "offer",
            callId,
            JSONObject().put("sdp", offer.description).put("icePolicy", icePolicy),
        )
    }

    private suspend fun createOffer(constraints: MediaConstraints): SessionDescription = suspendCancellableCoroutine { continuation ->
        peerConnection?.createOffer(object : SimpleSdpObserver() {
            override fun onCreateSuccess(description: SessionDescription) {
                if (continuation.isActive) continuation.resume(description)
            }
            override fun onCreateFailure(error: String) {
                if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error))
            }
        }, constraints) ?: continuation.resumeWithException(IllegalStateException("WebRTC is disconnected"))
    }

    private suspend fun setLocalDescription(description: SessionDescription): Unit = suspendCancellableCoroutine { continuation ->
        peerConnection?.setLocalDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() { if (continuation.isActive) continuation.resume(Unit) }
            override fun onSetFailure(error: String) { if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error)) }
        }, description) ?: continuation.resumeWithException(IllegalStateException("WebRTC is disconnected"))
    }

    private suspend fun setRemoteDescription(description: SessionDescription): Unit = suspendCancellableCoroutine { continuation ->
        peerConnection?.setRemoteDescription(object : SimpleSdpObserver() {
            override fun onSetSuccess() { if (continuation.isActive) continuation.resume(Unit) }
            override fun onSetFailure(error: String) { if (continuation.isActive) continuation.resumeWithException(IllegalStateException(error)) }
        }, description) ?: continuation.resumeWithException(IllegalStateException("WebRTC is disconnected"))
    }

    private val observer = object : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE && callId.isNotBlank()) {
                runCatching { signal.send("ice_complete", callId, JSONObject()) }
            }
        }

        override fun onIceCandidate(candidate: IceCandidate) {
            if (callId.isBlank()) return
            val payload = JSONObject().put(
                "candidates",
                JSONArray().put(
                    JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex),
                ),
            )
            runCatching { signal.send("ice_candidates", callId, payload) }
                .onFailure { fail("signaling_send_failed", it.message ?: "ICE signaling failed") }
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {
            if (state == PeerConnection.IceConnectionState.FAILED) {
                connected.set(false)
                scope.launch { forceRelayAndRestart("ice_failed") }
            }
        }

        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) {
            when (state) {
                PeerConnection.PeerConnectionState.CONNECTED -> becameConnected()
                PeerConnection.PeerConnectionState.DISCONNECTED -> connected.set(false)
                PeerConnection.PeerConnectionState.FAILED -> {
                    connected.set(false)
                    scope.launch { forceRelayAndRestart("connection_failed") }
                }
                else -> Unit
            }
        }

        override fun onTrack(transceiver: RtpTransceiver) {
            val track = transceiver.receiver.track() as? AudioTrack ?: return
            remoteTrack = track
            applyAudioDirection()
        }
    }

    private fun becameConnected() {
        if (!connected.compareAndSet(false, true)) return
        if (setupDurationMs == 0L) setupDurationMs = (System.currentTimeMillis() - setupStartedAt).coerceAtLeast(0)
        directTimer?.cancel()
        failureTimer?.cancel()
        RelayRuntime.update { it.copy(mediaState = "Connected WebRTC ($icePolicy)") }
        runCatching { signal.send("media_ready", callId, JSONObject().put("icePolicy", icePolicy)) }
        updateStats { route -> listener.onMediaConnected(route.candidateType, icePolicy) }
        statsTimer?.cancel()
        statsTimer = scope.launch {
            while (connected.get()) {
                delay(5_000)
                updateStats()
            }
        }
    }

    private fun startDeadlines() {
        directTimer = scope.launch {
            delay(DIRECT_TIMEOUT_MS)
            if (!connected.get()) forceRelayAndRestart("direct_timeout")
        }
        failureTimer = scope.launch {
            delay(SETUP_TIMEOUT_MS)
            if (!connected.get()) fail("ice_timeout", "WebRTC did not connect within 20 seconds")
        }
    }

    private suspend fun forceRelayAndRestart(reason: String) {
        if (connected.get() || icePolicy == "relay") return
        restartIce(reason, forceRelay = true)
    }

    private suspend fun restartIce(reason: String, forceRelay: Boolean) {
        val connection = peerConnection ?: return
        if (forceRelay) {
            icePolicy = "relay"
            val config = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
                iceTransportsType = PeerConnection.IceTransportsType.RELAY
                bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
                sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            }
            check(connection.setConfiguration(config)) { "Could not force Cloudflare TURN" }
        }
        restartCount += 1
        connected.set(false)
        RelayRuntime.update { it.copy(mediaState = "Restarting WebRTC: $reason") }
        runCatching {
            api.event(
                callId,
                "media_restarting",
                payload = JSONObject().put("reason", reason).put("icePolicy", icePolicy),
            )
        }
        connection.restartIce()
        createAndSendOffer(iceRestart = true)
    }

    private fun scheduleCredentialRefresh() {
        refreshTimer?.cancel()
        val config = mediaConfig ?: return
        val delayMs = ((config.credentialsExpiresAt - System.currentTimeMillis()) * 3 / 4).coerceAtLeast(60_000L)
        refreshTimer = scope.launch {
            delay(delayMs)
            runCatching {
                mediaConfig = api.mediaConfig(callId)
                val connection = checkNotNull(peerConnection)
                val updated = PeerConnection.RTCConfiguration(checkNotNull(mediaConfig).iceServers.map(::iceServer)).apply {
                    iceTransportsType = if (icePolicy == "relay") PeerConnection.IceTransportsType.RELAY else PeerConnection.IceTransportsType.ALL
                    bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
                    rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
                    sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
                    continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
                }
                check(connection.setConfiguration(updated)) { "TURN credential refresh was rejected" }
                scheduleCredentialRefresh()
            }.onFailure { fail("turn_refresh_failed", it.message ?: "TURN credential refresh failed") }
        }
    }

    private fun updateStats(onComplete: ((Route) -> Unit)? = null) {
        val connection = peerConnection ?: return
        connection.getStats { report ->
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
        remoteTrack?.setVolume(1.0)
    }

    private fun fail(code: String, message: String) {
        if (callId.isBlank()) return
        runCatching { signal.send("media_failed", callId, JSONObject().put("reason", code)) }
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
            val level = gainProcessor.processPcm16(
                buffer,
                buffer.capacity(),
                preferences.captureGain,
                mode.get() == RelayMode.TALK || explicitlyMuted.get(),
            )
            RelayRuntime.update { it.copy(captureRms = level.rms, capturePeak = level.peak) }
        }
    }

    private val renderProcessor = object : ExternalAudioProcessingFactory.AudioProcessing {
        override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
        override fun reset(newRate: Int) = Unit
        override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) {
            gainProcessor.processPcm16(
                buffer,
                buffer.capacity(),
                preferences.playbackGain.toFloat(),
                mode.get() == RelayMode.LISTEN,
            )
        }
    }

    private open class SimpleSdpObserver : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String) = Unit
        override fun onSetFailure(error: String) = Unit
    }

    private data class Route(val candidateType: String, val protocol: String)

    companion object {
        private const val SAMPLE_RATE_HZ = 48_000
        private const val DIRECT_TIMEOUT_MS = 8_000L
        private const val SETUP_TIMEOUT_MS = 20_000L
        private val initializationLock = Any()
        @Volatile private var initialized = false
    }
}
