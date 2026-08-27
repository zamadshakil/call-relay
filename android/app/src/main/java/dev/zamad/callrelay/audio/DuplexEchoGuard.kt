package dev.zamad.callrelay.audio

import java.util.concurrent.atomic.AtomicLong

/**
 * Prevents audio received from the peer from being immediately captured and
 * returned to that same peer by the stock-Android acoustic bridge.
 *
 * This intentionally voice-switches only the WebRTC return path. It does not
 * mute the cellular microphone or Android speaker, both of which are required
 * for the stock-OS acoustic relay.
 */
class DuplexEchoGuard(
    private val speechRmsThreshold: Double = 480.0,
    private val speechPeakThreshold: Int = 1_400,
    private val hangoverMs: Long = 240L,
) {
    private val gateCaptureUntilMs = AtomicLong(0L)

    fun observePeerRender(rms: Double, peak: Int, nowMs: Long) {
        if (rms < speechRmsThreshold || peak < speechPeakThreshold) return
        val requestedUntil = nowMs + hangoverMs
        while (true) {
            val existing = gateCaptureUntilMs.get()
            if (existing >= requestedUntil || gateCaptureUntilMs.compareAndSet(existing, requestedUntil)) return
        }
    }

    fun shouldGateCapture(nowMs: Long): Boolean = nowMs < gateCaptureUntilMs.get()

    fun reset() {
        gateCaptureUntilMs.set(0L)
    }
}
