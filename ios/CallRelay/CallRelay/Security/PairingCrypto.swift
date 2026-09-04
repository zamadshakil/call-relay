import CryptoKit
import Foundation

struct PairingInvitation: Equatable, Sendable {
    let id: String
    let challenge: Data
    let androidPublicKeyRaw: Data

    static func parse(scannedValue: String, expectedAPIHost: String) throws -> PairingInvitation {
        guard let url = URL(string: scannedValue), url.scheme == "https", url.host == expectedAPIHost,
              let fragment = url.fragment else {
            throw RelayError.configuration("Scan a Call Relay QR from the selected environment.")
        }
        var components = URLComponents()
        components.query = fragment
        var fields: [String: String] = [:]
        for item in components.queryItems ?? [] {
            guard let value = item.value, !value.isEmpty, fields.updateValue(value, forKey: item.name) == nil else {
                throw RelayError.configuration("The pairing QR contains duplicate or empty fields.")
            }
        }
        guard fields["v"] == "2", let id = fields["id"],
              id.range(of: #"^inv_[a-f0-9]{32}$"#, options: .regularExpression) != nil,
              let challengeText = fields["c"], let challenge = Data(base64URL: challengeText), challenge.count == 32,
              let publicText = fields["k"], let publicKey = Data(base64URL: publicText),
              publicKey.count == 65, publicKey.first == 4 else {
            throw RelayError.configuration("The pairing QR is invalid or unsupported.")
        }
        return PairingInvitation(id: id, challenge: challenge, androidPublicKeyRaw: publicKey)
    }
}

enum PairingCrypto {
    static func challengeHash(_ challenge: Data) -> String {
        Data(SHA256.hash(data: challenge)).base64URLEncoded
    }

    static func commitment(_ secret: Data) -> String {
        Data(SHA256.hash(data: secret)).base64URLEncoded
    }

    static func peerProof(
        secret: Data,
        invitationId: String,
        peerDeviceId: String,
        peerPublicKeyRaw: String,
        commitment: String
    ) -> String {
        mac(
            secret: secret,
            text: ["peer", invitationId, peerDeviceId, peerPublicKeyRaw, commitment].joined(separator: "\n")
        ).base64URLEncoded
    }

    static func verifyAndroidProof(
        _ candidate: String,
        secret: Data,
        invitationId: String,
        pairingId: String,
        androidDeviceId: String,
        peerDeviceId: String,
        commitment: String
    ) -> Bool {
        guard let decoded = Data(base64URL: candidate) else { return false }
        let expected = mac(
            secret: secret,
            text: ["android", invitationId, pairingId, androidDeviceId, peerDeviceId, commitment].joined(separator: "\n")
        )
        return ConstantTime.equal(decoded, expected)
    }

    static func signalingKey(secret: Data, callId: String) -> SymmetricKey {
        HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: secret),
            salt: Data(callId.utf8),
            info: Data("call-relay/signaling/v1".utf8),
            outputByteCount: 32
        )
    }

    static func signalMAC(secret: Data, callId: String, canonical: String) -> String {
        let authentication = HMAC<SHA256>.authenticationCode(
            for: Data(canonical.utf8),
            using: signalingKey(secret: secret, callId: callId)
        )
        return Data(authentication).base64URLEncoded
    }

    static func verifySignalMAC(secret: Data, callId: String, canonical: String, candidate: String) -> Bool {
        guard let decoded = Data(base64URL: candidate) else { return false }
        let expected = Data(HMAC<SHA256>.authenticationCode(
            for: Data(canonical.utf8),
            using: signalingKey(secret: secret, callId: callId)
        ))
        return ConstantTime.equal(decoded, expected)
    }

    private static func mac(secret: Data, text: String) -> Data {
        Data(HMAC<SHA256>.authenticationCode(for: Data(text.utf8), using: SymmetricKey(data: secret)))
    }
}

struct StoredPairing: Codable, Equatable, Sendable {
    let id: String
    let invitationId: String
    let androidDeviceId: String
    let peerDeviceId: String
    let secret: Data
    var confirmed: Bool
    let createdAt: Date
}

struct PendingPairing: Codable, Equatable, Sendable {
    let id: String
    let invitationId: String
    let peerDeviceId: String
    let secret: Data
    let createdAt: Date
}

final class PairingStore: @unchecked Sendable {
    private let keychain: KeychainStore
    init(keychain: KeychainStore = .shared) { self.keychain = keychain }

    func load() throws -> StoredPairing? {
        guard let data = try keychain.data(for: "active-pairing-v2") else { return nil }
        return try JSONDecoder().decode(StoredPairing.self, from: data)
    }

    func save(_ pairing: StoredPairing) throws {
        try keychain.set(JSONEncoder().encode(pairing), for: "active-pairing-v2")
    }

    func clear() throws { try keychain.remove("active-pairing-v2") }

    func loadPending() throws -> PendingPairing? {
        guard let data = try keychain.data(for: "pending-pairing-v2") else { return nil }
        return try JSONDecoder().decode(PendingPairing.self, from: data)
    }

    func savePending(_ pairing: PendingPairing) throws {
        try keychain.set(JSONEncoder().encode(pairing), for: "pending-pairing-v2")
    }

    func clearPending() throws { try keychain.remove("pending-pairing-v2") }
}
