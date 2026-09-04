import Foundation

enum MediaConnectionState: String, Sendable {
    case idle = "Idle"
    case preparing = "Preparing"
    case connecting = "Connecting"
    case connected = "Connected"
    case disconnected = "Disconnected"
    case failed = "Failed"
}

enum MediaQuality: String, Sendable {
    case unknown = "Measuring"
    case excellent = "Excellent"
    case good = "Good"
    case fair = "Fair"
    case poor = "Poor"
}

struct MediaStatistics: Equatable, Sendable {
    let setupDurationMs: Double
    let candidateType: String
    let `protocol`: String
    let rttMs: Double
    let jitterMs: Double
    let packetsLost: Int64
    let packetsReceived: Int64
    let concealedSamples: Int64
    let bytesSent: Int64
    let bytesReceived: Int64

    var eventPayload: [String: Any] {
        [
            "setupDurationMs": max(0, setupDurationMs),
            "candidateType": ["host", "srflx", "relay"].contains(candidateType) ? candidateType : "unknown",
            "protocol": ["udp", "tcp", "tls"].contains(`protocol`) ? `protocol` : "unknown",
            "rttMs": max(0, rttMs),
            "jitterMs": max(0, jitterMs),
            "packetsLost": max(0, packetsLost),
            "concealedSamples": max(0, concealedSamples),
            "bytesSent": max(0, bytesSent),
            "bytesReceived": max(0, bytesReceived)
        ]
    }
}

struct LocalICECandidate: Sendable {
    let candidate: String
    let sdpMid: String?
    let sdpMLineIndex: Int32
}

@MainActor
protocol MediaAdapter: AnyObject {
    var onLocalCandidate: ((LocalICECandidate) -> Void)? { get set }
    var onICEGatheringComplete: (() -> Void)? { get set }
    var onStateChange: ((MediaConnectionState, String?) -> Void)? { get set }

    func prepare(configuration: ICEConfiguration, relayOnly: Bool) throws
    func answer(offerSDP: String) async throws -> String
    func addRemoteCandidate(_ candidate: LocalICECandidate) throws
    func setMuted(_ muted: Bool)
    func setMode(_ mode: RelayMode)
    func setAudioActive(_ active: Bool)
    func forceRelay(configuration: ICEConfiguration) throws
    func statistics() async -> MediaStatistics?
    func close()
}
