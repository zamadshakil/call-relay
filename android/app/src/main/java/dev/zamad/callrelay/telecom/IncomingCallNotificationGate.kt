package dev.zamad.callrelay.telecom

/**
 * Emits the incoming-call edge once per Telecom [callKey]. Telecom commonly
 * adds a call in NEW/CONNECTING and reports RINGING only through a later
 * callback, so gating only in onCallAdded loses the first incoming event.
 */
internal class IncomingCallNotificationGate<T : Any> {
    private val notified = mutableSetOf<T>()

    @Synchronized
    fun shouldNotify(callKey: T, eligible: Boolean, ringing: Boolean): Boolean =
        eligible && ringing && notified.add(callKey)

    @Synchronized
    fun remove(callKey: T) {
        notified.remove(callKey)
    }
}
