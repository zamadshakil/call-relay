package dev.zamad.callrelay.onboarding

import dev.zamad.callrelay.network.ConsumerApiException
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthFailurePolicyTest {
    @Test
    fun transient401PreservesFirebaseSession() {
        assertFalse(AuthFailurePolicy.shouldSignOut(ConsumerApiException(401, null, "invalid or expired Firebase ID token")))
    }

    @Test
    fun serverFailurePreservesFirebaseSession() {
        assertFalse(AuthFailurePolicy.shouldSignOut(ConsumerApiException(503, "firebase_unavailable", "temporarily unavailable")))
    }

    @Test
    fun explicitRevocationSignsOut() {
        assertTrue(AuthFailurePolicy.shouldSignOut(ConsumerApiException(401, "auth_session_revoked", "revoked")))
    }

    @Test
    fun legacyRevocationMessageSignsOut() {
        assertTrue(AuthFailurePolicy.shouldSignOut(ConsumerApiException(401, null, "Firebase session has been revoked; sign in again")))
    }
}
