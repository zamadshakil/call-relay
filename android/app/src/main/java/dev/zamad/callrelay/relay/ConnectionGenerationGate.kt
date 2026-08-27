package dev.zamad.callrelay.relay

/**
 * Identity gate for callbacks owned by a replaceable native connection.
 * A generation number alone is insufficient because native callbacks can be
 * queued while a connection is being disposed and delivered after its
 * replacement is installed.
 */
internal class ConnectionGenerationGate<T : Any> {
    data class Binding<T : Any>(
        val generation: Long,
        val callId: String,
        val connection: T,
    )

    @Volatile private var current: Binding<T>? = null

    fun activate(generation: Long, callId: String, connection: T): Binding<T> =
        Binding(generation, callId, connection).also { current = it }

    fun invalidate() {
        current = null
    }

    fun isCurrent(binding: Binding<T>): Boolean {
        val active = current ?: return false
        return active.generation == binding.generation &&
            active.callId == binding.callId &&
            active.connection === binding.connection
    }
}
