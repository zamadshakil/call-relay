package dev.zamad.callrelay.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class PcmGainProcessorTest {
    @Test
    fun appliesGainAndClipsPcm16() {
        val buffer = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())
        buffer.asShortBuffer().put(shortArrayOf(20_000, -20_000))
        val level = PcmGainProcessor().processPcm16(buffer, 4, 2f, muted = false)
        assertEquals(Short.MAX_VALUE, buffer.asShortBuffer()[0])
        assertEquals(Short.MIN_VALUE, buffer.asShortBuffer()[1])
        assertEquals(32_768, level.peak)
    }

    @Test
    fun muteProducesSilence() {
        val buffer = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder())
        buffer.asShortBuffer().put(shortArrayOf(100, -100))
        val level = PcmGainProcessor().processPcm16(buffer, 4, 1f, muted = true)
        assertTrue(level.rms == 0.0)
    }
}
