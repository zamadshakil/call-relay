package dev.zamad.callrelay.network

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SignalingConnectionGuardTest {
    @Test
    fun delayedRevocationFromOldSocketCannotTargetNewPairing() {
        val guard = SignalingConnectionGuard<Any>()
        val oldSocket = Any()
        val newSocket = Any()
        guard.bind(oldSocket, "pair_old")
        guard.bind(newSocket, "pair_new")

        assertNull(guard.pairingIdIfCurrent(oldSocket))
        assertEquals("pair_new", guard.pairingIdIfCurrent(newSocket))
        guard.clear(oldSocket)
        assertEquals("pair_new", guard.pairingIdIfCurrent(newSocket))
    }
}
