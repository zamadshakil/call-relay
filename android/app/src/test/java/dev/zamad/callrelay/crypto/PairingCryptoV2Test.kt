package dev.zamad.callrelay.crypto

import java.math.BigInteger
import java.security.AlgorithmParameters
import java.security.KeyFactory
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECPrivateKeySpec
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PairingCryptoV2Test {
    @Test
    fun derivesBrowserCompatibleGoldenVector() {
        val parameters = AlgorithmParameters.getInstance("EC").apply {
            init(ECGenParameterSpec("secp256r1"))
        }.getParameterSpec(java.security.spec.ECParameterSpec::class.java)
        val privateKey = KeyFactory.getInstance("EC").generatePrivate(
            ECPrivateKeySpec(
                BigInteger(1, PairingCryptoV2.decode("2svvLbe8g8D7e-F10BbtOUtP0cK9T11T3jyTt-9wXZI")),
                parameters,
            ),
        )
        val peerPublic = "BOucf96-wMdY7lu44K2pj62BdPX_KzSQu6AYF6hAlvSE_JuZOlp2gy8Q06l43pXmsryCaX2RBd63hbR7F8KQGYw"
        val challenge = ByteArray(32) { it.toByte() }
        val secret = PairingCryptoV2.deriveSecret(privateKey, PairingCryptoV2.decodePublicKey(peerPublic), challenge)
        assertEquals("w4A2crfb1uTGkkQ7fsKBiuk-lCqrsbqEBIxUOc5f4NA", PairingCryptoV2.encode(secret))
        val commitment = PairingCryptoV2.commitment(secret)
        assertEquals("_zfMsRazpSzuP3E-CG7AUHoJn8zs8lBows_NmBAGS6Y", commitment)
        assertTrue(PairingCryptoV2.verifyPeerProof(
            secret,
            "XaC1HMn4GEAhJQfcHB2XmA7W7UYm-LoAAOuo20w65Jk",
            "inv_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            peerPublic,
            commitment,
        ))
    }
}
