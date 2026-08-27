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
            override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) {
                calls.incrementAndGet()
            }
        }
        val router = AudioProcessorRouter()
        router.attach(processor)
        router.process(48_000, 1, ByteBuffer.allocateDirect(16))
        router.detach()
        router.process(48_000, 1, ByteBuffer.allocateDirect(16))
        assertEquals(1, calls.get())
    }
}
