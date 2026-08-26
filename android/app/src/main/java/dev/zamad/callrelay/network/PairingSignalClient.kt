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
) {
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
    )

    interface Listener {
        fun onSignalState(state: String)
        fun onPeerPresence(online: Boolean)
        fun onCallSnapshot(call: CallSnapshot)
        fun onEnvelope(type: String, payload: JSONObject, callId: String)
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
    @Volatile private var socket: WebSocket? = null
    @Volatile private var sessionId = ""
    @Volatile private var currentCall: CallSnapshot? = null
    @Volatile private var peerOnline = false
    @Volatile private var wanted = false
    private var connectJob: Job? = null

    fun start() {
        if (wanted) return
        wanted = true
        connectJob = scope.launch {
            var attempt = 0
            while (isActive && wanted) {
                if (sessionId.isNotBlank()) {
                    delay(250)
                    continue
                }
                runCatching { openSocket() }
                    .onFailure { listener.onSignalError(it.message ?: "Signaling connection failed") }
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

    suspend fun awaitConnected(timeoutMs: Long = 10_000L) {
        start()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (sessionId.isBlank()) {
            check(System.currentTimeMillis() < deadline) { "Cloudflare signaling did not connect" }
            delay(50)
        }
    }

    fun isPeerOnline(): Boolean = peerOnline

    fun send(type: String, callId: String, payload: JSONObject) {
        val connectedSocket = socket ?: error("Cloudflare signaling is disconnected")
        val connectedSession = sessionId.ifBlank { error("Cloudflare signaling is not authenticated") }
        val sequence = sendSequence.incrementAndGet()
        val timestamp = System.currentTimeMillis()
        val encodedPayload = Base64.encodeToString(
            payload.toString().encodeToByteArray(),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        )
        val canonical = canonical(
            callId = callId,
            senderDeviceId = preferences.deviceId,
            role = "android",
            sessionId = connectedSession,
            sequence = sequence,
            timestamp = timestamp,
            type = type,
            payload = encodedPayload,
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
            .put("mac", SignalAuthenticator.mac(preferences.pairingSecret, callId, canonical))
        check(connectedSocket.send(envelope.toString())) { "Cloudflare signaling send failed" }
    }

    fun close() {
        wanted = false
        connectJob?.cancel()
        connectJob = null
        socket?.close(1000, "relay ready stopped")
        socket = null
        sessionId = ""
        peerOnline = false
        currentCall = null
        scope.cancel()
        client.dispatcher.executorService.shutdown()
        client.connectionPool.evictAll()
    }

    private suspend fun openSocket() {
        check(preferences.configured()) { "Enroll and confirm pairing before signaling" }
        val ticket = api.signalTicket()
        check(ticket.protocol == PROTOCOL) { "Worker returned an unsupported signaling protocol" }
        val webSocketUrl = preferences.apiBaseUrl
            .replaceFirst("https://", "wss://") + "/v1/pairings/${preferences.pairingId}/signal"
        val request = Request.Builder()
            .url(webSocketUrl)
            .header("Sec-WebSocket-Protocol", "$PROTOCOL, cr-ticket.${ticket.ticket}")
            .build()
        listener.onSignalState("Connecting")
        socket = client.newWebSocket(request, socketListener)
        val deadline = System.currentTimeMillis() + 10_000L
        while (wanted && sessionId.isBlank() && socket != null) {
            check(System.currentTimeMillis() < deadline) { "Signaling session hello timed out" }
            delay(50)
        }
    }

    private val socketListener = object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) {
            runCatching { handleMessage(text) }
                .onFailure { listener.onSignalError(it.message ?: "Invalid signaling message") }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = disconnected(webSocket)

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            listener.onSignalError(t.message ?: "Signaling WebSocket failed")
            disconnected(webSocket)
        }
    }

    private fun disconnected(webSocket: WebSocket) {
        if (socket === webSocket) {
            socket = null
            sessionId = ""
            peerOnline = false
            listener.onPeerPresence(false)
            listener.onSignalState("Disconnected")
        }
    }

    private fun handleMessage(text: String) {
        val message = JSONObject(text)
        when (message.optString("type")) {
            "hello" -> {
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
                )
                check(call.androidDeviceId == preferences.deviceId) { "Call snapshot belongs to another Android" }
                val existing = currentCall
                if (existing?.id == call.id && existing.version >= call.version) return
                if (existing != null && existing.id != call.id && existing.createdAt > call.createdAt) return
                currentCall = call.takeUnless { it.state == "ended" || it.state == "failed" }
                listener.onCallSnapshot(call)
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
        val call = currentCall
        check(call != null && call.id == callId && sender == call.peerDeviceId && role == "peer") { "Signal sender is not the paired peer" }
        check(kotlin.math.abs(System.currentTimeMillis() - timestamp) <= 5 * 60_000L) { "Signal timestamp is stale" }
        check(sequence > (remoteSequences[remoteSession] ?: 0L)) { "Signal replay was rejected" }
        val canonical = canonical(callId, sender, role, remoteSession, sequence, timestamp, type, payload)
        check(SignalAuthenticator.verify(preferences.pairingSecret, callId, canonical, message.getString("mac"))) {
            "Signal HMAC verification failed"
        }
        remoteSequences[remoteSession] = sequence
        val decoded = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
        listener.onEnvelope(type, JSONObject(decoded), callId)
    }

    private fun canonical(
        callId: String,
        senderDeviceId: String,
        role: String,
        sessionId: String,
        sequence: Long,
        timestamp: Long,
        type: String,
        payload: String,
    ): String = listOf(1, callId, senderDeviceId, role, sessionId, sequence, timestamp, type, payload).joinToString("\n")

    companion object {
        const val PROTOCOL = "call-relay.signal.v1"
    }
}
