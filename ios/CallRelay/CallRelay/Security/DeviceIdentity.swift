import CryptoKit
import Foundation

final class DeviceIdentity: @unchecked Sendable {
    static let shared = try! DeviceIdentity()

    private let signingKey: P256.Signing.PrivateKey
    private let agreementKey: P256.KeyAgreement.PrivateKey
    private let store: KeychainStore

    init(store: KeychainStore = .shared) throws {
        self.store = store
        if let raw = try store.data(for: Keys.signing) {
            signingKey = try P256.Signing.PrivateKey(rawRepresentation: raw)
        } else {
            let key = P256.Signing.PrivateKey()
            try store.set(key.rawRepresentation, for: Keys.signing)
            signingKey = key
        }
        if let raw = try store.data(for: Keys.agreement) {
            agreementKey = try P256.KeyAgreement.PrivateKey(rawRepresentation: raw)
        } else {
            let key = P256.KeyAgreement.PrivateKey()
            try store.set(key.rawRepresentation, for: Keys.agreement)
            agreementKey = key
        }
    }

    var signingPublicKeySPKI: String {
        var spki = Data([
            0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce,
            0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
            0x03, 0x01, 0x07, 0x03, 0x42, 0x00
        ])
        spki.append(signingKey.publicKey.x963Representation)
        return spki.base64URLEncoded
    }

    var agreementPublicKeyRaw: String {
        agreementKey.publicKey.x963Representation.base64URLEncoded
    }

    func sign(_ canonical: Data) throws -> String {
        try signingKey.signature(for: canonical).rawRepresentation.base64URLEncoded
    }

    func derivePairingSecret(androidPublicKeyRaw: Data, challenge: Data) throws -> Data {
        guard challenge.count == 32 else { throw RelayError.pairingProofInvalid }
        let publicKey = try P256.KeyAgreement.PublicKey(x963Representation: androidPublicKeyRaw)
        let shared = try agreementKey.sharedSecretFromKeyAgreement(with: publicKey)
        let material = shared.withUnsafeBytes { Data($0) }
        let key = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: material),
            salt: challenge,
            info: Data("call-relay/pairing/v2".utf8),
            outputByteCount: 32
        )
        return key.withUnsafeBytes { Data($0) }
    }

    private enum Keys {
        static let signing = "device-signing-p256-v1"
        static let agreement = "device-agreement-p256-v1"
    }
}
