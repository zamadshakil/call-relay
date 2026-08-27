package dev.zamad.callrelay.telecom

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingCallNotificationGateTest {
    @Test
    fun `new call emits when it later transitions to ringing`() {
        val gate = IncomingCallNotificationGate<String>()

        assertFalse(gate.shouldNotify("call-a", eligible = true, ringing = false))
        assertTrue(gate.shouldNotify("call-a", eligible = true, ringing = true))
    }

    @Test
    fun `already ringing call is not emitted twice`() {
        val gate = IncomingCallNotificationGate<String>()

        assertTrue(gate.shouldNotify("call-a", eligible = true, ringing = true))
        assertFalse(gate.shouldNotify("call-a", eligible = true, ringing = true))
    }

    @Test
    fun `removed call key can be reused`() {
        val gate = IncomingCallNotificationGate<String>()

        assertTrue(gate.shouldNotify("call-a", eligible = true, ringing = true))
        gate.remove("call-a")
        assertTrue(gate.shouldNotify("call-a", eligible = true, ringing = true))
    }
}
