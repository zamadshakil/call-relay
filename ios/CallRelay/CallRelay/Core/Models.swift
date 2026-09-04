import Foundation

enum CallDirection: String, Codable, Sendable {
    case incoming
    case outgoing
}

enum RelayCallState: String, Codable, Sendable {
    case created
    case ringingPeer = "ringing_peer"
    case accepted
    case dialingSIM = "dialing_sim"
    case active
    case ending
    case ended
    case failed

    var isTerminal: Bool { self == .ended || self == .failed }
    var isClosingOrTerminal: Bool { self == .ending || isTerminal }
}

enum RecipientStatus: String, Codable, Sendable {
    case ringing
    case selected
    case declined
    case answeredElsewhere = "answered_elsewhere"
    case missed

    var isTerminalForRecipient: Bool {
        self == .declined || self == .answeredElsewhere || self == .missed
    }
}

enum CallKitRecoveryAction: Equatable, Sendable {
    case none
    case useExistingSession
    case reportIncomingAndWaitForAnswer
    case restartOutgoingSession
}

enum RelayMode: String, Codable, CaseIterable, Identifiable, Sendable {
    case fullDuplex = "full_duplex"
    case listen
    case talk

    var id: String { rawValue }
    var title: String {
        switch self {
        case .fullDuplex: "Full duplex"
        case .listen: "Listen"
        case .talk: "Talk"
        }
    }
    var symbol: String {
        switch self {
        case .fullDuplex: "arrow.left.arrow.right"
        case .listen: "ear"
        case .talk: "waveform"
        }
    }
}

struct RelayCall: Codable, Identifiable, Equatable, Sendable {
    let id: String
    let pairingId: String
    let androidDeviceId: String
    let peerDeviceId: String
    let direction: CallDirection
    let state: RelayCallState
    let phoneNumber: String?
    let relayMode: RelayMode
    let createdAt: Int64
    let updatedAt: Int64
    let endedAt: Int64?
    let failureCode: String?
    let version: Int
    let selectedPairingId: String?
    let selectedPeerDeviceId: String?
    let recipientStatus: RecipientStatus?
    let icePolicy: String?
    let selectedCandidateType: String?

    var displayNumber: String { phoneNumber ?? "Android cellular call" }
    var createdDate: Date { Date(timeIntervalSince1970: TimeInterval(createdAt) / 1_000) }

    func callKitRecoveryAction(hasSession: Bool) -> CallKitRecoveryAction {
        guard !state.isClosingOrTerminal, recipientStatus?.isTerminalForRecipient != true else { return .none }
        if hasSession { return .useExistingSession }
        return direction == .incoming ? .reportIncomingAndWaitForAnswer : .restartOutgoingSession
    }
}

struct DeviceRegistration: Codable, Sendable {
    let deviceId: String
    let existing: Bool
}

struct CreatedCall: Codable, Sendable {
    let callId: String
    let state: RelayCallState
    let duplicate: Bool?
}

struct CallResponse: Codable, Sendable {
    let call: RelayCall?
}

struct SignalTicket: Codable, Sendable {
    let ticket: String
    let `protocol`: String
    let expiresAt: Int64
    let role: String
}

struct ICEConfiguration: Codable, Sendable {
    struct Server: Codable, Sendable {
        let urls: OneOrManyStrings
        let username: String?
        let credential: String?
    }

    let transport: String
    let offerer: String
    let protocolVersion: Int
    let iceServers: [Server]
    let credentialsExpiresAt: Int64
}

enum OneOrManyStrings: Codable, Sendable {
    case one(String)
    case many([String])

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let value = try? container.decode(String.self) { self = .one(value) }
        else { self = .many(try container.decode([String].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .one(let value): try container.encode(value)
        case .many(let values): try container.encode(values)
        }
    }

    var values: [String] {
        switch self {
        case .one(let value): [value]
        case .many(let values): values
        }
    }
}

struct AccountSnapshot: Codable, Sendable {
    struct Account: Codable, Sendable {
        let uid: String
        let email: String
        let displayName: String?
        let photoUrl: String?
        let approvalStatus: String
    }
    struct Subscription: Codable, Sendable {
        let status: String
        let active: Bool
        let billingRequired: Bool
        let accessMode: String
    }
    struct Device: Codable, Identifiable, Sendable {
        struct Presence: Codable, Sendable {
            let relayReady: Bool
            let signalState: String
            let activeCallId: String?
            let heartbeatFresh: Bool
            let lastErrorCode: String?
        }
        let id: String
        let platform: String
        let displayName: String
        let lastAuthenticatedAt: Int64
        let relayPresence: Presence?
    }
    struct Pairing: Codable, Identifiable, Sendable {
        let id: String
        let confirmedAt: Int64?
        let protocolVersion: Int
        let deviceAId: String
        let deviceBId: String
        let deviceAName: String?
        let deviceAPlatform: String?
        let deviceBName: String?
        let deviceBPlatform: String?
        let secretCommitment: String?
        let peerProof: String?
        let androidProof: String?
        let invitationId: String?
        let peerPublicKeyRaw: String?
    }

    let account: Account
    let subscription: Subscription
    let devices: [Device]
    let pairing: Pairing?
    let pairings: [Pairing]?
}

struct PairingConsumeResponse: Codable, Sendable {
    let pairingId: String
    let status: String
}

struct DiagnosticsSnapshot: Sendable {
    let environment: String
    let deviceId: String?
    let pairingId: String?
    let socketState: String
    let callId: String?
    let callState: String?
    let mediaState: String
    let candidateType: String?
    let lastError: String?
}
