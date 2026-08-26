package dev.zamad.callrelay.relay

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.MediaRecorder
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.AudioBufferCallback
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.e2ee.E2EEOptions
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalAudioTrack
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.Track
import dev.zamad.callrelay.audio.PcmGainProcessor
import dev.zamad.callrelay.audio.CaptureSampleRateSelector
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference

class LiveKitRelaySession(
    context: Context,
    private val preferences: RelayPreferences,
) {
    private val appContext = context.applicationContext
    private val mode = AtomicReference(RelayMode.FULL_DUPLEX)
    private val explicitlyMuted = AtomicBoolean(false)
    private val gainProcessor = PcmGainProcessor()
    private var room: Room? = null
    private var localTrack: LocalAudioTrack? = null

    suspend fun connect(serverUrl: String, participantToken: String, callPassphrase: String) {
        require(serverUrl.startsWith("wss://")) { "LiveKit URL must use secure WebSocket transport" }
        require(participantToken.isNotBlank()) { "LiveKit participant token is missing" }
        require(callPassphrase.isNotBlank()) { "Call encryption key is missing" }
        // E2EEOptions constructs its native FrameCryptorKeyProvider immediately. LiveKit.create()
        // initializes WebRTC later, so initialize explicitly before constructing the room options.
        LiveKit.init(appContext)
        disconnect()
        val inputSampleRate = CaptureSampleRateSelector.choose(appContext)
        val mediaAttributes = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
            .build()
        val captureOptions = LocalAudioTrackOptions(
            noiseSuppression = false,
            echoCancellation = true,
            autoGainControl = false,
            highPassFilter = true,
            typingNoiseDetection = false,
        )
        val createdRoom = LiveKit.create(
            appContext = appContext,
            options = RoomOptions(
                adaptiveStream = false,
                dynacast = false,
                e2eeOptions = E2EEOptions(sharedKey = callPassphrase),
                audioTrackCaptureDefaults = captureOptions,
            ),
            overrides = LiveKitOverrides(
                audioOptions = AudioOptions(
                    audioOutputType = AudioType.CustomAudioType(
                        AudioManager.MODE_NORMAL,
                        mediaAttributes,
                        AudioManager.STREAM_MUSIC,
                    ),
                    audioHandler = NoAudioHandler(),
                    disableCommunicationModeWorkaround = true,
                    disableAudioPrewarming = true,
                    javaAudioDeviceModuleCustomizer = { builder ->
                        builder
                            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                            .setAudioFormat(AudioFormat.ENCODING_PCM_16BIT)
                            .setInputSampleRate(inputSampleRate)
                            .setOutputSampleRate(SAMPLE_RATE_HZ)
                            .setAudioAttributes(mediaAttributes)
                            .setUseLowLatency(true)
                            .setUseHardwareAcousticEchoCanceler(false)
                            .setUseHardwareNoiseSuppressor(false)
                    },
                ),
            ),
        )
        room = createdRoom
        RelayRuntime.update { it.copy(mediaState = "Connecting", error = null) }
        try {
            createdRoom.connect(serverUrl, participantToken)
            createdRoom.localParticipant.setMicrophoneEnabled(true)
            localTrack = createdRoom.localParticipant
                .getTrackPublication(Track.Source.MICROPHONE)
                ?.track as? LocalAudioTrack
            localTrack?.setAudioBufferCallback(captureCallback)
            applyMode(mode.get())
            RelayRuntime.update { it.copy(mediaState = "Connected") }
        } catch (failure: Throwable) {
            createdRoom.release()
            room = null
            localTrack = null
            RelayRuntime.update {
                it.copy(mediaState = "Failed", error = failure.message ?: failure::class.java.simpleName)
            }
            throw failure
        }
    }

    suspend fun applyMode(next: RelayMode) {
        mode.set(next)
        val currentRoom = room
        if (currentRoom != null) {
            currentRoom.localParticipant.setMicrophoneEnabled(next != RelayMode.TALK && !explicitlyMuted.get())
            if (next != RelayMode.TALK && !explicitlyMuted.get()) attachCaptureCallback()
            applyRemoteVolume()
        }
        RelayRuntime.update { it.copy(mode = next) }
    }

    fun refreshRemoteVolume() {
        applyRemoteVolume()
    }

    suspend fun setMuted(muted: Boolean) {
        explicitlyMuted.set(muted)
        room?.localParticipant?.setMicrophoneEnabled(!muted && mode.get() != RelayMode.TALK)
        if (!muted && mode.get() != RelayMode.TALK) attachCaptureCallback()
        RelayRuntime.update { it.copy(muted = muted) }
    }

    fun isConnected(): Boolean = room?.state == Room.State.CONNECTED

    fun isPeerConnected(): Boolean = isConnected() && room?.remoteParticipants?.isNotEmpty() == true

    fun disconnect() {
        localTrack?.setAudioBufferCallback(null)
        localTrack = null
        room?.disconnect()
        room?.release()
        room = null
        RelayRuntime.update { it.copy(mediaState = "Disconnected", captureRms = 0.0, capturePeak = 0) }
    }

    private fun applyRemoteVolume() {
        val volume = if (mode.get() == RelayMode.LISTEN) 0.0 else preferences.playbackGain
        room?.remoteParticipants?.values?.forEach { participant ->
            participant.audioTrackPublications.forEach { (_, track) ->
                (track as? RemoteAudioTrack)?.setVolume(volume)
            }
        }
    }

    private fun attachCaptureCallback() {
        localTrack = room?.localParticipant
            ?.getTrackPublication(Track.Source.MICROPHONE)
            ?.track as? LocalAudioTrack
        localTrack?.setAudioBufferCallback(captureCallback)
    }

    private val captureCallback = object : AudioBufferCallback {
        override fun onBuffer(
            buffer: ByteBuffer,
            audioFormat: Int,
            channelCount: Int,
            sampleRate: Int,
            bytesRead: Int,
            captureTimeNs: Long,
        ): Long {
            if (audioFormat == AudioFormat.ENCODING_PCM_16BIT || audioFormat == AudioFormat.ENCODING_DEFAULT) {
                val level = gainProcessor.processPcm16(
                    buffer = buffer,
                    bytesRead = bytesRead,
                    gain = preferences.captureGain,
                    muted = mode.get() == RelayMode.TALK || explicitlyMuted.get(),
                )
                RelayRuntime.update { it.copy(captureRms = level.rms, capturePeak = level.peak) }
            }
            return captureTimeNs
        }
    }

    companion object {
        private const val SAMPLE_RATE_HZ = 48_000
    }
}
