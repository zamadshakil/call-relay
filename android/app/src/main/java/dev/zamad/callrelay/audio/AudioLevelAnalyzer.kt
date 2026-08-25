package dev.zamad.callrelay.audio

import kotlin.math.sqrt

object AudioLevelAnalyzer {
    data class Result(
        val rms: Double,
        val peak: Int,
        val nonZeroRatio: Double,
    )

    fun analyze(samples: ShortArray, count: Int): Result {
        if (count <= 0) return Result(0.0, 0, 0.0)

        var sumSquares = 0.0
        var peak = 0
        var nonZero = 0

        for (index in 0 until count) {
            val value = samples[index].toInt()
            val magnitude = if (value == Short.MIN_VALUE.toInt()) 32_768 else kotlin.math.abs(value)
            sumSquares += value.toDouble() * value.toDouble()
            if (magnitude > peak) peak = magnitude
            if (magnitude > 2) nonZero++
        }

        return Result(
            rms = sqrt(sumSquares / count),
            peak = peak,
            nonZeroRatio = nonZero.toDouble() / count,
        )
    }
}
