package dev.zamad.callrelay.network

import org.json.JSONObject

interface SignalTransport {
    suspend fun awaitConnected(timeoutMs: Long = 10_000L)
    fun send(type: String, callId: String, payload: JSONObject, negotiationId: String? = null)
}
