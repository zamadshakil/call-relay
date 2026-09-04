package dev.zamad.callrelay.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * WebRTC m144 ExternalAudioProcessingFactory exposes AudioBuffer.channels()[0]:
 * native-endian Float32 samples in the FloatS16 range, NOT PCM16 bytes and NOT
 * normalized [-1, 1] floats. Its callback arguments are numBands/numFrames.
 * The relay configures mono input/output; process only the valid frame count.
 * See webrtc-sdk/webrtc m144_release external_audio_processing_factory.cc and
 * modules/audio_processing/audio_buffer.cc. Android AudioRecord's PCM16 format
 * does not describe this post-conversion processing buffer.
 */
class FloatAudioGainProcessor {
    data class Level(val rms: Double, val peak: Int, val inputRms: Double, val inputPeak: Int)

    fun process(buffer: ByteBuffer, numFrames: Int, gain: Float, muted: Boolean): Level {
        val samples = buffer.duplicate().order(ByteOrder.nativeOrder()).asFloatBuffer()
        val count = minOf(samples.remaining(), numFrames.coerceAtLeast(0))
        if (count == 0) return Level(0.0, 0, 0.0, 0)
        val safeGain = if (gain.isFinite()) gain.coerceIn(0f, 4f) else 1f
        var peak = 0f
        var inputPeak = 0f
        var sumSquares = 0.0
        var inputSumSquares = 0.0
        for (index in 0 until count) {
            val sample = samples[index]
            val input = if (sample.isFinite()) sample.coerceIn(-32768f, 32767f) else 0f
            val output = if (muted) 0f else (input * safeGain).coerceIn(-32768f, 32767f)
            samples.put(index, output)
            peak = maxOf(peak, abs(output))
            inputPeak = maxOf(inputPeak, abs(input))
            sumSquares += output.toDouble() * output
            inputSumSquares += input.toDouble() * input
        }
        return Level(sqrt(sumSquares / count), peak.toInt(), sqrt(inputSumSquares / count), inputPeak.toInt())
    }
}
