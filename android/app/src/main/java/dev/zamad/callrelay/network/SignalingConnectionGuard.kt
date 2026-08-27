package dev.zamad.callrelay.network

/** Associates callbacks with exactly one active pairing/socket generation. */
internal class SignalingConnectionGuard<T : Any> {
    private var activeConnection: T? = null
    private var activePairingId = ""

    @Synchronized
    fun bind(connection: T, pairingId: String) {
        activeConnection = connection
        activePairingId = pairingId
    }

    @Synchronized
    fun pairingIdIfCurrent(connection: T): String? =
        activePairingId.takeIf { activeConnection === connection && it.isNotBlank() }

    @Synchronized
    fun clear(connection: T? = null) {
        if (connection != null && activeConnection !== connection) return
        activeConnection = null
        activePairingId = ""
    }
}
