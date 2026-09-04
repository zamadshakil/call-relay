package dev.zamad.callrelay.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class FloatAudioGainProcessorTest {
    private val processor = FloatAudioGainProcessor()

    @Test fun defaultPlaybackGainPreservesSignedFloatSamples() {
        val buffer = floats(1000f, -1000f, 0.25f, -0.25f)
        val level = processor.process(buffer, 4, 1.35f, false)
        assertEquals(1350f, buffer.asFloatBuffer()[0], 0.001f)
        assertEquals(-1350f, buffer.asFloatBuffer()[1], 0.001f)
        assertEquals(0.3375f, buffer.asFloatBuffer()[2], 0.00001f)
        assertEquals(-0.3375f, buffer.asFloatBuffer()[3], 0.00001f)
        assertEquals(1350, level.peak)
        assertEquals(1000, level.inputPeak)
    }

    @Test fun clipsInFloatS16RangeNotNormalizedRange() {
        val buffer = floats(20000f, -20000f)
        processor.process(buffer, 2, 2f, false)
        assertEquals(32767f, buffer.asFloatBuffer()[0], 0f)
        assertEquals(-32768f, buffer.asFloatBuffer()[1], 0f)
    }

    @Test fun mutePreservesInputDiagnosticsButOutputsRealFloatSilence() {
        val buffer = floats(1000f, -1000f)
        val level = processor.process(buffer, 2, 1f, true)
        assertEquals(0f, buffer.asFloatBuffer()[0], 0f)
        assertEquals(0f, buffer.asFloatBuffer()[1], 0f)
        assertEquals(0.0, level.rms, 0.0)
        assertEquals(1000.0, level.inputRms, 0.0)
    }

    @Test fun respectsFrameCountAndCallerBufferWindow() {
        val buffer = floats(7f, 10f, -10f, 99f)
        buffer.position(4)
        buffer.limit(12)
        processor.process(buffer, 1, 2f, false)
        assertEquals(4, buffer.position())
        assertEquals(12, buffer.limit())
        buffer.clear()
        assertEquals(7f, buffer.asFloatBuffer()[0], 0f)
        assertEquals(20f, buffer.asFloatBuffer()[1], 0f)
        assertEquals(-10f, buffer.asFloatBuffer()[2], 0f)
        assertEquals(99f, buffer.asFloatBuffer()[3], 0f)
    }

    @Test fun handlesEmptyShortAndNonFiniteBuffersWithoutPoisoningAudio() {
        assertEquals(0.0, processor.process(ByteBuffer.allocate(3), 480, 1f, false).rms, 0.0)
        val buffer = floats(Float.NaN, Float.POSITIVE_INFINITY, 42f)
        val level = processor.process(buffer, 480, Float.NaN, false)
        assertEquals(0f, buffer.asFloatBuffer()[0], 0f)
        assertEquals(0f, buffer.asFloatBuffer()[1], 0f)
        assertEquals(42f, buffer.asFloatBuffer()[2], 0f)
        assertFalse(level.rms.isNaN())
    }

    @Test fun quietRemoteAudioDoesNotFalselyTriggerEchoGate() {
        val buffer = floats(10f, -10f, 5f, -5f)
        val level = processor.process(buffer, 4, 1.35f, false)
        val guard = DuplexEchoGuard()
        guard.observePeerRender(level.rms, level.peak, 1000)
        assertFalse(guard.shouldGateCapture(1001))
    }

    private fun floats(vararg values: Float): ByteBuffer =
        ByteBuffer.allocateDirect(values.size * 4).order(ByteOrder.nativeOrder()).apply {
            asFloatBuffer().put(values)
        }
}
