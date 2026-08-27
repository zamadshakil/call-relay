package dev.zamad.callrelay.relay

/**
 * Process-local serialization for the one Telecom answer operation belonging
 * to an incoming relay call. Signaling snapshots and FCM can legitimately
 * deliver the same accepted state more than once; only the first delivery may
 * start the answer workflow.
 */
internal class IncomingAnswerGate {
    enum class Decision { START, JOIN, ALREADY_ISSUED, REJECTED }

    private var callId = ""
    private var running = false
    private var answerIssued = false
    private var expectedVersion = 0L
    private var generation = 0L
    private val commandIds = linkedSetOf<String>()

    @Synchronized
    fun register(nextCallId: String, commandId: String?, version: Long): Decision {
        require(nextCallId.isNotBlank()) { "Incoming answer call ID is required" }
        if (callId.isNotBlank() && callId != nextCallId) {
            if (running) return Decision.REJECTED
            resetLocked()
        }
        callId = nextCallId
        expectedVersion = maxOf(expectedVersion, version)
        if (answerIssued) return Decision.ALREADY_ISSUED
        if (!commandId.isNullOrBlank()) commandIds += commandId
        if (running) return Decision.JOIN
        running = true
        generation += 1
        return Decision.START
    }

    @Synchronized
    fun currentGeneration(forCallId: String): Long = if (callId == forCallId) generation else -1L

    @Synchronized
    fun isCurrent(forCallId: String, expectedGeneration: Long): Boolean =
        callId == forCallId && running && generation == expectedGeneration

    @Synchronized
    fun expectedVersion(forCallId: String, expectedGeneration: Long? = null): Long =
        if (callId == forCallId && (expectedGeneration == null || generation == expectedGeneration)) expectedVersion else 0L

    @Synchronized
    fun markIssued(forCallId: String, expectedGeneration: Long? = null) {
        if (callId == forCallId && (expectedGeneration == null || generation == expectedGeneration)) answerIssued = true
    }

    @Synchronized
    fun wasIssued(forCallId: String): Boolean = callId == forCallId && answerIssued

    @Synchronized
    fun clearIssued(forCallId: String, expectedGeneration: Long? = null) {
        if (callId == forCallId && (expectedGeneration == null || generation == expectedGeneration)) answerIssued = false
    }

    @Synchronized
    fun finish(forCallId: String, expectedGeneration: Long? = null): List<String> {
        if (callId != forCallId || (expectedGeneration != null && generation != expectedGeneration)) return emptyList()
        running = false
        return commandIds.toList().also { commandIds.clear() }
    }

    @Synchronized
    fun cancel(forCallId: String? = null): List<String> {
        if (!forCallId.isNullOrBlank() && callId != forCallId) return emptyList()
        val pending = commandIds.toList()
        resetLocked()
        return pending
    }

    private fun resetLocked() {
        generation += 1
        callId = ""
        running = false
        answerIssued = false
        expectedVersion = 0L
        commandIds.clear()
    }
}
