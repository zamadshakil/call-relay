package dev.zamad.callrelay.relay

import kotlinx.coroutines.Job
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class IncomingAnswerJobSlotTest {
    @Test
    fun delayedOldFinallyCannotClearReplacementJob() {
        val slot = IncomingAnswerJobSlot()
        val jobA = Job()
        val jobB = Job()
        slot.install(jobA)

        assertTrue(slot.take() === jobA)
        slot.install(jobB)

        assertFalse(slot.clearIfOwner(jobA))
        assertTrue(slot.isOwner(jobB))
        assertTrue(slot.clearIfOwner(jobB))
    }
}
