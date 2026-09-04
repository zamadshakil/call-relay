package dev.zamad.callrelay.audio

import org.junit.Assert.assertEquals
import org.junit.Test

class AudioFrameDiagnosticsTest {
    @Test fun distinguishesGatedCaptureFromSilentMicrophoneAndResetsEachWindow() {
        val diagnostics = AudioFrameDiagnostics()
        diagnostics.capture(FloatAudioGainProcessor.Level(0.0, 0, 700.0, 1400), true)
        diagnostics.capture(FloatAudioGainProcessor.Level(200.0, 400, 200.0, 400), false)
        diagnostics.render(FloatAudioGainProcessor.Level(600.0, 1200, 600.0, 1200))
        val window = diagnostics.take()
        assertEquals(2, window.captureFrames)
        assertEquals(1, window.gatedFrames)
        assertEquals(1, window.renderFrames)
        assertEquals(700.0, window.captureInputRmsMax, 0.0)
        assertEquals(200.0, window.captureOutputRmsMax, 0.0)
        assertEquals(600.0, window.renderRmsMax, 0.0)
        assertEquals(AudioFrameDiagnostics.Window(), diagnostics.take())
    }
}
