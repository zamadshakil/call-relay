import AVFoundation
import Combine
import Foundation
import WebRTC

@MainActor
final class AudioSessionController: ObservableObject {
    enum Output: String, CaseIterable, Identifiable {
        case receiver = "iPhone"
        case speaker = "Speaker"
        case bluetooth = "Bluetooth"
        var id: String { rawValue }
    }

    @Published private(set) var output: Output = .receiver
    @Published private(set) var availableInputs: [AVAudioSessionPortDescription] = []

    private let rtcSession = RTCAudioSession.sharedInstance()
    private var session: AVAudioSession { rtcSession.session }

    static func ensureMicrophonePermission() async -> Bool {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: return true
        case .denied: return false
        case .undetermined:
            return await withCheckedContinuation { continuation in
                AVAudioApplication.requestRecordPermission { continuation.resume(returning: $0) }
            }
        @unknown default: return false
        }
    }

    func configure(active: Bool) throws {
        _ = active
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        try rtcSession.setCategory(
            .playAndRecord,
            mode: .voiceChat,
            options: [.allowBluetooth, .allowBluetoothA2DP]
        )
        try rtcSession.setPreferredSampleRate(48_000)
        try rtcSession.setPreferredIOBufferDuration(0.01)
        // CallKit owns AVAudioSession activation. We only configure its voice
        // characteristics after CXProvider hands the session to us.
        refreshRoutes()
    }

    func select(_ next: Output) throws {
        rtcSession.lockForConfiguration()
        defer { rtcSession.unlockForConfiguration() }
        switch next {
        case .receiver:
            if let builtInMic = session.availableInputs?.first(where: { $0.portType == .builtInMic }) {
                try rtcSession.setPreferredInput(builtInMic)
            }
            try rtcSession.overrideOutputAudioPort(.none)
        case .speaker:
            try rtcSession.overrideOutputAudioPort(.speaker)
        case .bluetooth:
            guard let input = session.availableInputs?.first(where: {
                $0.portType == .bluetoothHFP || $0.portType == .bluetoothLE || $0.portType == .bluetoothA2DP
            }) else { throw RelayError.media("No Bluetooth audio device is connected.") }
            try rtcSession.overrideOutputAudioPort(.none)
            try rtcSession.setPreferredInput(input)
        }
        output = next
        refreshRoutes()
    }

    func refreshRoutes() {
        availableInputs = session.availableInputs ?? []
        let outputs = session.currentRoute.outputs
        if outputs.contains(where: { $0.portType == .builtInSpeaker }) { output = .speaker }
        else if outputs.contains(where: { [.bluetoothHFP, .bluetoothLE, .bluetoothA2DP].contains($0.portType) }) { output = .bluetooth }
        else { output = .receiver }
    }
}
