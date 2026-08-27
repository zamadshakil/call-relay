package dev.zamad.callrelay.relay

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.isActive

/** Serializes server termination of one call before the next call is created. */
internal class CallLifecycleBarrier {
    private data class Pending(val callId: String, val task: Deferred<Unit>)

    data class Completion(
        val callId: String,
        val failure: Throwable?,
    )

    private var pending: Pending? = null
    private var mostRecentCallId: String? = null

    fun begin(scope: CoroutineScope, callId: String, terminate: suspend () -> Unit): Deferred<Unit> = synchronized(this) {
        pending?.takeIf { it.callId == callId && it.task.isActive }?.task ?: scope.async { terminate() }.also {
            pending = Pending(callId, it)
            mostRecentCallId = callId
        }
    }

    /**
     * Consumes the currently pending termination exactly once. A failed task is
     * returned to the caller instead of remaining as a permanently failed
     * barrier that poisons every later incoming call.
     */
    suspend fun awaitPending(): Completion? {
        val snapshot = synchronized(this) { pending } ?: return null
        val failure = try {
            snapshot.task.await()
            null
        } catch (failure: Throwable) {
            if (failure is CancellationException && !currentCoroutineContext().isActive) throw failure
            failure
        }
        synchronized(this) {
            if (pending === snapshot) pending = null
        }
        return Completion(snapshot.callId, failure)
    }

    fun lastCallId(): String? = synchronized(this) { pending?.callId ?: mostRecentCallId }

    fun isTerminating(callId: String): Boolean = synchronized(this) { pending?.callId == callId }
}
