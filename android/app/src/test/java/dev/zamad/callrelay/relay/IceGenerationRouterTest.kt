package dev.zamad.callrelay.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class IceGenerationRouterTest {
    @Test
    fun delayedOldCandidateIsNotRelabeledAsRestartGeneration() {
        val router = IceGenerationRouter()
        router.activate("negotiation_old")
        router.bindLocalDescription("negotiation_old", "v=0\r\na=ice-ufrag:oldUfrag\r\n")
        assertEquals(
            "negotiation_old",
            router.negotiationForCandidate("candidate:1 1 udp 1 10.0.0.1 1234 typ host ufrag oldUfrag"),
        )

        router.activate("negotiation_new")
        router.bindLocalDescription("negotiation_new", "v=0\r\na=ice-ufrag:newUfrag\r\n")

        assertNull(router.negotiationForCandidate("candidate:1 1 udp 1 10.0.0.1 1234 typ host ufrag oldUfrag"))
        assertEquals(
            "negotiation_new",
            router.negotiationForCandidate("candidate:2 1 udp 1 10.0.0.2 5678 typ relay ufrag newUfrag"),
        )
        assertNull(router.negotiationForCandidate("candidate:3 1 udp 1 10.0.0.3 9999 typ host"))
    }
}
