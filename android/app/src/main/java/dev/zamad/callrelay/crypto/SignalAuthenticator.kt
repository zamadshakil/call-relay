package dev.zamad.callrelay.crypto

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object SignalAuthenticator {
    private const val INFO = "call-relay/signaling/v1"

    fun mac(pairingSecretBase64Url: String, callId: String, canonical: String): String = encode(
        hmac(deriveKey(pairingSecretBase64Url, callId), canonical.encodeToByteArray()),
    )

    fun verify(pairingSecretBase64Url: String, callId: String, canonical: String, encodedMac: String): Boolean = runCatching {
        MessageDigest.isEqual(
            hmac(deriveKey(pairingSecretBase64Url, callId), canonical.encodeToByteArray()),
            Base64.getUrlDecoder().decode(encodedMac),
        )
    }.getOrDefault(false)

    private fun deriveKey(pairingSecretBase64Url: String, callId: String): ByteArray {
        val inputKey = Base64.getUrlDecoder().decode(pairingSecretBase64Url)
        require(inputKey.size == 32) { "Pairing secret must contain exactly 32 bytes" }
        val pseudoRandomKey = hmac(callId.encodeToByteArray(), inputKey)
        return hmac(pseudoRandomKey, INFO.encodeToByteArray() + byteArrayOf(1))
    }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
    }

    private fun encode(value: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(value)
}
