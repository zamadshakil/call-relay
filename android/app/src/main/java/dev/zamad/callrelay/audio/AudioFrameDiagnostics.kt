package dev.zamad.callrelay.audio

/** Numeric levels only; never retains PCM, records a conversation, or logs identities. */
class AudioFrameDiagnostics {
    data class Window(
        val captureFrames: Int = 0,
        val renderFrames: Int = 0,
        val gatedFrames: Int = 0,
        val captureInputRmsMax: Double = 0.0,
        val captureOutputRmsMax: Double = 0.0,
        val renderRmsMax: Double = 0.0,
    )

    private var window = Window()

    @Synchronized fun capture(level: FloatAudioGainProcessor.Level, echoGated: Boolean) {
        window = window.copy(
            captureFrames = window.captureFrames + 1,
            gatedFrames = window.gatedFrames + if (echoGated) 1 else 0,
            captureInputRmsMax = maxOf(window.captureInputRmsMax, level.inputRms),
            captureOutputRmsMax = maxOf(window.captureOutputRmsMax, level.rms),
        )
    }

    @Synchronized fun render(level: FloatAudioGainProcessor.Level) {
        window = window.copy(
            renderFrames = window.renderFrames + 1,
            renderRmsMax = maxOf(window.renderRmsMax, level.rms),
        )
    }

    @Synchronized fun take(): Window = window.also { window = Window() }
}
