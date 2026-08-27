package dev.zamad.callrelay.relay

/** Binds trickled ICE candidates to the SDP generation that created them. */
internal class IceGenerationRouter {
    private var activeNegotiationId = ""
    private val negotiationByUfrag = linkedMapOf<String, String>()

    @Synchronized
    fun activate(negotiationId: String) {
        activeNegotiationId = negotiationId
    }

    @Synchronized
    fun bindLocalDescription(negotiationId: String, sdp: String) {
        SDP_UFRAG.findAll(sdp).map { it.groupValues[1].trim() }.filter(String::isNotBlank).forEach {
            negotiationByUfrag[it] = negotiationId
        }
        while (negotiationByUfrag.size > MAX_GENERATIONS) {
            negotiationByUfrag.entries.iterator().run {
                if (hasNext()) {
                    next()
                    remove()
                }
            }
        }
    }

    @Synchronized
    fun negotiationForCandidate(candidateSdp: String): String? {
        val ufrag = CANDIDATE_UFRAG.find(candidateSdp)?.groupValues?.get(1) ?: return null
        return negotiationByUfrag[ufrag]?.takeIf { it == activeNegotiationId }
    }

    @Synchronized
    fun reset() {
        activeNegotiationId = ""
        negotiationByUfrag.clear()
    }

    companion object {
        private const val MAX_GENERATIONS = 16
        private val SDP_UFRAG = Regex("(?m)^a=ice-ufrag:([^\\r\\n]+)")
        private val CANDIDATE_UFRAG = Regex("(?:^|\\s)ufrag\\s+([^\\s]+)")
    }
}
