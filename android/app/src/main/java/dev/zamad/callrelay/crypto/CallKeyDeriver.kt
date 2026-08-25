package dev.zamad.callrelay.crypto

import java.security.MessageDigest
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object CallKeyDeriver {
    private const val INFO = "call-relay-e2ee-v1"

    fun derivePassphrase(pairingSecretBase64Url: String, callId: String): String {
        val inputKey = decodeSecret(pairingSecretBase64Url)
        val salt = callId.encodeToByteArray()
        val pseudoRandomKey = hmac(salt, inputKey)
        val output = hmac(pseudoRandomKey, INFO.encodeToByteArray() + byteArrayOf(1))
        return Base64.getUrlEncoder().withoutPadding().encodeToString(output)
    }

    fun secretCommitment(pairingSecretBase64Url: String): String = Base64.getUrlEncoder().withoutPadding().encodeToString(
        MessageDigest.getInstance("SHA-256").digest(decodeSecret(pairingSecretBase64Url)),
    )

    private fun decodeSecret(value: String): ByteArray = Base64.getUrlDecoder().decode(value)
        .also { require(it.size == 32) { "Pairing secret must contain exactly 32 bytes" } }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(data)
    }
}
