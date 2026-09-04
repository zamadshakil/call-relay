import AVFoundation
import Foundation
import WebRTC

@MainActor
final class WebRTCMediaAdapter: NSObject, MediaAdapter, @unchecked Sendable {
    var onLocalCandidate: ((LocalICECandidate) -> Void)?
    var onICEGatheringComplete: (() -> Void)?
    var onStateChange: ((MediaConnectionState, String?) -> Void)?

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory(
            encoderFactory: RTCDefaultVideoEncoderFactory(),
            decoderFactory: RTCDefaultVideoDecoderFactory()
        )
    }()

    private var peerConnection: RTCPeerConnection?
    private var localAudioTrack: RTCAudioTrack?
    private var remoteAudioTrack: RTCAudioTrack?
    private var configuration: RTCConfiguration?
    private var audioState = CallAudioState()
    private var preparedAt: Date?
    private var connectedAt: Date?

    func prepare(configuration media: ICEConfiguration, relayOnly: Bool) throws {
        close()
        preparedAt = Date()
        connectedAt = nil
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.useManualAudio = true
        rtcAudio.isAudioEnabled = false
        emit(.preparing)
        let configuration = Self.rtcConfiguration(media, relayOnly: relayOnly)
        self.configuration = configuration
        let peerConstraints = RTCMediaConstraints(
            mandatoryConstraints: nil,
            optionalConstraints: ["DtlsSrtpKeyAgreement": "true"]
        )
        guard let peer = Self.factory.peerConnection(
            with: configuration,
            constraints: peerConstraints,
            delegate: self
        ) else { throw RelayError.media("WebRTC could not create a peer connection.") }
        peerConnection = peer

        let audioConstraints = RTCMediaConstraints(
            mandatoryConstraints: [
                "googEchoCancellation": "true",
                "googAutoGainControl": "true",
                "googNoiseSuppression": "true",
                "googHighpassFilter": "true"
            ],
            optionalConstraints: nil
        )
        let source = Self.factory.audioSource(with: audioConstraints)
        let track = Self.factory.audioTrack(with: source, trackId: "call-relay-audio")
        localAudioTrack = track
        peer.add(track, streamIds: ["call-relay-stream"])
        audioState.mediaPrepared = true
        applyAudioDirection()
        emit(.connecting)
    }

    func answer(offerSDP: String) async throws -> String {
        guard let peerConnection else { throw RelayError.media("WebRTC is not prepared.") }
        try await setRemote(RTCSessionDescription(type: .offer, sdp: offerSDP), on: peerConnection)
        guard self.peerConnection === peerConnection else { throw CancellationError() }
        let constraints = RTCMediaConstraints(
            mandatoryConstraints: ["OfferToReceiveAudio": "true", "OfferToReceiveVideo": "false"],
            optionalConstraints: nil
        )
        let answer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peerConnection.answer(for: constraints) { description, error in
                if let error { continuation.resume(throwing: error) }
                else if let description { continuation.resume(returning: description) }
                else { continuation.resume(throwing: RelayError.media("WebRTC did not create an answer.")) }
            }
        }
        guard self.peerConnection === peerConnection else { throw CancellationError() }
        try await setLocal(answer, on: peerConnection)
        guard self.peerConnection === peerConnection else { throw CancellationError() }
        return answer.sdp
    }

    func addRemoteCandidate(_ candidate: LocalICECandidate) throws {
        guard let peerConnection else { throw RelayError.media("WebRTC is not prepared.") }
        let rtcCandidate = RTCIceCandidate(
            sdp: candidate.candidate,
            sdpMLineIndex: candidate.sdpMLineIndex,
            sdpMid: candidate.sdpMid
        )
        peerConnection.add(rtcCandidate) { [weak self] error in
            guard let error else { return }
            Task { @MainActor [weak self] in
                guard let self, self.peerConnection === peerConnection else { return }
                self.emit(.failed, detail: "ICE candidate was rejected: \(error.localizedDescription)")
            }
        }
    }

    func setMuted(_ muted: Bool) {
        audioState.muted = muted
        applyAudioDirection()
    }

    func setMode(_ mode: RelayMode) {
        audioState.mode = mode
        applyAudioDirection()
    }

    func setAudioActive(_ active: Bool) {
        let rtcAudio = RTCAudioSession.sharedInstance()
        rtcAudio.useManualAudio = true
        if active, !audioState.callKitActive {
            rtcAudio.audioSessionDidActivate(AVAudioSession.sharedInstance())
        } else if !active, audioState.callKitActive {
            rtcAudio.audioSessionDidDeactivate(AVAudioSession.sharedInstance())
        }
        audioState.callKitActive = active
        applyAudioDirection()
    }

    func forceRelay(configuration media: ICEConfiguration) throws {
        guard let peerConnection else { throw RelayError.media("WebRTC is not prepared.") }
        let replacement = Self.rtcConfiguration(media, relayOnly: true)
        guard peerConnection.setConfiguration(replacement) else {
            throw RelayError.media("WebRTC could not switch to TURN relay.")
        }
        configuration = replacement
        emit(.connecting, detail: "Cloudflare TURN")
    }

    func statistics() async -> MediaStatistics? {
        guard let peerConnection else { return nil }
        let report: RTCStatisticsReport = await withCheckedContinuation { continuation in
            peerConnection.statistics { continuation.resume(returning: $0) }
        }
        guard self.peerConnection === peerConnection else { return nil }
        return makeStatistics(from: report)
    }

    func close() {
        localAudioTrack?.isEnabled = false
        remoteAudioTrack?.isEnabled = false
        peerConnection?.close()
        peerConnection = nil
        localAudioTrack = nil
        remoteAudioTrack = nil
        configuration = nil
        preparedAt = nil
        connectedAt = nil
        audioState.mediaPrepared = false
        applyAudioDirection()
        emit(.idle)
    }

    private func setRemote(_ description: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func setLocal(_ description: RTCSessionDescription, on peer: RTCPeerConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(description) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }

    private func applyAudioDirection() {
        RTCAudioSession.sharedInstance().isAudioEnabled = audioState.audioEnabled
        localAudioTrack?.isEnabled = audioState.sendingEnabled
        remoteAudioTrack?.isEnabled = audioState.receivingEnabled
    }

    private func emit(_ state: MediaConnectionState, detail: String? = nil) {
        onStateChange?(state, detail)
    }

    private func makeStatistics(from report: RTCStatisticsReport) -> MediaStatistics {
        var rtt = 0.0
        var jitter = 0.0
        var packetsLost: Int64 = 0
        var packetsReceived: Int64 = 0
        var concealedSamples: Int64 = 0
        var bytesSent: Int64 = 0
        var bytesReceived: Int64 = 0
        var microphoneLevel: Double?
        var receivedLevel: Double?
        var microphoneEnergy: Double?
        var receivedEnergy: Double?
        var selectedLocalCandidateId: String?

        for statistic in report.statistics.values {
            let values = statistic.values
            if statistic.type == "candidate-pair",
               (values["state"] as? String) == "succeeded",
               (Self.boolean(values["nominated"]) || Self.boolean(values["selected"])) {
                rtt = Self.number(values["currentRoundTripTime"]) * 1_000
                selectedLocalCandidateId = values["localCandidateId"] as? String
            } else if statistic.type == "inbound-rtp", values["kind"] as? String == "audio" {
                jitter = Self.number(values["jitter"]) * 1_000
                packetsLost = Self.integer(values["packetsLost"])
                packetsReceived = Self.integer(values["packetsReceived"])
                concealedSamples = Self.integer(values["concealedSamples"])
                bytesReceived = Self.integer(values["bytesReceived"])
                receivedLevel = (values["audioLevel"] as? NSNumber)?.doubleValue
                receivedEnergy = (values["totalAudioEnergy"] as? NSNumber)?.doubleValue
            } else if statistic.type == "outbound-rtp", values["kind"] as? String == "audio" {
                bytesSent = Self.integer(values["bytesSent"])
            } else if statistic.type == "media-source", values["kind"] as? String == "audio" {
                microphoneLevel = (values["audioLevel"] as? NSNumber)?.doubleValue
                microphoneEnergy = (values["totalAudioEnergy"] as? NSNumber)?.doubleValue
            }
        }

        let localCandidate = selectedLocalCandidateId.flatMap { report.statistics[$0] }
        let candidateType = (localCandidate?.values["candidateType"] as? String) ?? "unknown"
        let transport = (localCandidate?.values["relayProtocol"] as? String)
            ?? (localCandidate?.values["protocol"] as? String)
            ?? "unknown"
        let rtcAudio = RTCAudioSession.sharedInstance()
        let audioSession = rtcAudio.session
        return MediaStatistics(
            setupDurationMs: max(0, (connectedAt ?? Date()).timeIntervalSince(preparedAt ?? Date()) * 1_000),
            candidateType: candidateType,
            protocol: transport,
            rttMs: max(0, rtt),
            jitterMs: max(0, jitter),
            packetsLost: max(0, packetsLost),
            packetsReceived: max(0, packetsReceived),
            concealedSamples: max(0, concealedSamples),
            bytesSent: max(0, bytesSent),
            bytesReceived: max(0, bytesReceived),
            audio: MediaAudioDiagnostics(
                callKitActive: audioState.callKitActive,
                audioUnitEnabled: rtcAudio.isAudioEnabled,
                sendingEnabled: localAudioTrack?.isEnabled ?? false,
                receivingEnabled: remoteAudioTrack?.isEnabled ?? false,
                microphoneLevel: microphoneLevel,
                receivedLevel: receivedLevel,
                microphoneEnergy: microphoneEnergy,
                receivedEnergy: receivedEnergy,
                inputRoute: audioSession.currentRoute.inputs.map { $0.portType.rawValue }.joined(separator: ", "),
                outputRoute: audioSession.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ", "),
                outputVolume: Double(audioSession.outputVolume)
            )
        )
    }

    private static func number(_ value: Any?) -> Double {
        (value as? NSNumber)?.doubleValue ?? 0
    }

    private static func integer(_ value: Any?) -> Int64 {
        (value as? NSNumber)?.int64Value ?? 0
    }

    private static func boolean(_ value: Any?) -> Bool {
        (value as? NSNumber)?.boolValue ?? false
    }

    private static func rtcConfiguration(_ media: ICEConfiguration, relayOnly: Bool) -> RTCConfiguration {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        configuration.continualGatheringPolicy = .gatherContinually
        configuration.iceTransportPolicy = relayOnly ? .relay : .all
        configuration.iceServers = media.iceServers.map { server in
            if let username = server.username, let credential = server.credential {
                return RTCIceServer(urlStrings: server.urls.values, username: username, credential: credential)
            }
            return RTCIceServer(urlStrings: server.urls.values)
        }
        return configuration
    }
}

extension WebRTCMediaAdapter: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {
        let track = stream.audioTracks.first
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.remoteAudioTrack = track
            self.applyAudioDirection()
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.remoteAudioTrack = nil
        }
    }
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            switch newState {
            case .connected, .completed:
                if self.connectedAt == nil { self.connectedAt = Date() }
                let measured = await self.statistics()?.candidateType
                guard self.peerConnection === peerConnection else { return }
                let candidate = measured.flatMap { ["host", "srflx", "relay"].contains($0) ? $0 : nil } ?? "host"
                self.emit(.connected, detail: candidate)
            case .disconnected:
                self.emit(.disconnected)
            case .failed:
                self.emit(.failed, detail: "ICE failed")
            default:
                break
            }
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {
        guard newState == .complete else { return }
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.onICEGatheringComplete?()
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        let value = LocalICECandidate(
            candidate: candidate.sdp,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex
        )
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.onLocalCandidate?(value)
        }
    }
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams: [RTCMediaStream]) {
        let track = rtpReceiver.track as? RTCAudioTrack
        Task { @MainActor [weak self] in
            guard let self, self.peerConnection === peerConnection else { return }
            self.remoteAudioTrack = track
            self.applyAudioDirection()
        }
    }
}
