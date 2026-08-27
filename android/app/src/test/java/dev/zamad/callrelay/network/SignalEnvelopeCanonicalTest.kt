package dev.zamad.callrelay.network

import org.junit.Assert.assertEquals
import org.junit.Test

class SignalEnvelopeCanonicalTest {
    @Test
    fun legacyEnvelopeRemainsNineFields() {
        val canonical = canonicalSignalEnvelope("call", "device", "android", "session", 1, 2, "offer", "payload")
        assertEquals("1\ncall\ndevice\nandroid\nsession\n1\n2\noffer\npayload", canonical)
    }

    @Test
    fun negotiationIdIsAuthenticatedAsTenthField() {
        val canonical = canonicalSignalEnvelope(
            "call",
            "device",
            "android",
            "session",
            1,
            2,
            "offer",
            "payload",
            "123e4567-e89b-12d3-a456-426614174000",
        )
        assertEquals(
            "1\ncall\ndevice\nandroid\nsession\n1\n2\noffer\npayload\n123e4567-e89b-12d3-a456-426614174000",
            canonical,
        )
    }
}
