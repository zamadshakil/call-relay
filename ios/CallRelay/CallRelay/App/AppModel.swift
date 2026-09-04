import Combine
import Foundation
import SwiftData

@MainActor
final class AppModel: ObservableObject {
    let auth: AuthService
    let api: RelayAPI
    let pairing: PairingService
    let contacts: ContactsService
    let calls: CallCoordinator

    @Published private(set) var bootstrappedUserID: String?

    init(modelContext: ModelContext) {
        let auth = AuthService()
        let api = RelayAPI(auth: auth)
        let pairing = PairingService(api: api)
        let contacts = ContactsService()
        let signal = SignalClient(api: api)
        self.auth = auth
        self.api = api
        self.pairing = pairing
        self.contacts = contacts
        let calls = CallCoordinator(
            api: api,
            signal: signal,
            contacts: contacts,
            history: CallHistoryStore(context: modelContext)
        )
        self.calls = calls
        calls.onPairingRevoked = { [weak pairing] pairingId, _ in
            Task { @MainActor in await pairing?.handlePairingRevoked(pairingId: pairingId) }
        }
    }

    func authenticationChanged() async {
        guard let user = auth.user else {
            calls.deactivate()
            bootstrappedUserID = nil
            return
        }
        guard bootstrappedUserID != user.uid else { return }
        bootstrappedUserID = user.uid
        async let contactsLoad: Void = contacts.requestAndLoad()
        await pairing.bootstrap()
        _ = await contactsLoad
        if let ready = pairing.activePairing { calls.activate(pairing: ready) }
    }

    func pair(scannedValue: String) async throws {
        try await pairing.scanAndPair(scannedValue)
        if let ready = pairing.activePairing { calls.activate(pairing: ready) }
    }

    func retrySetup() async {
        guard auth.user != nil else { return }
        calls.deactivate()
        await pairing.bootstrap()
        if let ready = pairing.activePairing { calls.activate(pairing: ready) }
    }

    func replaceExistingIPhone() async throws {
        calls.deactivate()
        try await pairing.replaceExistingIPhone()
    }

    func placeCall(_ rawNumber: String) async throws {
        guard let ready = pairing.activePairing else { throw RelayError.pairingRequired }
        guard await AudioSessionController.ensureMicrophonePermission() else {
            throw RelayError.media("Enable Microphone access for Call Relay in iPhone Settings.")
        }
        let normalized = try PhoneNumberPolicy().normalize(rawNumber)
        await calls.startOutgoing(number: normalized, pairing: ready)
        if let message = calls.errorMessage { throw RelayError.media(message) }
    }

    func signOut() {
        calls.deactivate()
        bootstrappedUserID = nil
        auth.signOut()
    }

    func removeThisIPhone() async throws {
        calls.deactivate()
        try await pairing.removeThisIPhone()
        await pairing.bootstrap()
    }

}
