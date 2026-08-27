package dev.zamad.callrelay.relay

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class CallLifecycleBarrierTest {
    @Test
    fun immediateNextIncomingWaitsForDelayedEndRequest() = runBlocking {
        val barrier = CallLifecycleBarrier()
        val releaseEndResponse = CompletableDeferred<Unit>()
        barrier.begin(this, "call_old") { releaseEndResponse.await() }
        var incomingCreated = false

        val incoming = async {
            barrier.awaitPending()
            incomingCreated = true
        }
        yield()
        assertFalse(incomingCreated)
        releaseEndResponse.complete(Unit)
        incoming.await()
        assertTrue(incomingCreated)
    }

    @Test
    fun failedTerminationIsConsumedAndDoesNotPoisonNextCall() = runBlocking {
        supervisorScope {
            val barrier = CallLifecycleBarrier()
            barrier.begin(this, "call_old") { error("temporary end failure") }
            assertTrue(barrier.isTerminating("call_old"))

            val failed = barrier.awaitPending()
            assertEquals("call_old", failed?.callId)
            assertNotNull(failed?.failure)
            assertFalse(barrier.isTerminating("call_old"))
            assertNull(barrier.awaitPending())

            var nextTerminationRan = false
            barrier.begin(this, "call_next") { nextTerminationRan = true }
            val completed = barrier.awaitPending()

            assertTrue(nextTerminationRan)
            assertEquals("call_next", completed?.callId)
            assertNull(completed?.failure)
        }
    }

    @Test
    fun completedOrFailedSameCallCanBeRetriedAfterConsumption() = runBlocking {
        supervisorScope {
            val barrier = CallLifecycleBarrier()
            var attempts = 0
            barrier.begin(this, "call_old") {
                attempts += 1
                error("first attempt failed")
            }
            assertNotNull(barrier.awaitPending()?.failure)

            barrier.begin(this, "call_old") { attempts += 1 }
            assertNull(barrier.awaitPending()?.failure)
            assertEquals(2, attempts)
        }
    }
}
