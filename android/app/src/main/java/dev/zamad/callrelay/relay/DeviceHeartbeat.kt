package dev.zamad.callrelay.relay

import java.util.UUID
import java.util.concurrent.atomic.AtomicLong

data class DeviceHeartbeat(
    val serviceInstanceId: String,
    val sequence: Long,
    val relayReady: Boolean,
    val signalState: String,
    val activeCallId: String?,
    val processStartedAt: Long,
    val lastErrorCode: String?,
)

/** Stable for every RelayReadyService recreation in one Android process. */
internal object DeviceHeartbeatIdentity {
    val serviceInstanceId: String = UUID.randomUUID().toString()
    val processStartedAt: Long = System.currentTimeMillis()
    private val sequence = AtomicLong()

    fun nextSequence(): Long = sequence.incrementAndGet()
}
