package dev.zamad.callrelay.relay

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionGenerationGateTest {
    @Test
    fun delayedCallbacksFromDisposedConnectionCannotAffectReplacement() {
        val gate = ConnectionGenerationGate<Any>()
        val callA = gate.activate(1, "call_a", Any())
        var oldCallbackApplied = false
        val delayedCallbackFromA = {
            if (gate.isCurrent(callA)) oldCallbackApplied = true
        }

        val callB = gate.activate(2, "call_b", Any())
        delayedCallbackFromA()

        assertFalse(oldCallbackApplied)
        assertFalse(gate.isCurrent(callA))
        assertTrue(gate.isCurrent(callB))
    }

    @Test
    fun invalidationRejectsCallbacksBeforeNextConnectionExists() {
        val gate = ConnectionGenerationGate<Any>()
        val binding = gate.activate(7, "call_a", Any())
        gate.invalidate()
        assertFalse(gate.isCurrent(binding))
    }
}
