package dev.zamad.callrelay.relay

import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import livekit.org.webrtc.ExternalAudioProcessingFactory
import org.junit.Assert.assertEquals
import org.junit.Test

class AudioProcessorRouterTest {
    @Test
    fun detachMakesLateNativeCallbacksHarmless() {
        val calls = AtomicInteger()
        val processor = object : ExternalAudioProcessingFactory.AudioProcessing {
            override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
            override fun reset(newRate: Int) = Unit
            override fun process(numBands: Int, numFrames: Int, buffer: ByteBuffer) {
                assertEquals(3, numBands)
                assertEquals(480, numFrames)
                calls.incrementAndGet()
            }
        }
        val router = AudioProcessorRouter()
        router.attach(processor)
        router.process(3, 480, ByteBuffer.allocateDirect(480 * 4))
        router.detach()
        router.process(3, 480, ByteBuffer.allocateDirect(480 * 4))
        assertEquals(1, calls.get())
    }
}
