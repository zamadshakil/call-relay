package dev.zamad.callrelay.probe

import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

object ProbeState {
    private val status = AtomicReference("Stopped")
    private val source = AtomicReference("-")
    private val error = AtomicReference("")
    private val frames = AtomicLong(0)
    private val rmsMilli = AtomicLong(0)
    private val peak = AtomicLong(0)
    private val nonZeroPermille = AtomicLong(0)

    fun reset(startingSource: String) {
        status.set("Starting")
        source.set(startingSource)
        error.set("")
        frames.set(0)
        rmsMilli.set(0)
        peak.set(0)
        nonZeroPermille.set(0)
    }

    fun running(activeSource: String) {
        source.set(activeSource)
        status.set("Running")
    }

    fun update(sampleCount: Int, rms: Double, peakValue: Int, nonZeroRatio: Double) {
        frames.addAndGet(sampleCount.toLong())
        rmsMilli.set((rms * 1_000.0).toLong())
        peak.set(peakValue.toLong())
        nonZeroPermille.set((nonZeroRatio * 1_000.0).toLong())
    }

    fun stopped() {
        status.set("Stopped")
    }

    fun failed(message: String) {
        error.set(message)
        status.set("Failed")
    }

    fun snapshot(): Snapshot = Snapshot(
        status = status.get(),
        source = source.get(),
        frames = frames.get(),
        rms = rmsMilli.get() / 1_000.0,
        peak = peak.get().toInt(),
        nonZeroRatio = nonZeroPermille.get() / 1_000.0,
        error = error.get(),
    )

    data class Snapshot(
        val status: String,
        val source: String,
        val frames: Long,
        val rms: Double,
        val peak: Int,
        val nonZeroRatio: Double,
        val error: String,
    )
}
