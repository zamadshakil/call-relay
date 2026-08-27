package dev.zamad.callrelay.relay

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PersistedCallRecoveryPolicyTest {
    @Test
    fun `end after recreation resolves persisted call when runtime is empty`() {
        assertEquals(
            "call-persisted",
            PersistedCallRecoveryPolicy.resolveEndCallId(
                explicitCallId = null,
                runtimeCallId = null,
                persistedCallId = "call-persisted",
            ),
        )
    }

    @Test
    fun `explicit end cannot terminate an unrelated call`() {
        assertNull(
            PersistedCallRecoveryPolicy.resolveEndCallId(
                explicitCallId = "call-other",
                runtimeCallId = null,
                persistedCallId = "call-current",
            ),
        )
    }

    @Test
    fun `restart at dialing sim resumes once when no dial was issued`() {
        assertEquals(
            PersistedCallRecoveryPolicy.OutgoingAction.RESUME_DIAL,
            PersistedCallRecoveryPolicy.outgoingAction(
                direction = "outgoing",
                state = "dialing_sim",
                phoneNumber = "+923001234567",
                activeTelecomCalls = 0,
                dialAlreadyIssued = false,
            ),
        )
    }

    @Test
    fun `restart never redials after durable dial marker`() {
        assertEquals(
            PersistedCallRecoveryPolicy.OutgoingAction.TERMINALIZE,
            PersistedCallRecoveryPolicy.outgoingAction(
                direction = "outgoing",
                state = "dialing_sim",
                phoneNumber = "+923001234567",
                activeTelecomCalls = 0,
                dialAlreadyIssued = true,
            ),
        )
    }

    @Test
    fun `restart adopts an already visible Telecom call without redialing`() {
        assertEquals(
            PersistedCallRecoveryPolicy.OutgoingAction.KEEP_EXISTING_TELECOM_CALL,
            PersistedCallRecoveryPolicy.outgoingAction(
                direction = "outgoing",
                state = "dialing_sim",
                phoneNumber = "+923001234567",
                activeTelecomCalls = 1,
                dialAlreadyIssued = true,
            ),
        )
    }
}
