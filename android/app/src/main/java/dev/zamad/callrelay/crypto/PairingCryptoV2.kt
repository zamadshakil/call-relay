package dev.zamad.callrelay.crypto

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

object PairingCryptoV2 {
    fun publicKeyRaw(key: ECPublicKey): ByteArray = byteArrayOf(4) +
        unsigned32(key.w.affineX) + unsigned32(key.w.affineY)

    fun decodePublicKey(encoded: String): PublicKey {
        val raw = decode(encoded)
        require(raw.size == 65 && raw[0] == 4.toByte()) { "Invalid P-256 public key" }
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        return KeyFactory.getInstance("EC").generatePublic(
            ECPublicKeySpec(
                ECPoint(BigInteger(1, raw.copyOfRange(1, 33)), BigInteger(1, raw.copyOfRange(33, 65))),
                parameters,
            ),
        )
    }

    fun deriveSecret(privateKey: PrivateKey, peerPublicKey: PublicKey, challenge: ByteArray): ByteArray {
        require(challenge.size == 32) { "Pairing challenge must be 32 bytes" }
        val shared = KeyAgreement.getInstance("ECDH").run {
            init(privateKey)
            doPhase(peerPublicKey, true)
            generateSecret()
        }
        return hkdfSha256(shared, challenge, "call-relay/pairing/v2".encodeToByteArray(), 32)
    }

    fun commitment(secret: ByteArray): String = encode(MessageDigest.getInstance("SHA-256").digest(secret))

    fun challengeHash(challenge: ByteArray): String = encode(MessageDigest.getInstance("SHA-256").digest(challenge))

    fun verifyPeerProof(
        secret: ByteArray,
        candidate: String,
        invitationId: String,
        peerDeviceId: String,
        peerPublicKeyRaw: String,
        commitment: String,
    ): Boolean = MessageDigest.isEqual(
        decode(candidate),
        hmac(secret, listOf("peer", invitationId, peerDeviceId, peerPublicKeyRaw, commitment).joinToString("\n")),
    )

    fun androidProof(
        secret: ByteArray,
        invitationId: String,
        pairingId: String,
        androidDeviceId: String,
        peerDeviceId: String,
        commitment: String,
    ): String = encode(
        hmac(secret, listOf("android", invitationId, pairingId, androidDeviceId, peerDeviceId, commitment).joinToString("\n")),
    )

    fun encode(value: ByteArray): String = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(value)

    fun decode(value: String): ByteArray = java.util.Base64.getUrlDecoder().decode(value)

    private fun hmac(key: ByteArray, value: String): ByteArray = Mac.getInstance("HmacSHA256").run {
        init(SecretKeySpec(key, "HmacSHA256"))
        doFinal(value.encodeToByteArray())
    }

    private fun hkdfSha256(input: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val extract = Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(salt, "HmacSHA256"))
            doFinal(input)
        }
        val output = ByteArray(length)
        var previous = ByteArray(0)
        var offset = 0
        var counter = 1
        while (offset < length) {
            previous = Mac.getInstance("HmacSHA256").run {
                init(SecretKeySpec(extract, "HmacSHA256"))
                update(previous)
                update(info)
                doFinal(byteArrayOf(counter.toByte()))
            }
            val count = minOf(previous.size, length - offset)
            previous.copyInto(output, offset, 0, count)
            offset += count
            counter++
        }
        return output
    }

    private fun unsigned32(value: BigInteger): ByteArray {
        val raw = value.toByteArray()
        val unsigned = if (raw.size > 32 && raw[0] == 0.toByte()) raw.copyOfRange(1, raw.size) else raw
        require(unsigned.size <= 32) { "P-256 coordinate is too large" }
        return ByteArray(32 - unsigned.size) + unsigned
    }
}
