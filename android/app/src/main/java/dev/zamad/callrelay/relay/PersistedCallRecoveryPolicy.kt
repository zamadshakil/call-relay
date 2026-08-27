package dev.zamad.callrelay.relay

import dev.zamad.callrelay.telecom.NumberPolicy

internal object PersistedCallRecoveryPolicy {
    enum class OutgoingAction {
        NONE,
        KEEP_EXISTING_TELECOM_CALL,
        RESUME_DIAL,
        TERMINALIZE,
    }

    /**
     * An END received immediately after service recreation has no in-memory
     * runtime yet. The persisted call is still authoritative until restore has
     * finished, so it must be eligible for terminalization too.
     */
    fun resolveEndCallId(explicitCallId: String?, runtimeCallId: String?, persistedCallId: String?): String? {
        val explicit = explicitCallId?.takeIf(String::isNotBlank)
        val runtime = runtimeCallId?.takeIf(String::isNotBlank)
        val persisted = persistedCallId?.takeIf(String::isNotBlank)
        if (explicit != null) return explicit.takeIf { it == runtime || it == persisted }
        return runtime ?: persisted
    }

    fun outgoingAction(
        direction: String,
        state: String,
        phoneNumber: String?,
        activeTelecomCalls: Int,
        dialAlreadyIssued: Boolean,
    ): OutgoingAction {
        if (direction != "outgoing" || state != "dialing_sim") return OutgoingAction.NONE
        if (phoneNumber.isNullOrBlank() || NumberPolicy.rejectionReason(phoneNumber) != null) {
            return OutgoingAction.TERMINALIZE
        }
        if (activeTelecomCalls > 0) return OutgoingAction.KEEP_EXISTING_TELECOM_CALL
        return if (dialAlreadyIssued) OutgoingAction.TERMINALIZE else OutgoingAction.RESUME_DIAL
    }
}
