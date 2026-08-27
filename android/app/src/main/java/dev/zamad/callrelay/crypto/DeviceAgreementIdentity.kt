package dev.zamad.callrelay.crypto

import android.content.Context
import android.util.Base64
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.PKCS8EncodedKeySpec
import java.security.spec.X509EncodedKeySpec
import org.json.JSONObject

/** P-256 ECDH identity encrypted at rest by an Android Keystore AES key. */
class DeviceAgreementIdentity(context: Context) {
    private val secureStore = SecureSecretStore(context)
    private val keyPair: KeyPair by lazy(::loadOrCreate)

    fun publicKeyRaw(): String = base64Url(PairingCryptoV2.publicKeyRaw(keyPair.public as ECPublicKey))

    fun deriveSecret(peerPublicKeyRaw: String, challenge: ByteArray): ByteArray =
        PairingCryptoV2.deriveSecret(keyPair.private, PairingCryptoV2.decodePublicKey(peerPublicKeyRaw), challenge)

    private fun loadOrCreate(): KeyPair {
        secureStore.get(STORE_KEY)?.let { encoded ->
            runCatching {
                val json = JSONObject(encoded)
                val factory = KeyFactory.getInstance("EC")
                return KeyPair(
                    factory.generatePublic(X509EncodedKeySpec(base64UrlDecode(json.getString("public")))),
                    factory.generatePrivate(PKCS8EncodedKeySpec(base64UrlDecode(json.getString("private")))),
                )
            }
        }
        val generated = KeyPairGenerator.getInstance("EC").run {
            initialize(ECGenParameterSpec("secp256r1"))
            generateKeyPair()
        }
        secureStore.put(
            STORE_KEY,
            JSONObject()
                .put("public", base64Url(generated.public.encoded))
                .put("private", base64Url(generated.private.encoded))
                .toString(),
        )
        return generated
    }

    private fun base64Url(bytes: ByteArray): String = Base64.encodeToString(
        bytes,
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

    private fun base64UrlDecode(value: String): ByteArray = Base64.decode(
        value,
        Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
    )

    companion object {
        private const val STORE_KEY = "device_agreement_identity_v2"
    }
}
