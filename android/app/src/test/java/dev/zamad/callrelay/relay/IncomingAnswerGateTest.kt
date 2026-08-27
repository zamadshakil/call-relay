package dev.zamad.callrelay.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingAnswerGateTest {
    @Test
    fun acceptedSnapshotFcmAndAnsweringSnapshotIssueExactlyOneTelecomAnswer() {
        val gate = IncomingAnswerGate()
        var telecomAnswers = 0
        var failedEvents = 0

        fun deliver(commandId: String? = null, version: Long) {
            when (gate.register("call_123", commandId, version)) {
                IncomingAnswerGate.Decision.START -> telecomAnswers += 1
                IncomingAnswerGate.Decision.JOIN,
                IncomingAnswerGate.Decision.ALREADY_ISSUED -> Unit
                IncomingAnswerGate.Decision.REJECTED -> failedEvents += 1
            }
        }

        deliver(version = 4) // accepted WebSocket snapshot
        deliver(commandId = "fcm_accept", version = 4) // duplicate FCM wake
        deliver(version = 5) // answering_sim snapshot broadcast

        assertEquals(1, telecomAnswers)
        assertEquals(5L, gate.expectedVersion("call_123"))
        gate.markIssued("call_123")
        assertEquals(listOf("fcm_accept"), gate.finish("call_123"))

        deliver(version = 5) // late equal snapshot after the answer API call
        assertEquals(1, telecomAnswers)
        assertEquals(0, failedEvents)
        assertTrue(gate.wasIssued("call_123"))
        assertFalse(gate.wasIssued("another_call"))
    }

    @Test
    fun delayedOldFinallyCannotFinishReplacementGeneration() {
        val gate = IncomingAnswerGate()
        assertEquals(IncomingAnswerGate.Decision.START, gate.register("call_a", "command_a", 1))
        val generationA = gate.currentGeneration("call_a")

        assertEquals(listOf("command_a"), gate.cancel("call_a"))
        assertEquals(IncomingAnswerGate.Decision.START, gate.register("call_b", "command_b", 1))
        val generationB = gate.currentGeneration("call_b")

        assertFalse(gate.isCurrent("call_a", generationA))
        assertTrue(gate.isCurrent("call_b", generationB))
        assertTrue(gate.finish("call_a", generationA).isEmpty())
        assertEquals(listOf("command_b"), gate.finish("call_b", generationB))
    }
}
