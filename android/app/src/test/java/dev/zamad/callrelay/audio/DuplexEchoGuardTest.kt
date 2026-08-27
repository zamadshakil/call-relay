package dev.zamad.callrelay.audio

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DuplexEchoGuardTest {
    @Test
    fun quietRenderDoesNotGateCapture() {
        val guard = DuplexEchoGuard()
        guard.observePeerRender(rms = 300.0, peak = 1_000, nowMs = 1_000)
        assertFalse(guard.shouldGateCapture(nowMs = 1_001))
    }

    @Test
    fun peerSpeechGatesCaptureThroughHangover() {
        val guard = DuplexEchoGuard(hangoverMs = 240)
        guard.observePeerRender(rms = 1_200.0, peak = 4_000, nowMs = 1_000)
        assertTrue(guard.shouldGateCapture(nowMs = 1_239))
        assertFalse(guard.shouldGateCapture(nowMs = 1_240))
    }

    @Test
    fun continuingSpeechExtendsGateAndResetClearsIt() {
        val guard = DuplexEchoGuard(hangoverMs = 240)
        guard.observePeerRender(rms = 1_200.0, peak = 4_000, nowMs = 1_000)
        guard.observePeerRender(rms = 900.0, peak = 3_000, nowMs = 1_200)
        assertTrue(guard.shouldGateCapture(nowMs = 1_439))
        guard.reset()
        assertFalse(guard.shouldGateCapture(nowMs = 1_201))
    }
}
