package dev.zamad.callrelay.audio

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.os.IBinder
import dev.zamad.callrelay.probe.ProbeState
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.math.max

class AudioProbeService : Service() {
    private val running = AtomicBoolean(false)
    private var audioRecord: AudioRecord? = null
    private var worker: Thread? = null

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildNotification("Checking microphone signal"))
        if (running.compareAndSet(false, true)) {
            worker = thread(name = "call-relay-audio-probe") { runProbe() }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        running.set(false)
        try {
            audioRecord?.stop()
        } catch (_: IllegalStateException) {
            // The recorder may already be stopped after an audio-route change.
        }
        audioRecord?.release()
        audioRecord = null
        worker?.interrupt()
        worker = null
        ProbeState.stopped()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun runProbe() {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            ProbeState.failed("Microphone permission is not granted")
            stopSelf()
            return
        }

        val attempts = listOf(
            Triple(MediaRecorder.AudioSource.VOICE_RECOGNITION, 48_000, "VOICE_RECOGNITION 48 kHz"),
            Triple(MediaRecorder.AudioSource.VOICE_RECOGNITION, 16_000, "VOICE_RECOGNITION 16 kHz"),
            Triple(MediaRecorder.AudioSource.MIC, 16_000, "MIC 16 kHz"),
        )

        var lastFailure: Throwable? = null
        for ((audioSource, sampleRate, label) in attempts) {
            if (!running.get()) return
            ProbeState.reset(label)
            try {
                capture(audioSource, sampleRate, label)
                return
            } catch (failure: Throwable) {
                lastFailure = failure
                audioRecord?.release()
                audioRecord = null
            }
        }

        ProbeState.failed(lastFailure?.message ?: "No compatible audio source")
        stopSelf()
    }

    private fun capture(audioSource: Int, sampleRate: Int, label: String) {
        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("Microphone permission was revoked")
        }
        val minimumBytes = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimumBytes > 0) { "AudioRecord rejected $sampleRate Hz mono PCM" }

        val bufferBytes = max(minimumBytes * 2, sampleRate / 2)
        val recorder = AudioRecord.Builder()
            .setAudioSource(audioSource)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(bufferBytes)
            .build()

        require(recorder.state == AudioRecord.STATE_INITIALIZED) {
            "$label could not initialize"
        }

        audioRecord = recorder
        recorder.startRecording()
        require(recorder.recordingState == AudioRecord.RECORDSTATE_RECORDING) {
            "$label did not start"
        }
        ProbeState.running(label)

        val samples = ShortArray(sampleRate / 50)
        while (running.get()) {
            val count = recorder.read(samples, 0, samples.size, AudioRecord.READ_BLOCKING)
            when {
                count > 0 -> {
                    val result = AudioLevelAnalyzer.analyze(samples, count)
                    ProbeState.update(count, result.rms, result.peak, result.nonZeroRatio)
                }
                count == AudioRecord.ERROR_DEAD_OBJECT -> error("Audio input became unavailable")
                count < 0 -> error("AudioRecord read failed: $count")
            }
        }
    }

    private fun createNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                "Call relay experiment",
                NotificationManager.IMPORTANCE_LOW,
            ),
        )
    }

    private fun buildNotification(text: String): Notification =
        Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_phone_call)
            .setContentTitle("Call Relay Lab")
            .setContentText(text)
            .setOngoing(true)
            .build()

    companion object {
        private const val CHANNEL_ID = "call-relay-probe"
        private const val NOTIFICATION_ID = 1001
    }
}
