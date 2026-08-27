package dev.zamad.callrelay.onboarding

import dev.zamad.callrelay.network.ConsumerApiException

internal object AuthFailurePolicy {
    private val terminalCodes = setOf(
        "auth_user_deleted",
        "auth_session_revoked",
        "firebase_user_not_found",
        "firebase_session_revoked",
    )

    fun shouldSignOut(error: ConsumerApiException): Boolean {
        if (error.status != 401) return false
        if (error.code in terminalCodes) return true
        return error.message == "Firebase user no longer exists" ||
            error.message == "Firebase session has been revoked; sign in again"
    }

    fun recoverableMessage(error: ConsumerApiException): String = when (error.status) {
        401 -> "Your secure session could not be refreshed. Check the connection and retry; your Google account is still saved."
        429 -> "The service is busy. Wait a moment and retry."
        in 500..599 -> "The relay service is temporarily unavailable. Your account and pairing are preserved."
        else -> error.message ?: "Something went wrong"
    }
}
