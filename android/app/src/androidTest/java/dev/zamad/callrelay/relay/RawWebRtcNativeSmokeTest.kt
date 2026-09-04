package dev.zamad.callrelay.relay

import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import java.nio.ByteBuffer
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.ExternalAudioProcessingFactory
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.RtpTransceiver
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RawWebRtcNativeSmokeTest {
    @Test
    fun processEngineSurvivesOneHundredPerCallPeerConnectionTeardowns() {
        val context = ApplicationProvider.getApplicationContext<android.content.Context>()
        var processFactory: Any? = null

        repeat(100) { cycle ->
            val processor = object : ExternalAudioProcessingFactory.AudioProcessing {
                override fun initialize(sampleRateHz: Int, numChannels: Int) = Unit
                override fun reset(newRate: Int) = Unit
                override fun process(numBands: Int, numFrames: Int, buffer: ByteBuffer) = Unit
            }
            val lease = ProcessWebRtcEngine.attach(context, processor, processor)
            try {
                if (processFactory == null) processFactory = lease.factory
                else assertSame("factory changed during cycle $cycle", processFactory, lease.factory)

                val source = lease.factory.createAudioSource(MediaConstraints())
                val track = lease.factory.createAudioTrack("native-smoke-$cycle", source)
                val connection = lease.factory.createPeerConnection(
                    PeerConnection.RTCConfiguration(emptyList()),
                    NoOpPeerObserver,
                )
                assertNotNull("peer connection was null during cycle $cycle", connection)
                try {
                    connection!!.addTransceiver(
                        track,
                        RtpTransceiver.RtpTransceiverInit(RtpTransceiver.RtpTransceiverDirection.SEND_RECV),
                    )
                } finally {
                    connection?.close()
                    connection?.dispose()
                    track.dispose()
                    source.dispose()
                }
            } finally {
                lease.detach()
            }
        }
    }

    private object NoOpPeerObserver : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit
        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) = Unit
        override fun onIceCandidate(candidate: IceCandidate) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<IceCandidate>) = Unit
        override fun onAddStream(stream: MediaStream) = Unit
        override fun onRemoveStream(stream: MediaStream) = Unit
        override fun onDataChannel(channel: DataChannel) = Unit
        override fun onRenegotiationNeeded() = Unit
        override fun onTrack(transceiver: RtpTransceiver) = Unit
        override fun onConnectionChange(state: PeerConnection.PeerConnectionState) = Unit
    }
}
