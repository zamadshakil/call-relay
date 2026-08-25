package dev.zamad.callrelay.crypto

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Signature
import java.security.spec.ECGenParameterSpec

class DeviceIdentity {
    private val keyPair: KeyPair by lazy { loadOrCreate() }

    fun publicKeySpki(): String = base64Url(keyPair.public.encoded)

    fun signRawP256(message: ByteArray): String {
        val der = Signature.getInstance("SHA256withECDSA").run {
            initSign(keyPair.private)
            update(message)
            sign()
        }
        return base64Url(derToRaw(der))
    }

    private fun loadOrCreate(): KeyPair {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        val existingPrivate = keyStore.getKey(ALIAS, null) as? java.security.PrivateKey
        val existingPublic = keyStore.getCertificate(ALIAS)?.publicKey
        if (existingPrivate != null && existingPublic != null) return KeyPair(existingPublic, existingPrivate)

        return KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore").run {
            initialize(
                KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY)
                    .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
                    .setDigests(KeyProperties.DIGEST_SHA256)
                    .setUserAuthenticationRequired(false)
                    .build(),
            )
            generateKeyPair()
        }
    }

    private fun derToRaw(der: ByteArray): ByteArray {
        require(der.size >= 8 && der[0] == 0x30.toByte()) { "Invalid ECDSA signature" }
        var offset = 1
        val (_, sequenceOffset) = readLength(der, offset)
        offset = sequenceOffset
        require(der[offset++] == 0x02.toByte()) { "Missing ECDSA r" }
        val (rLength, rOffset) = readLength(der, offset)
        offset = rOffset
        val r = der.copyOfRange(offset, offset + rLength)
        offset += rLength
        require(der[offset++] == 0x02.toByte()) { "Missing ECDSA s" }
        val (sLength, sOffset) = readLength(der, offset)
        offset = sOffset
        val s = der.copyOfRange(offset, offset + sLength)
        return unsigned32(r) + unsigned32(s)
    }

    private fun readLength(input: ByteArray, offset: Int): Pair<Int, Int> {
        val first = input[offset].toInt() and 0xff
        if (first < 0x80) return first to offset + 1
        val byteCount = first and 0x7f
        require(byteCount in 1..2 && offset + byteCount < input.size) { "Invalid DER length" }
        var length = 0
        for (index in 1..byteCount) length = (length shl 8) or (input[offset + index].toInt() and 0xff)
        return length to offset + byteCount + 1
    }

    private fun unsigned32(value: ByteArray): ByteArray {
        val withoutSign = if (value.size > 32 && value.first() == 0.toByte()) value.copyOfRange(1, value.size) else value
        require(withoutSign.size <= 32) { "ECDSA integer is too large" }
        return ByteArray(32 - withoutSign.size) + withoutSign
    }

    private fun base64Url(bytes: ByteArray): String = Base64.encodeToString(
        bytes,
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

    companion object {
        private const val ALIAS = "call-relay-device-signing-v1"
    }
}
