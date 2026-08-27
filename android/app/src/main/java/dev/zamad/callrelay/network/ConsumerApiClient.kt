package dev.zamad.callrelay.network

import dev.zamad.callrelay.BuildConfig
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject

class ConsumerApiClient(private val tokenProvider: suspend (forceRefresh: Boolean) -> String) {
    suspend fun session(): JSONObject = request("POST", "/v1/auth/session", "{}")
    suspend fun me(): JSONObject = request("GET", "/v1/me", "")
    suspend fun plans(): JSONObject = request("GET", "/v1/billing/plans", "")

    suspend fun checkout(plan: String): String = request(
        "POST",
        "/v1/billing/checkout",
        JSONObject().put("plan", plan).put("returnTarget", "android").toString(),
    ).getString("checkoutUrl")

    suspend fun portal(): String = request("POST", "/v1/billing/portal", "{}").getString("portalUrl")

    suspend fun registerAndroid(
        displayName: String,
        publicKeySpki: String,
        agreementPublicKeyRaw: String,
        fcmInstallationId: String?,
        replaceExisting: Boolean = false,
    ): String = request(
        "POST",
        "/v1/devices/register",
        JSONObject()
            .put("platform", "android")
            .put("displayName", displayName)
            .put("publicKeySpki", publicKeySpki)
            .put("agreementPublicKeyRaw", agreementPublicKeyRaw)
            .put("appVersion", BuildConfig.VERSION_CODE)
            .put("replaceExisting", replaceExisting)
            .apply { if (!fcmInstallationId.isNullOrBlank()) put("fcmInstallationId", fcmInstallationId) }
            .toString(),
    ).getString("deviceId")

    suspend fun revoke(deviceId: String) {
        request("POST", "/v1/devices/$deviceId/revoke", "{}")
    }

    private suspend fun request(method: String, path: String, body: String): JSONObject = withContext(Dispatchers.IO) {
        var lastAuthenticationFailure: ConsumerApiException? = null
        for (authenticationAttempt in 0..1) {
            val connection = URL(BuildConfig.DEFAULT_API_BASE_URL + path).openConnection() as HttpURLConnection
            try {
                val bytes = body.encodeToByteArray()
                connection.requestMethod = method
                connection.connectTimeout = 10_000
                connection.readTimeout = 20_000
                connection.setRequestProperty("accept", "application/json")
                connection.setRequestProperty("content-type", "application/json")
                connection.setRequestProperty("authorization", "Bearer ${tokenProvider(authenticationAttempt > 0)}")
                connection.setRequestProperty("x-relay-app-version", "android-webrtc-${BuildConfig.VERSION_CODE}")
                if (method != "GET" && method != "HEAD") {
                    connection.doOutput = true
                    connection.outputStream.use { it.write(bytes) }
                }
                val status = connection.responseCode
                val text = (if (status in 200..299) connection.inputStream else connection.errorStream)
                    ?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = if (text.isBlank()) JSONObject() else runCatching { JSONObject(text) }
                    .getOrElse { JSONObject().put("error", "Service returned an invalid response") }
                if (status !in 200..299) {
                    val failure = ConsumerApiException(
                        status = status,
                        code = json.optString("code").ifBlank { null },
                        message = json.optString("error", "Request failed ($status)"),
                    )
                    if (status == 401 && authenticationAttempt == 0) {
                        lastAuthenticationFailure = failure
                        continue
                    }
                    throw failure
                }
                return@withContext json
            } finally {
                connection.disconnect()
            }
        }
        throw lastAuthenticationFailure ?: ConsumerApiException(401, null, "Secure session refresh failed")
    }
}

class ConsumerApiException(
    val status: Int,
    val code: String?,
    message: String,
) : IOException(message)
