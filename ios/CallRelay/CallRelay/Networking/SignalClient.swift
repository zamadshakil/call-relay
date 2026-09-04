import Combine
import Foundation

@MainActor
final class SignalClient: ObservableObject {
    enum State: String { case disconnected = "Disconnected", connecting = "Connecting", connected = "Connected" }

    @Published private(set) var state: State = .disconnected
    @Published private(set) var androidOnline = false
    @Published private(set) var lastError: String?

    var onCallSnapshot: ((RelayCall) -> Void)?
    var onEnvelope: ((_ type: String, _ payload: [String: Any], _ callId: String, _ negotiationId: String?) -> Void)?
    var onPairingRevoked: ((_ pairingId: String, _ reason: String) -> Void)?
    var onConnected: (() -> Void)?

    private let api: RelayAPI
    private let configuration: AppConfiguration
    private var pairing: StoredPairing?
    private var socket: URLSessionWebSocketTask?
    private var reconnectTask: Task<Void, Never>?
    private var wanted = false
    private var sessionId = ""
    private var sendSequence: Int64 = 0
    private var sequenceGate = SequenceGate()
    private var currentCall: RelayCall?
    private var callVersions: [String: Int] = [:]
    private var newestCallCreatedAt: Int64 = 0

    init(api: RelayAPI, configuration: AppConfiguration = .current) {
        self.api = api
        self.configuration = configuration
    }

    func start(pairing: StoredPairing) {
        if wanted, self.pairing?.id == pairing.id { return }
        stop()
        self.pairing = pairing
        wanted = true
        reconnectTask = Task { [weak self] in await self?.connectionLoop() }
    }

    func stop() {
        wanted = false
        reconnectTask?.cancel()
        reconnectTask = nil
        socket?.cancel(with: .goingAway, reason: nil)
        socket = nil
        sessionId = ""
        sendSequence = 0
        sequenceGate.reset()
        currentCall = nil
        callVersions.removeAll(keepingCapacity: true)
        newestCallCreatedAt = 0
        androidOnline = false
        state = .disconnected
    }

    func send(type: String, callId: String, payload: [String: Any], negotiationId: String? = nil) async throws {
        guard let pairing, let socket, !sessionId.isEmpty, state == .connected else {
            throw RelayError.signaling("Secure signaling is disconnected.")
        }
        if let negotiationId, !Self.validNegotiationId(negotiationId) {
            throw RelayError.signaling("Invalid media negotiation identifier.")
        }
        sendSequence += 1
        let timestamp = Int64(Date().timeIntervalSince1970 * 1_000)
        let payloadData = try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
        let encodedPayload = payloadData.base64URLEncoded
        let canonical = Self.canonical(
            callId: callId,
            senderDeviceId: pairing.peerDeviceId,
            role: "peer",
            sessionId: sessionId,
            sequence: sendSequence,
            timestamp: timestamp,
            type: type,
            payload: encodedPayload,
            negotiationId: negotiationId
        )
        var envelope: [String: Any] = [
            "version": 1,
            "callId": callId,
            "senderDeviceId": pairing.peerDeviceId,
            "role": "peer",
            "sessionId": sessionId,
            "sequence": sendSequence,
            "timestamp": timestamp,
            "type": type,
            "payload": encodedPayload,
            "mac": PairingCrypto.signalMAC(secret: pairing.secret, callId: callId, canonical: canonical)
        ]
        if let negotiationId { envelope["negotiationId"] = negotiationId }
        let data = try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else { throw RelayError.invalidResponse }
        try await socket.send(.string(text))
    }

    private func connectionLoop() async {
        var attempt = 0
        while wanted, !Task.isCancelled {
            do {
                try await connectAndReceive()
                attempt = 0
            } catch is CancellationError {
                break
            } catch {
                lastError = error.localizedDescription
                state = .disconnected
                androidOnline = false
                sessionId = ""
                socket = nil
                guard wanted else { break }
                let delay = min(pow(2.0, Double(attempt)) * 0.5, 10)
                attempt += 1
                try? await Task.sleep(for: .seconds(delay))
            }
        }
    }

    private func connectAndReceive() async throws {
        guard let pairing else { throw RelayError.pairingRequired }
        state = .connecting
        let ticket = try await api.signalTicket(pairingId: pairing.id)
        guard ticket.protocol == "call-relay.signal.v1" else {
            throw RelayError.signaling("The server returned an unsupported signaling protocol.")
        }
        var components = URLComponents(url: configuration.apiBaseURL, resolvingAgainstBaseURL: false)
        components?.scheme = "wss"
        components?.path = "/v1/pairings/\(pairing.id)/signal"
        guard let url = components?.url else { throw RelayError.invalidResponse }
        let task = URLSession.shared.webSocketTask(
            with: url,
            protocols: ["call-relay.signal.v1", "cr-ticket.\(ticket.ticket)"]
        )
        socket = task
        task.resume()

        let pingTask = Task { [weak self, weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(20))
                guard let self, self.wanted, let task else { break }
                try? await task.sendPing()
            }
        }
        defer {
            pingTask.cancel()
            if socket === task { socket = nil }
            if wanted { state = .disconnected }
        }

        while wanted, !Task.isCancelled, socket === task {
            let message = try await task.receive()
            let text: String
            switch message {
            case .string(let value): text = value
            case .data(let data):
                guard let value = String(data: data, encoding: .utf8) else { continue }
                text = value
            @unknown default: continue
            }
            try handle(text)
        }
    }

    private func handle(_ text: String) throws {
        guard let data = text.data(using: .utf8),
              let message = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = message["type"] as? String else { throw RelayError.invalidResponse }
        switch type {
        case "hello":
            guard (message["protocolVersion"] as? NSNumber)?.intValue == 1,
                  message["role"] as? String == "peer",
                  let value = message["sessionId"] as? String, !value.isEmpty else {
                throw RelayError.signaling("The signaling hello was invalid.")
            }
            sessionId = value
            sendSequence = 0
            state = .connected
            lastError = nil
            onConnected?()
        case "presence":
            androidOnline = message["android"] as? Bool ?? false
        case "call_snapshot":
            guard let value = message["call"] as? [String: Any] else { throw RelayError.invalidResponse }
            let callData = try JSONSerialization.data(withJSONObject: value)
            let call = try Self.decoder.decode(RelayCall.self, from: callData)
            if (callVersions[call.id] ?? -1) >= call.version { return }
            if currentCall?.id != call.id, newestCallCreatedAt > call.createdAt { return }
            callVersions[call.id] = call.version
            newestCallCreatedAt = max(newestCallCreatedAt, call.createdAt)
            if callVersions.count > 32 { callVersions = [call.id: call.version] }
            let recipientFinished = call.recipientStatus == .answeredElsewhere || call.recipientStatus == .declined || call.recipientStatus == .missed
            currentCall = call.state.isClosingOrTerminal || recipientFinished ? nil : call
            onCallSnapshot?(call)
        case "pairing_revoked":
            if let pairingId = pairing?.id {
                onPairingRevoked?(pairingId, message["reason"] as? String ?? "Pairing revoked")
            }
            stop()
        case "protocol_error":
            throw RelayError.signaling(message["message"] as? String ?? "Signaling protocol error.")
        default:
            try handleEnvelope(message)
        }
    }

    private func handleEnvelope(_ message: [String: Any]) throws {
        guard let pairing, (message["version"] as? NSNumber)?.intValue == 1,
              let callId = message["callId"] as? String,
              let sender = message["senderDeviceId"] as? String,
              sender == pairing.androidDeviceId,
              message["role"] as? String == "android",
              let remoteSession = message["sessionId"] as? String,
              let sequence = (message["sequence"] as? NSNumber)?.int64Value,
              let timestamp = (message["timestamp"] as? NSNumber)?.int64Value,
              let type = message["type"] as? String,
              let payload = message["payload"] as? String,
              let mac = message["mac"] as? String,
              currentCall?.id == callId else {
            throw RelayError.signaling("A signaling frame had the wrong sender or call.")
        }
        let now = Int64(Date().timeIntervalSince1970 * 1_000)
        guard abs(now - timestamp) <= 300_000 else { throw RelayError.signaling("A stale signaling frame was rejected.") }
        let negotiationId = message["negotiationId"] as? String
        if let negotiationId, !Self.validNegotiationId(negotiationId) { throw RelayError.invalidResponse }
        let canonical = Self.canonical(
            callId: callId,
            senderDeviceId: sender,
            role: "android",
            sessionId: remoteSession,
            sequence: sequence,
            timestamp: timestamp,
            type: type,
            payload: payload,
            negotiationId: negotiationId
        )
        guard PairingCrypto.verifySignalMAC(
            secret: pairing.secret,
            callId: callId,
            canonical: canonical,
            candidate: mac
        ) else { throw RelayError.signaling("Signaling authentication failed.") }
        // Commit the replay watermark only after the frame is authenticated.
        // Otherwise a forged high sequence could suppress valid Android frames.
        guard sequenceGate.accept(sessionId: remoteSession, sequence: sequence) else {
            throw RelayError.signaling("A replayed signaling frame was rejected.")
        }
        guard let decoded = Data(base64URL: payload),
              let value = try JSONSerialization.jsonObject(with: decoded) as? [String: Any] else {
            throw RelayError.invalidResponse
        }
        onEnvelope?(type, value, callId, negotiationId)
    }

    nonisolated static func canonical(
        callId: String,
        senderDeviceId: String,
        role: String,
        sessionId: String,
        sequence: Int64,
        timestamp: Int64,
        type: String,
        payload: String,
        negotiationId: String?
    ) -> String {
        var values = ["1", callId, senderDeviceId, role, sessionId, String(sequence), String(timestamp), type, payload]
        if let negotiationId { values.append(negotiationId) }
        return values.joined(separator: "\n")
    }

    private static func validNegotiationId(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9_-]{8,80}$"#, options: .regularExpression) != nil
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
}

struct SequenceGate {
    private(set) var values: [String: Int64] = [:]

    mutating func accept(sessionId: String, sequence: Int64) -> Bool {
        guard sequence > 0, sequence > (values[sessionId] ?? 0) else { return false }
        values[sessionId] = sequence
        if values.count > 32 {
            values = [sessionId: sequence]
        }
        return true
    }

    mutating func reset() { values.removeAll(keepingCapacity: true) }
}
