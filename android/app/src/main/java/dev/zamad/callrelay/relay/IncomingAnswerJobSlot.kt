package dev.zamad.callrelay.relay

import kotlinx.coroutines.Job

/** Identity-safe ownership for the replaceable incoming-answer coroutine. */
internal class IncomingAnswerJobSlot {
    private var current: Job? = null

    @Synchronized
    fun install(job: Job): Job? = current.also { current = job }

    @Synchronized
    fun take(): Job? = current.also { current = null }

    @Synchronized
    fun clearIfOwner(job: Job): Boolean {
        if (current !== job) return false
        current = null
        return true
    }

    @Synchronized
    fun isOwner(job: Job): Boolean = current === job
}
