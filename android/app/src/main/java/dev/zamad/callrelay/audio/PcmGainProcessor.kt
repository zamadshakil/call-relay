package dev.zamad.callrelay.audio

import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.abs
import kotlin.math.sqrt

class PcmGainProcessor {
    data class Level(val rms: Double, val peak: Int)

    fun processPcm16(buffer: ByteBuffer, bytesRead: Int, gain: Float, muted: Boolean): Level {
        if (bytesRead <= 1) return Level(0.0, 0)
        val samples = buffer.order(ByteOrder.nativeOrder()).asShortBuffer()
        val count = minOf(samples.capacity(), bytesRead / 2)
        var peak = 0
        var sumSquares = 0.0
        for (index in 0 until count) {
            val original = samples[index].toInt()
            val adjusted = if (muted) 0 else (original * gain).toInt().coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
            samples.put(index, adjusted.toShort())
            val magnitude = if (adjusted == Short.MIN_VALUE.toInt()) 32_768 else abs(adjusted)
            if (magnitude > peak) peak = magnitude
            sumSquares += adjusted.toDouble() * adjusted.toDouble()
        }
        return Level(sqrt(sumSquares / count), peak)
    }
}
