package dev.zamad.callrelay.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SignalAuthenticatorTest {
    @Test
    fun matchesBrowserGoldenVector() {
        val secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val callId = "call_0123456789abcdef0123456789abcdef"
        val canonical = "1\n$callId\ndev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\npeer\nsession-1\n1\n1700000000000\nanswer\neyJzZHAiOiJ0ZXN0In0"
        val mac = SignalAuthenticator.mac(secret, callId, canonical)
        assertEquals("649z0zD0g5SOewjQswZhtQHSxz2zgVVAUvj-SVeHj2E", mac)
        assertTrue(SignalAuthenticator.verify(secret, callId, canonical, mac))
    }
}
