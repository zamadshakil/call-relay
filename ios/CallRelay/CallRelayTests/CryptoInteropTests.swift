import CryptoKit
import XCTest
@testable import CallRelay

final class CryptoInteropTests: XCTestCase {
    func testDeviceSignatureUsesRawP256Format() throws {
        let store = KeychainStore(service: "dev.zamad.callrelay.tests.\(UUID().uuidString)")
        let identity = try DeviceIdentity(store: store)
        let message = Data("signed request".utf8)
        let signature = try XCTUnwrap(Data(base64URL: try identity.sign(message)))
        XCTAssertEqual(signature.count, 64)

        let spki = try XCTUnwrap(Data(base64URL: identity.signingPublicKeySPKI))
        let publicKey = try P256.Signing.PublicKey(x963Representation: spki.suffix(65))
        let parsed = try P256.Signing.ECDSASignature(rawRepresentation: signature)
        XCTAssertTrue(publicKey.isValidSignature(parsed, for: message))
    }

    func testPairingProofGoldenVectorMatchesAndroid() throws {
        let secret = Data((0..<32).map(UInt8.init))
        let invitation = "inv_0123456789abcdef0123456789abcdef"
        let peer = "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        let publicKey = String(repeating: "B", count: 87)
        let commitment = PairingCrypto.commitment(secret)
        XCTAssertEqual(commitment, "Yw3NKWbEM2aRElRIu7JbT_QSpJxzLbLIq8G4WBvXEN0")
        XCTAssertEqual(
            PairingCrypto.peerProof(
                secret: secret,
                invitationId: invitation,
                peerDeviceId: peer,
                peerPublicKeyRaw: publicKey,
                commitment: commitment
            ),
            "x8PhslyIv8t3MY_NeCOUAWJjf2jlmvhNZIY-PnWwY_Q"
        )
        XCTAssertTrue(PairingCrypto.verifyAndroidProof(
            "73slpW1L0-Xh4jXGIlDezBAgD-ylseocBdsP7vb4_cw",
            secret: secret,
            invitationId: invitation,
            pairingId: "pair_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            androidDeviceId: "dev_cccccccccccccccccccccccccccccccc",
            peerDeviceId: peer,
            commitment: commitment
        ))
    }

    func testSignalHMACGoldenVectorMatchesAndroid() {
        let secret = Data((0..<32).map(UInt8.init))
        let call = "call_0123456789abcdef0123456789abcdef"
        let canonical = SignalClient.canonical(
            callId: call,
            senderDeviceId: "dev_android",
            role: "android",
            sessionId: "session-1",
            sequence: 1,
            timestamp: 1_700_000_000_000,
            type: "offer",
            payload: "e30",
            negotiationId: nil
        )
        XCTAssertEqual(
            PairingCrypto.signalMAC(secret: secret, callId: call, canonical: canonical),
            "EO-JysYshH5JQY91m0_4RtF6ttFdvhYDQiJN0Ok-3Ro"
        )
    }
}
