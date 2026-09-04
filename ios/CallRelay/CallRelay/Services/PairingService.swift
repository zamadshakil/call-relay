import Combine
import Foundation

@MainActor
final class PairingService: ObservableObject {
    enum Status: Equatable {
        case unregistered
        case ready(StoredPairing)
        case pairing(String)
        case unavailable(String)
    }

    @Published private(set) var status: Status = .unregistered
    @Published private(set) var account: AccountSnapshot?
    @Published private(set) var isBusy = false
    @Published private(set) var canReplaceExistingIPhone = false

    private let api: RelayAPI
    private let identity: DeviceIdentity
    private let store: PairingStore
    private let configuration: AppConfiguration

    init(api: RelayAPI, identity: DeviceIdentity = .shared, store: PairingStore = PairingStore(), configuration: AppConfiguration = .current) {
        self.api = api
        self.identity = identity
        self.store = store
        self.configuration = configuration
    }

    var activePairing: StoredPairing? {
        if case .ready(let pairing) = status { return pairing }
        return nil
    }

    func bootstrap() async {
        isBusy = true
        canReplaceExistingIPhone = false
        defer { isBusy = false }
        do {
            _ = try await api.registerThisIPhone()
            account = try await api.accountSnapshot()
            try await reconcileLocalPairing()
        } catch RelayError.api(let statusCode, _, _) where statusCode == 409 {
            canReplaceExistingIPhone = true
            status = .unavailable("This account already has a different iPhone registration. Replace it only if this is a reinstall or the old iPhone is no longer used.")
        } catch {
            status = .unavailable(error.localizedDescription)
        }
    }

    func scanAndPair(_ value: String) async throws {
        guard let host = configuration.apiBaseURL.host else { throw RelayError.invalidResponse }
        let invitation = try PairingInvitation.parse(scannedValue: value, expectedAPIHost: host)
        guard let peerDeviceId = api.deviceId else { throw RelayError.deviceNotRegistered }
        isBusy = true
        status = .pairing("Creating encrypted pairing…")
        defer {
            isBusy = false
            if case .pairing = status { status = .unregistered }
        }

        let secret = try identity.derivePairingSecret(
            androidPublicKeyRaw: invitation.androidPublicKeyRaw,
            challenge: invitation.challenge
        )
        let consumed = try await api.consume(invitation, secret: secret)
        let pending = PendingPairing(
            id: consumed.pairingId,
            invitationId: invitation.id,
            peerDeviceId: peerDeviceId,
            secret: secret,
            createdAt: Date()
        )
        // Persist immediately after the invitation is consumed so a process exit
        // or temporary network loss cannot strand an unconfirmed pairing.
        try store.savePending(pending)
        status = .pairing("Waiting for Android confirmation…")
        do {
            try await reconcilePendingPairing(pending)
        } catch {
            if (try? store.loadPending()) != nil || (try? store.load())?.confirmed == false {
                status = .unavailable("Pairing confirmation was interrupted. Tap Retry registration to resume it.")
            }
            throw error
        }
        guard activePairing != nil else { throw RelayError.pairingExpired }
        account = try? await api.accountSnapshot()
    }

    func refreshAccount() async {
        account = try? await api.accountSnapshot()
    }

    func removeThisIPhone() async throws {
        try await api.revokeThisDevice()
        try store.clear()
        try store.clearPending()
        status = .unregistered
        account = nil
        canReplaceExistingIPhone = false
    }

    func replaceExistingIPhone() async throws {
        isBusy = true
        status = .pairing("Replacing the old iPhone registration…")
        defer { isBusy = false }
        do {
            _ = try await api.registerThisIPhone(replaceExisting: true)
            try store.clear()
            try store.clearPending()
            account = try? await api.accountSnapshot()
            canReplaceExistingIPhone = false
            status = .unregistered
        } catch {
            status = .unavailable(error.localizedDescription)
            throw error
        }
    }

    func handlePairingRevoked(pairingId: String) async {
        let stored = try? store.load()
        let pending = try? store.loadPending()
        guard stored?.id == pairingId || pending?.id == pairingId || activePairing?.id == pairingId else { return }
        try? store.clear()
        try? store.clearPending()
        status = .unregistered
        canReplaceExistingIPhone = false
        account = try? await api.accountSnapshot()
    }

    private func reconcileLocalPairing() async throws {
        guard let saved = try store.load() else {
            if let pending = try store.loadPending() {
                try await reconcilePendingPairing(pending)
            } else {
                status = .unregistered
            }
            return
        }
        let deadline = max(saved.createdAt.addingTimeInterval(300), Date().addingTimeInterval(5))
        while Date() < deadline {
            let response = try await api.pairings()
            let server = (response.pairings ?? [response.pairing].compactMap { $0 })
                .first { $0.id == saved.id }
            guard let server else {
                if saved.confirmed {
                    try store.clear()
                    status = .unregistered
                    return
                }
                status = .pairing("Restoring pending Android confirmation…")
                try await Task.sleep(for: .seconds(2))
                continue
            }
            if server.confirmedAt != nil {
                if !saved.confirmed {
                    guard let proof = server.androidProof, PairingCrypto.verifyAndroidProof(
                        proof,
                        secret: saved.secret,
                        invitationId: saved.invitationId,
                        pairingId: saved.id,
                        androidDeviceId: saved.androidDeviceId,
                        peerDeviceId: saved.peerDeviceId,
                        commitment: PairingCrypto.commitment(saved.secret)
                    ) else { throw RelayError.pairingProofInvalid }
                    var confirmed = saved
                    confirmed.confirmed = true
                    try store.save(confirmed)
                    try? store.clearPending()
                    status = .ready(confirmed)
                } else {
                    try? store.clearPending()
                    status = .ready(saved)
                }
                return
            }
            status = .pairing("Restoring pending Android confirmation…")
            try await Task.sleep(for: .seconds(2))
        }
        try store.clear()
        try store.clearPending()
        status = .unregistered
    }

    private func reconcilePendingPairing(_ pending: PendingPairing) async throws {
        let deadline = max(pending.createdAt.addingTimeInterval(300), Date().addingTimeInterval(5))
        while Date() < deadline {
            let response = try await api.pairings()
            if let row = (response.pairings ?? [response.pairing].compactMap { $0 }).first(where: { $0.id == pending.id }) {
                guard let androidDeviceId = Self.androidDeviceId(in: row),
                      row.deviceAId == pending.peerDeviceId || row.deviceBId == pending.peerDeviceId else {
                    try? store.clearPending()
                    throw RelayError.pairingProofInvalid
                }
                var saved = StoredPairing(
                    id: row.id,
                    invitationId: pending.invitationId,
                    androidDeviceId: androidDeviceId,
                    peerDeviceId: pending.peerDeviceId,
                    secret: pending.secret,
                    confirmed: false,
                    createdAt: pending.createdAt
                )
                try store.save(saved)
                try store.clearPending()
                if row.confirmedAt != nil {
                    guard let proof = row.androidProof, PairingCrypto.verifyAndroidProof(
                        proof,
                        secret: pending.secret,
                        invitationId: pending.invitationId,
                        pairingId: row.id,
                        androidDeviceId: androidDeviceId,
                        peerDeviceId: pending.peerDeviceId,
                        commitment: PairingCrypto.commitment(pending.secret)
                    ) else {
                        try? store.clear()
                        throw RelayError.pairingProofInvalid
                    }
                    saved.confirmed = true
                    try store.save(saved)
                    status = .ready(saved)
                    return
                }
                status = .pairing("Restoring pending Android confirmation…")
                try await reconcileLocalPairing()
                return
            }
            status = .pairing("Restoring pending Android confirmation…")
            try await Task.sleep(for: .seconds(2))
        }
        try store.clearPending()
        status = .unregistered
    }

    private static func androidDeviceId(in pairing: AccountSnapshot.Pairing) -> String? {
        if pairing.deviceAPlatform == "android" { return pairing.deviceAId }
        if pairing.deviceBPlatform == "android" { return pairing.deviceBId }
        return nil
    }
}
