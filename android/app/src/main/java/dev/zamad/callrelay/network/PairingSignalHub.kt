package dev.zamad.callrelay.network

import dev.zamad.callrelay.relay.RelayPreferences
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.delay
import org.json.JSONObject

/**
 * Keeps one authenticated Durable Object socket per peer pairing. Incoming
 * snapshots are observed on every socket, but media messages are routed only
 * through the pairing atomically selected by the Worker.
 */
class PairingSignalHub(
    private val preferences: RelayPreferences,
    private val api: RelayApiClient,
    private val listener: PairingSignalClient.Listener,
) : SignalTransport {
    private val clients = ConcurrentHashMap<String, PairingSignalClient>()
    private val states = ConcurrentHashMap<String, String>()
    private val snapshotVersions = ConcurrentHashMap<String, Int>()
    private val pairingSelection = PairingSelection()
    @Volatile private var wanted = false

    fun start() {
        wanted = true
        refreshPairings()
        clients.values.forEach(PairingSignalClient::start)
    }

    fun refreshPairings() {
        val records = preferences.confirmedPairings().associateBy(RelayPreferences.PairingRecord::id)
        clients.keys.filterNot(records::containsKey).forEach { id ->
            clients.remove(id)?.shutdown()
            states.remove(id)
        }
        records.forEach { (id, record) ->
            clients.computeIfAbsent(id) { pairingId ->
                PairingSignalClient(preferences, api, listenerFor(pairingId), record)
            }.also { if (wanted) it.start() }
        }
        pairingSelection.update(records.keys)
    }

    fun selectPairing(pairingId: String?) {
        pairingSelection.select(pairingId)
    }

    fun selectedPairingId(): String? = pairingSelection.selectedId()

    fun close() {
        wanted = false
        clients.values.forEach(PairingSignalClient::close)
        states.clear()
        snapshotVersions.clear()
    }

    fun shutdown() {
        wanted = false
        clients.values.forEach(PairingSignalClient::shutdown)
        clients.clear()
        states.clear()
        snapshotVersions.clear()
    }

    override suspend fun awaitConnected(timeoutMs: Long) {
        refreshPairings()
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            val client = selectedClient()
            if (client != null && states[client.pairingId] == "Connected") return
            check(System.currentTimeMillis() < deadline) { "Selected peer signaling did not connect" }
            delay(50)
        }
    }

    override fun send(type: String, callId: String, payload: JSONObject, negotiationId: String?) {
        val client = selectedClient() ?: error("No selected peer signaling connection")
        client.send(type, callId, payload, negotiationId)
    }

    private fun selectedClient(): PairingSignalClient? {
        pairingSelection.selectedId()?.let(clients::get)?.let { return it }
        if (clients.size == 1) return clients.values.first()
        return null
    }

    private fun listenerFor(pairingId: String) = object : PairingSignalClient.Listener {
        override fun onSignalState(state: String) {
            states[pairingId] = state
            if (pairingId == pairingSelection.selectedId() || pairingSelection.selectedId() == null) listener.onSignalState(state)
        }

        override fun onPeerPresence(online: Boolean) {
            listener.onPeerPresence(clients.keys.any { states[it] == "Connected" && clients[it]?.isPeerOnline() == true })
        }

        override fun onCallSnapshot(call: PairingSignalClient.CallSnapshot) {
            val winner = call.selectedPairingId
            if (winner != null && winner != pairingId) return
            if (winner == pairingId) pairingSelection.select(pairingId)
            val previous = snapshotVersions[call.id]
            if (previous != null && previous >= call.version) return
            snapshotVersions[call.id] = call.version
            listener.onCallSnapshot(call)
        }

        override fun onEnvelope(type: String, payload: JSONObject, callId: String, negotiationId: String?) {
            if (pairingId == pairingSelection.selectedId()) listener.onEnvelope(type, payload, callId, negotiationId)
        }

        override fun onPairingRevoked(pairingId: String, reason: String) {
            listener.onPairingRevoked(pairingId, reason)
        }

        override fun onSignalError(message: String) {
            if (pairingId == pairingSelection.selectedId() || pairingSelection.selectedId() == null) listener.onSignalError(message)
        }
    }
}

/** Thread-safe winner routing kept separate so the race rules are JVM-testable. */
internal class PairingSelection {
    private var candidates: Set<String> = emptySet()
    private var selected: String? = null

    @Synchronized
    fun update(nextCandidates: Set<String>) {
        candidates = nextCandidates
        if (selected !in candidates) {
            selected = candidates.singleOrNull()
        }
    }

    @Synchronized
    fun select(pairingId: String?): Boolean {
        if (pairingId.isNullOrBlank() || pairingId !in candidates) return false
        selected = pairingId
        return true
    }

    @Synchronized
    fun selectedId(): String? = selected
}
