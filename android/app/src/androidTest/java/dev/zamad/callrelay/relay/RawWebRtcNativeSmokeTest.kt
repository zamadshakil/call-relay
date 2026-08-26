package dev.zamad.callrelay.relay

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.nio.ByteBuffer
import livekit.org.webrtc.ExternalAudioProcessingFactory
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RawWebRtcNativeSmokeTest {
    @Test
    fun createsRawPeerConnectionFactoryWithExternalAudioProcessing() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
        )
        val noOp = object : ExternalAudioProcessingFactory.AudioProcessing {
            override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
            override fun reset(newRate: Int) = Unit
            override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) = Unit
        }
        val processing = ExternalAudioProcessingFactory().apply {
            setCapturePostProcessing(noOp)
            setRenderPreProcessing(noOp)
        }
        val audioModule = JavaAudioDeviceModule.builder(context)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .createAudioDeviceModule()
        val factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(audioModule)
            .setAudioProcessingFactory(processing)
            .createPeerConnectionFactory()
        assertNotNull(factory)
        factory.dispose()
        audioModule.release()
        processing.destroy()
    }
}
