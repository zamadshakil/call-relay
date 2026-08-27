package dev.zamad.callrelay.relay

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaRecorder
import dev.zamad.callrelay.audio.CaptureSampleRateSelector
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicReference
import livekit.org.webrtc.ExternalAudioProcessingFactory
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.audio.JavaAudioDeviceModule

/**
 * Owns libwebrtc's process-global audio-processing resources.
 *
 * The m144 ExternalAudioProcessingFactory native implementation uses a global
 * destructor. Destroying it for every call caused reproducible SIGSEGV crashes
 * on the OPPO CPH2127. These resources therefore intentionally live until the
 * Android process exits; the OS reclaims their native allocations with it.
 */
internal object ProcessWebRtcEngine {
    private val lock = Any()
    private val captureRouter = AudioProcessorRouter()
    private val renderRouter = AudioProcessorRouter()
    private var initialized = false
    private var activeOwner: Any? = null
    private var factory: PeerConnectionFactory? = null
    @Suppress("unused") private var audioProcessing: ExternalAudioProcessingFactory? = null
    @Suppress("unused") private var audioModule: JavaAudioDeviceModule? = null

    fun attach(
        context: Context,
        captureProcessor: ExternalAudioProcessingFactory.AudioProcessing,
        renderProcessor: ExternalAudioProcessingFactory.AudioProcessing,
    ): Lease = synchronized(lock) {
        ensureInitialized(context.applicationContext)
        val owner = Any()
        activeOwner = owner
        captureRouter.attach(captureProcessor)
        renderRouter.attach(renderProcessor)
        Lease(owner, checkNotNull(factory))
    }

    private fun ensureInitialized(context: Context) {
        if (initialized) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(context)
                .createInitializationOptions(),
        )
        val attributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        context.getSystemService(AudioManager::class.java).mode = AudioManager.MODE_NORMAL
        val processing = ExternalAudioProcessingFactory().apply {
            setCapturePostProcessing(captureRouter)
            setRenderPreProcessing(renderRouter)
        }
        val module = JavaAudioDeviceModule.builder(context)
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
            .setInputSampleRate(CaptureSampleRateSelector.choose(context))
            .setOutputSampleRate(SAMPLE_RATE_HZ)
            .setAudioAttributes(attributes)
            .setUseLowLatency(true)
            .setUseHardwareAcousticEchoCanceler(false)
            .setUseHardwareNoiseSuppressor(false)
            .setUseStereoInput(false)
            .setUseStereoOutput(false)
            .createAudioDeviceModule()
        factory = PeerConnectionFactory.builder()
            .setAudioDeviceModule(module)
            .setAudioProcessingFactory(processing)
            .createPeerConnectionFactory()
        // Keep processing and module reachable through the native factory for
        // the process lifetime. Calling destroy/release here is intentionally
        // forbidden because m144's audio processor is process-global.
        audioProcessing = processing
        audioModule = module
        initialized = true
    }

    internal class Lease internal constructor(
        private val owner: Any,
        val factory: PeerConnectionFactory,
    ) {
        fun detach() = synchronized(lock) {
            if (activeOwner === owner) {
                activeOwner = null
                captureRouter.detach()
                renderRouter.detach()
            }
        }
    }

    private const val SAMPLE_RATE_HZ = 48_000
}

internal class AudioProcessorRouter : ExternalAudioProcessingFactory.AudioProcessing {
    private val delegate = AtomicReference<ExternalAudioProcessingFactory.AudioProcessing?>()

    fun attach(processor: ExternalAudioProcessingFactory.AudioProcessing) {
        delegate.set(processor)
    }

    fun detach() {
        delegate.set(null)
    }

    override fun initialize(sampleRateHz: Int, numChannels: Int) {
        delegate.get()?.initialize(sampleRateHz, numChannels)
    }

    override fun reset(newRate: Int) {
        delegate.get()?.reset(newRate)
    }

    override fun process(sampleRateHz: Int, numChannels: Int, buffer: ByteBuffer) {
        delegate.get()?.process(sampleRateHz, numChannels, buffer)
    }
}
