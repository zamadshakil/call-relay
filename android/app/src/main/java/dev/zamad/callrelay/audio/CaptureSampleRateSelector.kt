package dev.zamad.callrelay.audio

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlin.math.max

object CaptureSampleRateSelector {
    fun choose(context: Context): Int {
        if (context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            throw SecurityException("Microphone permission is not granted")
        }
        for (sampleRate in intArrayOf(48_000, 16_000)) {
            val minimum = AudioRecord.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            if (minimum <= 0) continue
            val recorder = runCatching {
                AudioRecord.Builder()
                    .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
                    .setAudioFormat(
                        AudioFormat.Builder()
                            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                            .setSampleRate(sampleRate)
                            .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                            .build(),
                    )
                    .setBufferSizeInBytes(max(minimum * 2, sampleRate / 2))
                    .build()
            }.getOrNull()
            if (recorder?.state == AudioRecord.STATE_INITIALIZED) {
                recorder.release()
                return sampleRate
            }
            recorder?.release()
        }
        error("VOICE_RECOGNITION cannot initialize at 48 kHz or 16 kHz")
    }
}
