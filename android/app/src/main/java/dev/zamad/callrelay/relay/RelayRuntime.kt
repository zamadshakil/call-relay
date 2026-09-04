package dev.zamad.callrelay.relay

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicReference

object RelayRuntime {
    data class Snapshot(
        val ready: Boolean = false,
        val accessibilityEnabled: Boolean = false,
        val callState: String = "No call",
        val mediaState: String = "Disconnected",
        val mode: RelayMode = RelayMode.FULL_DUPLEX,
        val muted: Boolean = false,
        val callId: String? = null,
        val captureRms: Double = 0.0,
        val capturePeak: Int = 0,
        val audioDiagnostics: String? = null,
        val error: String? = null,
    )

    private val value = AtomicReference(Snapshot())
    private val listeners = CopyOnWriteArrayList<(Snapshot) -> Unit>()

    fun snapshot(): Snapshot = value.get()

    fun update(transform: (Snapshot) -> Snapshot) {
        while (true) {
            val current = value.get()
            val next = transform(current)
            if (value.compareAndSet(current, next)) {
                listeners.forEach { it(next) }
                return
            }
        }
    }

    fun addListener(listener: (Snapshot) -> Unit) {
        listeners += listener
        listener(value.get())
    }

    fun removeListener(listener: (Snapshot) -> Unit) {
        listeners -= listener
    }
}
