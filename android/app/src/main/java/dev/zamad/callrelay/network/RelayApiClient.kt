package dev.zamad.callrelay.network

import dev.zamad.callrelay.crypto.DeviceIdentity
import dev.zamad.callrelay.crypto.CallKeyDeriver
import dev.zamad.callrelay.relay.RelayPreferences
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import org.json.JSONObject

class RelayApiClient(
    private val preferences: RelayPreferences,
    private val identity: DeviceIdentity = DeviceIdentity(),
) {
    data class IceServer(
        val urls: List<String>,
        val username: String,
        val credential: String,
    )

    data class MediaConfig(
        val iceServers: List<IceServer>,
        val credentialsExpiresAt: Long,
    )

    data class SignalTicket(val ticket: String, val protocol: String, val expiresAt: Long)

    data class CreatedCall(val callId: String, val state: String)

    suspend fun enroll(invite: String, displayName: String, fcmToken: String?): String = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("platform", "android")
            .put("displayName", displayName)
            .put("publicKeySpki", identity.publicKeySpki())
            .apply { if (!fcmToken.isNullOrBlank()) put("fcmToken", fcmToken) }
            .toString()
        val response = request(
            method = "POST",
            path = "/v1/devices/enroll",
            body = body,
            signed = false,
            extraHeaders = mapOf("x-enrollment-invite" to invite),
        )
        response.getString("deviceId").also { preferences.deviceId = it }
    }

    suspend fun createIncomingCall(): CreatedCall = withContext(Dispatchers.IO) {
        val response = request(
            method = "POST",
            path = "/v1/calls/incoming",
            body = JSONObject()
                .put("pairingId", preferences.pairingId)
                .put("requestId", UUID.randomUUID().toString())
                .toString(),
            attempts = 3,
        )
        CreatedCall(response.getString("callId"), response.getString("state"))
    }

    suspend fun confirmPairing(pairingId: String, pairingSecret: String) = withContext(Dispatchers.IO) {
        request(
            method = "POST",
            path = "/v1/pairings/$pairingId/confirm",
            body = JSONObject().put("secretCommitment", CallKeyDeriver.secretCommitment(pairingSecret)).toString(),
            attempts = 3,
        )
        Unit
    }

    suspend fun mediaConfig(callId: String): MediaConfig = withContext(Dispatchers.IO) {
        val response = request("POST", "/v1/calls/$callId/media-config", "{}", attempts = 2)
        check(response.getString("transport") == "webrtc_p2p") { "Worker returned an unsupported media transport" }
        check(response.getString("offerer") == "android") { "Worker assigned the wrong WebRTC offerer" }
        check(response.getInt("protocolVersion") == 1) { "Worker returned an unsupported media protocol" }
        val servers = response.getJSONArray("iceServers")
        val parsed = buildList {
            for (index in 0 until servers.length()) {
                val server = servers.getJSONObject(index)
                val rawUrls = server.get("urls")
                val urls = when (rawUrls) {
                    is String -> listOf(rawUrls)
                    is org.json.JSONArray -> buildList { for (urlIndex in 0 until rawUrls.length()) add(rawUrls.getString(urlIndex)) }
                    else -> error("Worker returned invalid ICE server URLs")
                }
                check(urls.isNotEmpty() && urls.all { it.startsWith("stun:") || it.startsWith("turn:") || it.startsWith("turns:") }) {
                    "Worker returned invalid ICE server URLs"
                }
                add(IceServer(urls, server.optString("username"), server.optString("credential")))
            }
        }
        check(parsed.any { server -> server.urls.any { it.startsWith("turn") } }) { "Worker did not return Cloudflare TURN" }
        MediaConfig(parsed, response.getLong("credentialsExpiresAt"))
    }

    suspend fun signalTicket(): SignalTicket = withContext(Dispatchers.IO) {
        val response = request("POST", "/v1/pairings/${preferences.pairingId}/signal-ticket", "{}", attempts = 2)
        SignalTicket(response.getString("ticket"), response.getString("protocol"), response.getLong("expiresAt"))
    }

    suspend fun updatePushToken(fcmToken: String) = withContext(Dispatchers.IO) {
        request(
            "POST",
            "/v1/devices/push-token",
            JSONObject().put("fcmToken", fcmToken).toString(),
        )
        Unit
    }

    suspend fun event(callId: String, type: String, code: String? = null, payload: JSONObject? = null) = withContext(Dispatchers.IO) {
        val body = JSONObject()
            .put("type", type)
            .put("commandId", UUID.randomUUID().toString())
            .apply {
                if (code != null) put("code", code)
                if (payload != null) put("payload", payload)
            }
            .toString()
        request("POST", "/v1/calls/$callId/events", body, attempts = 3)
        Unit
    }

    private suspend fun request(
        method: String,
        path: String,
        body: String,
        signed: Boolean = true,
        extraHeaders: Map<String, String> = emptyMap(),
        attempts: Int = 1,
    ): JSONObject {
        var lastFailure: Throwable? = null
        val maximumAttempts = attempts.coerceIn(1, 3)
        repeat(maximumAttempts) { attempt ->
            try {
                return requestOnce(method, path, body, signed, extraHeaders)
            } catch (failure: CancellationException) {
                throw failure
            } catch (failure: Throwable) {
                lastFailure = failure
                val retryable = when (failure) {
                    is RelayApiException ->
                        failure.status == 408 || failure.status == 409 || failure.status == 429 || failure.status >= 500
                    is IOException -> true
                    else -> false
                }
                if (!retryable || attempt + 1 >= maximumAttempts) throw failure
                delay(250L * (attempt + 1))
            }
        }
        throw lastFailure ?: IllegalStateException("Relay API request failed")
    }

    private fun requestOnce(
        method: String,
        path: String,
        body: String,
        signed: Boolean,
        extraHeaders: Map<String, String>,
    ): JSONObject {
        require(preferences.apiBaseUrl.startsWith("https://")) { "Relay API must use HTTPS" }
        val timestamp = System.currentTimeMillis().toString()
        val nonce = UUID.randomUUID().toString()
        val bytes = body.encodeToByteArray()
        val connection = URL(preferences.apiBaseUrl + path).openConnection() as HttpURLConnection
        try {
            connection.apply {
                requestMethod = method
                connectTimeout = 10_000
                readTimeout = 15_000
                doInput = true
                setRequestProperty("content-type", "application/json")
                setRequestProperty("accept", "application/json")
                setRequestProperty("x-relay-app-version", "android-webrtc-2")
                extraHeaders.forEach(::setRequestProperty)
                if (signed) {
                    check(preferences.deviceId.isNotBlank()) { "Android device is not enrolled" }
                    val canonical = "$method\n$path\n${sha256Hex(bytes)}\n$timestamp\n$nonce"
                    setRequestProperty("x-relay-device", preferences.deviceId)
                    setRequestProperty("x-relay-timestamp", timestamp)
                    setRequestProperty("x-relay-nonce", nonce)
                    setRequestProperty("x-relay-signature", identity.signRawP256(canonical.encodeToByteArray()))
                }
                if (method != "GET" && method != "HEAD") {
                    doOutput = true
                    outputStream.use { it.write(bytes) }
                }
            }
            val status = connection.responseCode
            val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                ?.bufferedReader()?.use { it.readText() }.orEmpty()
            val json = if (text.isBlank()) {
                JSONObject()
            } else {
                runCatching { JSONObject(text) }.getOrElse {
                    JSONObject().put("error", "Relay API returned an invalid response ($status)")
                }
            }
            if (status !in 200..299) {
                throw RelayApiException(status, json.optString("error", "Relay API failed ($status)"))
            }
            return json
        } finally {
            connection.disconnect()
        }
    }

    private fun sha256Hex(value: ByteArray): String = MessageDigest.getInstance("SHA-256")
        .digest(value)
        .joinToString("") { "%02x".format(it) }

    private class RelayApiException(val status: Int, message: String) : IOException(message)
}
