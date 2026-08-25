package dev.zamad.callrelay.crypto

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class CallKeyDeriverTest {
    @Test
    fun matchesTheBrowserHkdfVector() {
        val secret = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
        val callId = "call_0123456789abcdef0123456789abcdef"

        assertEquals("bkFr_ArwK8qzQx2FHpsf1CWj6nsa_aID0akuByZUnDw", CallKeyDeriver.derivePassphrase(secret, callId))
        assertEquals("Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0", CallKeyDeriver.secretCommitment(secret))
    }

    @Test
    fun rejectsSecretsThatAreNotExactlyThirtyTwoBytes() {
        assertThrows(IllegalArgumentException::class.java) {
            CallKeyDeriver.derivePassphrase("c2hvcnQ", "call_0123456789abcdef0123456789abcdef")
        }
    }
}
