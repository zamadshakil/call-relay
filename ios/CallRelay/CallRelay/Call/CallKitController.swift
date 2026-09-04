import AVFoundation
import CallKit
import Combine
import CryptoKit
import Foundation

@MainActor
final class CallKitController: NSObject, ObservableObject {
    var onAnswer: ((CXAnswerCallAction) -> Void)?
    var onEnd: ((CXEndCallAction) -> Void)?
    var onMute: ((CXSetMutedCallAction) -> Void)?
    var onDTMF: ((CXPlayDTMFCallAction) -> Void)?
    var onAudioActivated: ((Bool) -> Void)?
    var onPrepareAudio: (() throws -> Void)?
    var onAudioPreparationFailed: ((String) -> Void)?
    var onProviderReset: (() -> Void)?

    private let provider: CXProvider
    private let controller = CXCallController()
    private var ids: [String: UUID] = [:]
    private var callIds: [UUID: String] = [:]

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.phoneNumber, .generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func reportIncoming(call: RelayCall, displayName: String?) async throws {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(
            type: call.phoneNumber == nil ? .generic : .phoneNumber,
            value: call.displayNumber
        )
        update.localizedCallerName = displayName ?? call.displayNumber
        update.hasVideo = false
        update.supportsDTMF = true
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        if let uuid = ids[call.id] {
            provider.reportCall(with: uuid, updated: update)
            return
        }
        let uuid = uuid(for: call.id)
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                provider.reportNewIncomingCall(with: uuid, update: update) { error in
                    if let error { continuation.resume(throwing: error) }
                    else { continuation.resume(returning: ()) }
                }
            }
        } catch {
            forget(callId: call.id)
            throw error
        }
    }

    func startOutgoing(call: RelayCall, displayName: String?) async throws {
        let handle = CXHandle(type: .phoneNumber, value: call.displayNumber)
        if let uuid = ids[call.id] {
            let update = CXCallUpdate()
            update.remoteHandle = handle
            update.localizedCallerName = displayName ?? call.displayNumber
            provider.reportCall(with: uuid, updated: update)
            return
        }
        let uuid = uuid(for: call.id)
        let action = CXStartCallAction(call: uuid, handle: handle)
        action.isVideo = false
        do {
            try await request(CXTransaction(action: action))
        } catch {
            forget(callId: call.id)
            throw error
        }
        provider.reportOutgoingCall(with: uuid, startedConnectingAt: Date())
        if let displayName {
            let update = CXCallUpdate()
            update.remoteHandle = handle
            update.localizedCallerName = displayName
            provider.reportCall(with: uuid, updated: update)
        }
    }

    func reportConnected(callId: String) {
        guard let uuid = ids[callId] else { return }
        provider.reportOutgoingCall(with: uuid, connectedAt: Date())
    }

    func requestEnd(callId: String) async throws {
        guard let uuid = ids[callId] else { throw RelayError.media("The CallKit session is unavailable.") }
        try await request(CXTransaction(action: CXEndCallAction(call: uuid)))
    }

    func requestMute(callId: String, muted: Bool) async throws {
        guard let uuid = ids[callId] else { throw RelayError.media("The CallKit session is unavailable.") }
        try await request(CXTransaction(action: CXSetMutedCallAction(call: uuid, muted: muted)))
    }

    func requestDTMF(callId: String, digit: String) async throws {
        guard let uuid = ids[callId] else { throw RelayError.media("The CallKit session is unavailable.") }
        let action = CXPlayDTMFCallAction(call: uuid, digits: digit, type: .singleTone)
        try await request(CXTransaction(action: action))
    }

    func reportEnded(callId: String, reason: CXCallEndedReason) {
        guard let uuid = ids.removeValue(forKey: callId) else { return }
        callIds.removeValue(forKey: uuid)
        provider.reportCall(with: uuid, endedAt: Date(), reason: reason)
    }

    func callId(for action: CXCallAction) -> String? { callIds[action.callUUID] }

    func hasCall(_ callId: String) -> Bool { ids[callId] != nil }

    private func uuid(for callId: String) -> UUID {
        if let existing = ids[callId] { return existing }
        var bytes = Array(SHA256.hash(data: Data(callId.utf8)).prefix(16))
        bytes[6] = (bytes[6] & 0x0f) | 0x40
        bytes[8] = (bytes[8] & 0x3f) | 0x80
        let uuid = UUID(uuid: (
            bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15]
        ))
        ids[callId] = uuid
        callIds[uuid] = callId
        return uuid
    }

    private func forget(callId: String) {
        guard let uuid = ids.removeValue(forKey: callId) else { return }
        callIds.removeValue(forKey: uuid)
    }

    private func request(_ transaction: CXTransaction) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            controller.request(transaction) { error in
                if let error { continuation.resume(throwing: error) }
                else { continuation.resume(returning: ()) }
            }
        }
    }
}

extension CallKitController: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        Task { @MainActor in
            ids.removeAll(keepingCapacity: true)
            callIds.removeAll(keepingCapacity: true)
            onAudioActivated?(false)
            onProviderReset?()
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        Task { @MainActor in
            do {
                guard let onPrepareAudio else { action.fail(); return }
                try onPrepareAudio()
                action.fulfill()
            } catch {
                action.fail()
                onAudioPreparationFailed?(error.localizedDescription)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        Task { @MainActor in
            do {
                guard let onPrepareAudio, let onAnswer else { action.fail(); return }
                try onPrepareAudio()
                onAnswer(action)
            } catch {
                action.fail()
                onAudioPreparationFailed?(error.localizedDescription)
            }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        Task { @MainActor in
            if let onEnd { onEnd(action) } else { action.fulfill() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        Task { @MainActor in
            if let onMute { onMute(action) } else { action.fail() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXPlayDTMFCallAction) {
        Task { @MainActor in
            if let onDTMF { onDTMF(action) } else { action.fail() }
        }
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        Task { @MainActor in onAudioActivated?(true) }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        Task { @MainActor in onAudioActivated?(false) }
    }
}
