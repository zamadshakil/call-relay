import XCTest
@testable import CallRelay

final class ProtocolPolicyTests: XCTestCase {
    func testCallKitActivationBeforeMediaPreparationSurvivesPeerReset() {
        var audio = CallAudioState()
        audio.callKitActive = true
        XCTAssertFalse(audio.audioEnabled)
        audio.mediaPrepared = true
        XCTAssertTrue(audio.sendingEnabled)
        XCTAssertTrue(audio.receivingEnabled)
        audio.mediaPrepared = false
        XCTAssertFalse(audio.audioEnabled)
        XCTAssertTrue(audio.callKitActive)
        audio.mediaPrepared = true
        XCTAssertTrue(audio.audioEnabled)
    }

    func testMediaPreparedBeforeCallKitWaitsForActivationAndStopsOnDeactivation() {
        var audio = CallAudioState()
        audio.mediaPrepared = true
        XCTAssertFalse(audio.sendingEnabled)
        XCTAssertFalse(audio.receivingEnabled)
        audio.callKitActive = true
        XCTAssertTrue(audio.audioEnabled)
        audio.callKitActive = false
        XCTAssertFalse(audio.sendingEnabled)
        XCTAssertFalse(audio.receivingEnabled)
    }

    func testAudioModesAndMutePreserveReceiveDirectionAcrossRecovery() {
        var audio = CallAudioState(callKitActive: true, mediaPrepared: true)
        audio.muted = true
        XCTAssertFalse(audio.sendingEnabled)
        XCTAssertTrue(audio.receivingEnabled)
        audio.mediaPrepared = false
        audio.mediaPrepared = true
        XCTAssertFalse(audio.sendingEnabled)
        audio.muted = false
        audio.mode = .listen
        XCTAssertFalse(audio.sendingEnabled)
        XCTAssertTrue(audio.receivingEnabled)
        audio.mode = .talk
        XCTAssertTrue(audio.sendingEnabled)
        XCTAssertFalse(audio.receivingEnabled)
    }

    func testSequenceGateRejectsReplayAndSeparatesSessions() {
        var gate = SequenceGate()
        XCTAssertTrue(gate.accept(sessionId: "one", sequence: 1))
        XCTAssertFalse(gate.accept(sessionId: "one", sequence: 1))
        XCTAssertFalse(gate.accept(sessionId: "one", sequence: 0))
        XCTAssertTrue(gate.accept(sessionId: "one", sequence: 2))
        XCTAssertTrue(gate.accept(sessionId: "two", sequence: 1))
    }

    func testQRValidationBindsEnvironmentAndVersion() throws {
        let challenge = Data(repeating: 7, count: 32).base64URLEncoded
        let publicKey = (Data([4]) + Data(repeating: 8, count: 64)).base64URLEncoded
        let value = "https://relay.example/pair#v=2&id=inv_0123456789abcdef0123456789abcdef&c=\(challenge)&k=\(publicKey)"
        let invitation = try PairingInvitation.parse(scannedValue: value, expectedAPIHost: "relay.example")
        XCTAssertEqual(invitation.challenge.count, 32)
        XCTAssertThrowsError(try PairingInvitation.parse(scannedValue: value, expectedAPIHost: "production.example"))
        XCTAssertThrowsError(try PairingInvitation.parse(
            scannedValue: value.replacingOccurrences(of: "v=2&", with: "v=2&v=2&"),
            expectedAPIHost: "relay.example"
        ))
    }

    func testEmergencyAndServiceCodesAreBlocked() {
        XCTAssertTrue(PhoneNumberPolicy.isEmergencyOrServiceCode("911"))
        XCTAssertTrue(PhoneNumberPolicy.isEmergencyOrServiceCode("*123#"))
        XCTAssertThrowsError(try PhoneNumberPolicy().normalize("112", region: "GB"))
        XCTAssertThrowsError(try PhoneNumberPolicy().normalize("*#06#", region: "US"))
    }

    func testE164Normalization() throws {
        XCTAssertEqual(try PhoneNumberPolicy().normalize("+1 (415) 555-2671", region: "US"), "+14155552671")
    }

    func testSignedRequestCanonicalMatchesServerVector() throws {
        let body = RelayRequestSigning.bodyData([
            "type": "accept",
            "commandId": "11111111-2222-4333-8444-555555555555"
        ])
        XCTAssertEqual(
            String(decoding: body, as: UTF8.self),
            #"{"commandId":"11111111-2222-4333-8444-555555555555","type":"accept"}"#
        )
        XCTAssertEqual(body.sha256Hex, "749c1f07b8262baa47d9c372a2147d307ecc2629148787e1a80f71891d2eda01")
        XCTAssertEqual(
            RelayRequestSigning.canonical(
                method: "post",
                path: "/v1/calls/call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events",
                body: body,
                timestamp: "1700000000123",
                nonce: "99999999-8888-4777-8666-555555555555"
            ),
            "POST\n/v1/calls/call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/events\n749c1f07b8262baa47d9c372a2147d307ecc2629148787e1a80f71891d2eda01\n1700000000123\n99999999-8888-4777-8666-555555555555"
        )
    }

    func testRecipientTerminalAndCallKitRecoveryDecisions() {
        XCTAssertTrue(RecipientStatus.answeredElsewhere.isTerminalForRecipient)
        XCTAssertTrue(RecipientStatus.declined.isTerminalForRecipient)
        XCTAssertTrue(RecipientStatus.missed.isTerminalForRecipient)
        XCTAssertFalse(RecipientStatus.selected.isTerminalForRecipient)

        XCTAssertEqual(makeCall(direction: .incoming, state: .active, recipient: .selected)
            .callKitRecoveryAction(hasSession: false), .reportIncomingAndWaitForAnswer)
        XCTAssertEqual(makeCall(direction: .incoming, state: .active, recipient: .selected)
            .callKitRecoveryAction(hasSession: true), .useExistingSession)
        XCTAssertEqual(makeCall(direction: .outgoing, state: .accepted, recipient: .selected)
            .callKitRecoveryAction(hasSession: false), .restartOutgoingSession)
        XCTAssertEqual(makeCall(direction: .incoming, state: .active, recipient: .answeredElsewhere)
            .callKitRecoveryAction(hasSession: false), .none)
        XCTAssertEqual(makeCall(direction: .incoming, state: .active, recipient: .declined)
            .callKitRecoveryAction(hasSession: false), .none)
        XCTAssertEqual(makeCall(direction: .outgoing, state: .ended, recipient: .selected)
            .callKitRecoveryAction(hasSession: false), .none)
    }

    private func makeCall(
        id: String = "call_0123456789abcdef0123456789abcdef",
        direction: CallDirection,
        state: RelayCallState,
        recipient: RecipientStatus?
    ) -> RelayCall {
        RelayCall(
            id: id,
            pairingId: "pair_0123456789abcdef0123456789abcdef",
            androidDeviceId: "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            peerDeviceId: "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            direction: direction,
            state: state,
            phoneNumber: "+14155552671",
            relayMode: .fullDuplex,
            createdAt: 1_700_000_000_000,
            updatedAt: 1_700_000_000_000,
            endedAt: state.isTerminal ? 1_700_000_001_000 : nil,
            failureCode: nil,
            version: 1,
            selectedPairingId: "pair_0123456789abcdef0123456789abcdef",
            selectedPeerDeviceId: "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            recipientStatus: recipient,
            icePolicy: "all",
            selectedCandidateType: "host"
        )
    }
}
