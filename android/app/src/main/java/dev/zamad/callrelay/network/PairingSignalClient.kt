package dev.zamad.callrelay.network

import android.util.Base64
import dev.zamad.callrelay.crypto.SignalAuthenticator
import dev.zamad.callrelay.relay.RelayPreferences
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class PairingSignalClient(
    private val preferences: RelayPreferences,
    private val api: RelayApiClient,
    private val listener: Listener,
    private val pairing: RelayPreferences.PairingRecord? = null,
) : SignalTransport {
    data class CallSnapshot(
        val id: String,
        val androidDeviceId: String,
        val peerDeviceId: String,
        val direction: String,
        val state: String,
        val phoneNumber: String?,
        val relayMode: String,
        val version: Int,
        val createdAt: Long,
        val selectedPairingId: String?,
        val selectedPeerDeviceId: String?,
    )

    interface Listener {
        fun onSignalState(state: String)
        fun onPeerPresence(online: Boolean)
        fun onCallSnapshot(call: CallSnapshot)
        fun onEnvelope(type: String, payload: JSONObject, callId: String, negotiationId: String?)
        fun onPairingRevoked(pairingId: String, reason: String)
        fun onSignalError(message: String)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS)
        .build()
    private val sendSequence = AtomicLong()
    private val remoteSequences = ConcurrentHashMap<String, Long>()
    private val connectionGuard = SignalingConnectionGuard<WebSocket>()
    @Volatile private var socket: WebSocket? = null
    @Volatile private var sessionId = ""
    @Volatile private var currentCall: CallSnapshot? = null
    @Volatile private var peerOnline = false
    @Volatile private var wanted = false
    @Volatile private var revocationNotified = false
    private var connectJob: Job? = null

    val pairingId: String get() = pairing?.id ?: preferences.pairingId
    private val pairingSecret: String get() = pairing?.secret ?: preferences.pairingSecret

    fun start() {
        if (wanted) return
        wanted = true
        revocationNotified = false
        connectJob = scope.launch {
            var attempt = 0
            while (isActive && wanted) {
                if (sessionId.isNotBlank()) {
                    delay(250)
                    continue
                }
                runCatching { openSocket() }
                    .onFailure { failure ->
                        if (failure is RelayApiClient.RelayApiException &&
                            failure.code in setOf("PAIRING_REVOKED", "DEVICE_REVOKED")
                        ) {
                            notifyPairingRevoked(
                                connection = null,
                                pairingId = pairingId,
                                reason = failure.code ?: "PAIRING_REVOKED",
                            )
                        } else {
                            listener.onSignalError(failure.message ?: "Signaling connection failed")
                        }
                    }
                if (sessionId.isBlank()) {
                    val wait = (500L shl attempt.coerceAtMost(4)).coerceAtMost(10_000L)
                    attempt += 1
                    delay(wait)
                } else {
                    attempt = 0
                }
            }
        }
    }

    override suspend fun awaitConnected(timeoutMs: Long) {
        start()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (sessionId.isBlank()) {
            check(System.currentTimeMillis() < deadline) { "Cloudflare signaling did not connect" }
            delay(50)
        }
    }

    fun isPeerOnline(): Boolean = peerOnline

    override fun send(type: String, callId: String, payload: JSONObject, negotiationId: String?) {
        require(negotiationId == null || NEGOTIATION_ID.matches(negotiationId)) { "Signal negotiation ID is invalid" }
        val connectedSocket = socket ?: error("Cloudflare signaling is disconnected")
        val connectedSession = sessionId.ifBlank { error("Cloudflare signaling is not authenticated") }
        val sequence = sendSequence.incrementAndGet()
        val timestamp = System.currentTimeMillis()
        val encodedPayload = Base64.encodeToString(
            payload.toString().encodeToByteArray(),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
        val canonical = canonicalSignalEnvelope(
            callId = callId,
            senderDeviceId = preferences.deviceId,
            role = "android",
            sessionId = connectedSession,
            sequence = sequence,
            timestamp = timestamp,
            type = type,
            payload = encodedPayload,
            negotiationId = negotiationId,
        )
        val envelope = JSONObject()
            .put("version", 1)
            .put("callId", callId)
            .put("senderDeviceId", preferences.deviceId)
            .put("role", "android")
            .put("sessionId", connectedSession)
            .put("sequence", sequence)
            .put("timestamp", timestamp)
            .put("type", type)
            .put("payload", encodedPayload)
            .put("mac", SignalAuthenticator.mac(pairingSecret, callId, canonical))
            .apply { if (negotiationId != null) put("negotiationId", negotiationId) }
        check(connectedSocket.send(envelope.toString())) { "Cloudflare signaling send failed" }
    }

    fun close() {
        wanted = false
        connectJob?.cancel()
        connectJob = null
        val closingSocket = socket
        closingSocket?.close(1000, "relay ready stopped")
        connectionGuard.clear(closingSocket)
        socket = null
        sessionId = ""
        peerOnline = false
        currentCall = null
        revocationNotified = false
        listener.onPeerPresence(false)
        listener.onSignalState("Disconnected")
    }

    /** Terminal cleanup for a service instance. Use [close] when it may be re-armed. */
    fun shutdown() {
        close()
        scope.cancel()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private suspend fun openSocket() {
        check(preferences.deviceId.isNotBlank() && pairingId.isNotBlank() && pairingSecret.isNotBlank()) { "Enroll and confirm pairing before signaling" }
        val activePairingId = pairingId
        val ticket = api.signalTicket(activePairingId)
        check(ticket.protocol == PROTOCOL) { "Worker returned an unsupported signaling protocol" }
        val webSocketUrl = preferences.apiBaseUrl
            .replaceFirst("https://", "wss://") + "/v1/pairings/$activePairingId/signal"
        val request = Request.Builder()
            .url(webSocketUrl)
            .header("Sec-WebSocket-Protocol", "$PROTOCOL, cr-ticket.${ticket.ticket}")
            .build()
        listener.onSignalState("Connecting")
        val createdSocket = client.newWebSocket(request, socketListener(activePairingId))
        connectionGuard.bind(createdSocket, activePairingId)
        socket = createdSocket
        val deadline = System.currentTimeMillis() + 10_000L
        while (wanted && sessionId.isBlank() && socket != null) {
            check(System.currentTimeMillis() < deadline) { "Signaling session hello timed out" }
            delay(50)
        }
    }

    private fun socketListener(pairingId: String) = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            if (connectionGuard.pairingIdIfCurrent(webSocket) != pairingId || socket !== webSocket) return
            runCatching { handleMessage(webSocket, pairingId, text) }
                .onFailure { listener.onSignalError(it.message ?: "Invalid signaling message") }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            if (connectionGuard.pairingIdIfCurrent(webSocket) != pairingId || socket !== webSocket) return
            if (code == 4003 || reason == "PAIRING_REVOKED") notifyPairingRevoked(webSocket, pairingId, reason)
            else disconnected(webSocket)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            if (connectionGuard.pairingIdIfCurrent(webSocket) != pairingId || socket !== webSocket) return
            listener.onSignalError(t.message ?: "Signaling WebSocket failed")
            disconnected(webSocket)
        }
    }

    private fun disconnected(webSocket: WebSocket) {
        if (socket === webSocket) {
            connectionGuard.clear(webSocket)
            socket = null
            sessionId = ""
            peerOnline = false
            listener.onPeerPresence(false)
            listener.onSignalState("Disconnected")
        }
    }

    private fun notifyPairingRevoked(connection: WebSocket?, pairingId: String, reason: String) {
        if (connection != null && connectionGuard.pairingIdIfCurrent(connection) != pairingId) return
        if (connection == null && this.pairingId != pairingId) return
        if (revocationNotified) return
        revocationNotified = true
        wanted = false
        connection?.close(4003, "PAIRING_REVOKED")
        connectionGuard.clear(connection)
        socket = null
        sessionId = ""
        peerOnline = false
        listener.onPeerPresence(false)
        listener.onSignalState("Pairing revoked")
        listener.onPairingRevoked(pairingId, reason.ifBlank { "PAIRING_REVOKED" })
    }

    private fun handleMessage(webSocket: WebSocket, pairingId: String, text: String) {
        if (connectionGuard.pairingIdIfCurrent(webSocket) != pairingId || socket !== webSocket) return
        val message = JSONObject(text)
        when (message.optString("type")) {
            "hello" -> {
                if (!wanted) return
                check(message.getInt("protocolVersion") == 1 && message.getString("role") == "android") {
                    "Signaling hello is invalid"
                }
                sessionId = message.getString("sessionId")
                sendSequence.set(0)
                listener.onSignalState("Connected")
            }
            "presence" -> {
                peerOnline = message.optBoolean("peer")
                listener.onPeerPresence(peerOnline)
            }
            "call_snapshot" -> {
                val value = message.getJSONObject("call")
                val call = CallSnapshot(
                    id = value.getString("id"),
                    androidDeviceId = value.getString("android_device_id"),
                    peerDeviceId = value.getString("peer_device_id"),
                    direction = value.getString("direction"),
                    state = value.getString("state"),
                    phoneNumber = value.optString("phone_number").takeIf { it.isNotBlank() && it != "null" },
                    relayMode = value.getString("relay_mode"),
                    version = value.getInt("version"),
                    createdAt = value.getLong("created_at"),
                    selectedPairingId = value.optString("selected_pairing_id").takeIf { it.isNotBlank() && it != "null" },
                    selectedPeerDeviceId = value.optString("selected_peer_device_id").takeIf { it.isNotBlank() && it != "null" },
                )
                check(call.androidDeviceId == preferences.deviceId) { "Call snapshot belongs to another Android" }
                val existing = currentCall
                if (existing?.id == call.id && existing.version >= call.version) return
                if (existing != null && existing.id != call.id && existing.createdAt > call.createdAt) return
                currentCall = call.takeUnless { it.state == "ended" || it.state == "failed" }
                listener.onCallSnapshot(call)
            }
            "pairing_revoked" -> {
                check(message.optString("code") == "PAIRING_REVOKED") { "Pairing revocation frame is invalid" }
                notifyPairingRevoked(webSocket, pairingId, message.optString("reason", "PAIRING_REVOKED"))
            }
            "protocol_error" -> listener.onSignalError(message.optString("message", "Signaling protocol error"))
            else -> handleEnvelope(message)
        }
    }

    private fun handleEnvelope(message: JSONObject) {
        check(message.getInt("version") == 1) { "Signal protocol version is invalid" }
        val callId = message.getString("callId")
        val sender = message.getString("senderDeviceId")
        val role = message.getString("role")
        val remoteSession = message.getString("sessionId")
        val sequence = message.getLong("sequence")
        val timestamp = message.getLong("timestamp")
        val type = message.getString("type")
        val payload = message.getString("payload")
        val negotiationId = message.optString("negotiationId").ifBlank { null }
        check(negotiationId == null || NEGOTIATION_ID.matches(negotiationId)) { "Signal negotiation ID is invalid" }
        val call = currentCall
        val expectedPeer = call?.selectedPeerDeviceId ?: call?.peerDeviceId
        check(call != null && call.id == callId && sender == expectedPeer && role == "peer") { "Signal sender is not the selected peer" }
        check(kotlin.math.abs(System.currentTimeMillis() - timestamp) <= 5 * 60_000L) { "Signal timestamp is stale" }
        check(sequence > (remoteSequences[remoteSession] ?: 0L)) { "Signal replay was rejected" }
        val canonical = canonicalSignalEnvelope(callId, sender, role, remoteSession, sequence, timestamp, type, payload, negotiationId)
        check(SignalAuthenticator.verify(pairingSecret, callId, canonical, message.getString("mac"))) {
            "Signal HMAC verification failed"
        }
        remoteSequences[remoteSession] = sequence
        val decoded = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        listener.onEnvelope(type, JSONObject(decoded), callId, negotiationId)
    }

    companion object {
        const val PROTOCOL = "call-relay.signal.v1"
        private val NEGOTIATION_ID = Regex("^[A-Za-z0-9_-]{8,80}$")
    }
}

internal fun canonicalSignalEnvelope(
    callId: String,
    senderDeviceId: String,
    role: String,
    sessionId: String,
    sequence: Long,
    timestamp: Long,
    type: String,
    payload: String,
    negotiationId: String? = null,
): String = buildList {
    addAll(listOf(1, callId, senderDeviceId, role, sessionId, sequence, timestamp, type, payload))
    if (negotiationId != null) add(negotiationId)
}.joinToString("\n")
