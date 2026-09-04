import AVFoundation
import CallKit
import Combine
import Foundation
import Network

@MainActor
final class CallCoordinator: ObservableObject {
    @Published private(set) var currentCall: RelayCall?
    @Published private(set) var mediaState: MediaConnectionState = .idle
    @Published private(set) var connectionDetail: String?
    @Published private(set) var mediaQuality: MediaQuality = .unknown
    @Published private(set) var mediaStatistics: MediaStatistics?
    @Published private(set) var packetLossPercent: Double?
    @Published private(set) var activeSince: Date?
    @Published var isMuted = false
    @Published var mode: RelayMode = .fullDuplex
    @Published var showingDTMF = false
    @Published var errorMessage: String?

    let signal: SignalClient
    let audio: AudioSessionController
    var onPairingRevoked: ((_ pairingId: String, _ reason: String) -> Void)?

    private let api: RelayAPI
    private let media: MediaAdapter
    private let callKit: CallKitController
    private let contacts: ContactsService
    private let history: CallHistoryStore
    private var mediaCallId: String?
    private var directDeadline: Task<Void, Never>?
    private var setupDeadline: Task<Void, Never>?
    private var credentialRefresh: Task<Void, Never>?
    private var didForceRelay = false
    private var recordedCallIds = Set<String>()
    private var acceptedLocallyCallIds = Set<String>()
    private var incomingAwaitingUserAnswer = Set<String>()
    private var mediaPreparedCallId: String?
    private var remoteDescriptionNegotiationId: String?
    private var offerInFlight = false
    private var pendingOffers: [String: (payload: [String: Any], negotiationId: String?)] = [:]
    private var pendingCandidates: [String: [LocalICECandidate]] = [:]
    private var mediaGeneration = 0
    private var statsTask: Task<Void, Never>?
    private var previousStatistics: MediaStatistics?
    private var statsEmissionCounter = 0
    private var iceRestartCount = 0
    private let networkMonitor = NWPathMonitor()
    private let networkQueue = DispatchQueue(label: "dev.zamad.callrelay.network")
    private var lastNetworkSignature: String?
    private var networkWasSatisfied = false
    private var networkRestartTask: Task<Void, Never>?

    init(
        api: RelayAPI,
        signal: SignalClient,
        media: MediaAdapter? = nil,
        callKit: CallKitController? = nil,
        audio: AudioSessionController? = nil,
        contacts: ContactsService,
        history: CallHistoryStore
    ) {
        self.api = api
        self.signal = signal
        self.media = media ?? WebRTCMediaAdapter()
        self.callKit = callKit ?? CallKitController()
        self.audio = audio ?? AudioSessionController()
        self.contacts = contacts
        self.history = history
        wireCallbacks()
        startNetworkMonitoring()
    }

    deinit { networkMonitor.cancel() }

    func activate(pairing: StoredPairing) {
        signal.start(pairing: pairing)
        Task { await recoverAuthoritativeCall() }
    }

    func deactivate() {
        signal.stop()
        finishLocalCall(reason: .failed)
    }

    func recoverAuthoritativeCall() async {
        do {
            guard let call = try await api.currentCall() else {
                if currentCall != nil { finishLocalCall(reason: .remoteEnded) }
                return
            }
            await apply(call)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func startOutgoing(number: String, pairing: StoredPairing) async {
        errorMessage = nil
        var createdCallId: String?
        do {
            let created = try await api.createOutgoing(phoneNumber: number, pairingId: pairing.id)
            createdCallId = created.callId
            guard let call = try await api.call(id: created.callId) else { throw RelayError.invalidResponse }
            currentCall = call
            mode = call.relayMode
            try await callKit.startOutgoing(call: call, displayName: contacts.displayName(for: call.phoneNumber))
            try await beginMedia(for: call)
        } catch {
            errorMessage = error.localizedDescription
            if let failedId = currentCall?.id ?? createdCallId {
                try? await api.sendEvent(callId: failedId, type: "failed", code: "ios_outgoing_setup_failed")
                callKit.reportEnded(callId: failedId, reason: .failed)
            }
            resetMedia()
            currentCall = nil
        }
    }

    func endCurrentCall() async {
        guard let call = currentCall else { return }
        do { try await callKit.requestEnd(callId: call.id) }
        catch {
            await sendMediaSummary(callId: call.id)
            try? await api.sendEvent(callId: call.id, type: "end")
            finishLocalCall(reason: .remoteEnded)
        }
    }

    func setMode(_ next: RelayMode) async {
        guard let call = currentCall else { return }
        do {
            try await api.sendEvent(callId: call.id, type: next.rawValue)
            mode = next
            media.setMode(next)
        } catch { errorMessage = error.localizedDescription }
    }

    func toggleMute() async {
        guard let call = currentCall else { return }
        do { try await callKit.requestMute(callId: call.id, muted: !isMuted) }
        catch { errorMessage = error.localizedDescription }
    }

    func setAudioOutput(_ output: AudioSessionController.Output) {
        do { try audio.select(output) }
        catch { errorMessage = error.localizedDescription }
    }

    func sendDTMF(_ digit: String) async {
        guard let call = currentCall, digit.range(of: #"^[0-9*#]$"#, options: .regularExpression) != nil else { return }
        do { try await callKit.requestDTMF(callId: call.id, digit: digit) }
        catch { errorMessage = error.localizedDescription }
    }

    private func wireCallbacks() {
        signal.onCallSnapshot = { [weak self] call in Task { @MainActor in await self?.apply(call) } }
        signal.onEnvelope = { [weak self] type, payload, callId, negotiationId in
            Task { @MainActor in await self?.handleSignal(type, payload: payload, callId: callId, negotiationId: negotiationId) }
        }
        signal.onConnected = { [weak self] in Task { @MainActor in await self?.recoverAuthoritativeCall() } }
        signal.onPairingRevoked = { [weak self] pairingId, reason in
            Task { @MainActor in
                self?.errorMessage = reason
                self?.finishLocalCall(reason: .failed)
                self?.onPairingRevoked?(pairingId, reason)
            }
        }
        media.onLocalCandidate = { [weak self] candidate in
            guard let self, let call = self.currentCall, self.mediaCallId == call.id else { return }
            let generation = self.mediaGeneration
            let negotiationId = self.currentNegotiationId
            Task { @MainActor [weak self] in
                guard let self, self.mediaGeneration == generation, self.currentCall?.id == call.id,
                      self.currentNegotiationId == negotiationId else { return }
                try? await self.signal.send(
                    type: "ice_candidates",
                    callId: call.id,
                    payload: ["candidates": [[
                        "candidate": candidate.candidate,
                        "sdpMid": candidate.sdpMid ?? "0",
                        "sdpMLineIndex": candidate.sdpMLineIndex
                    ]]],
                    negotiationId: negotiationId
                )
            }
        }
        media.onICEGatheringComplete = { [weak self] in
            guard let self, let call = self.currentCall, self.mediaCallId == call.id else { return }
            let generation = self.mediaGeneration
            let negotiationId = self.currentNegotiationId
            Task { @MainActor [weak self] in
                guard let self, self.mediaGeneration == generation, self.currentCall?.id == call.id,
                      self.currentNegotiationId == negotiationId else { return }
                try? await self.signal.send(
                    type: "ice_complete",
                    callId: call.id,
                    payload: [:],
                    negotiationId: negotiationId
                )
            }
        }
        media.onStateChange = { [weak self] state, detail in
            guard let self, let callId = self.mediaCallId else { return }
            let generation = self.mediaGeneration
            Task { @MainActor [weak self] in
                guard let self, self.mediaGeneration == generation,
                      self.mediaCallId == callId, self.currentCall?.id == callId else { return }
                await self.mediaChanged(state, detail: detail)
            }
        }
        callKit.onAnswer = { [weak self] action in Task { @MainActor in await self?.answer(action) } }
        callKit.onEnd = { [weak self] action in Task { @MainActor in await self?.end(action) } }
        callKit.onMute = { [weak self] action in Task { @MainActor in await self?.mute(action) } }
        callKit.onDTMF = { [weak self] action in Task { @MainActor in await self?.dtmf(action) } }
        callKit.onPrepareAudio = { [weak self] in
            guard let self else { throw RelayError.media("The call coordinator is unavailable.") }
            try self.audio.configureForCall()
        }
        callKit.onAudioPreparationFailed = { [weak self] message in
            Task { @MainActor in await self?.failMedia("iPhone audio setup failed: \(message)") }
        }
        callKit.onAudioActivated = { [weak self] active in
            guard let self else { return }
            // Only real CallKit callbacks change external activation. Media
            // recovery/teardown must not synthesize these notifications.
            self.media.setAudioActive(active)
            self.audio.refreshRoutes()
        }
        callKit.onProviderReset = { [weak self] in
            Task { @MainActor in
                guard let self, self.currentCall != nil else { return }
                await self.failMedia("CallKit reset the active system call.")
            }
        }
    }

    private var currentNegotiationId: String?

    private func apply(_ call: RelayCall) async {
        if let existing = currentCall, existing.id == call.id, existing.version > call.version { return }
        if call.recipientStatus == .answeredElsewhere {
            currentCall = call
            finishLocalCall(reason: .answeredElsewhere, outcome: "Answered elsewhere")
            return
        }
        if call.recipientStatus == .declined || call.recipientStatus == .missed {
            currentCall = call
            finishLocalCall(reason: .unanswered, outcome: call.recipientStatus == .missed ? "Missed" : "Declined")
            return
        }
        if call.state.isClosingOrTerminal {
            currentCall = call
            finishLocalCall(reason: call.state == .failed ? .failed : .remoteEnded)
            return
        }

        currentCall = call
        mode = call.relayMode
        media.setMode(mode)
        if call.state == .active, activeSince == nil { activeSince = Date() }

        switch call.callKitRecoveryAction(hasSession: callKit.hasCall(call.id)) {
        case .reportIncomingAndWaitForAnswer:
            incomingAwaitingUserAnswer.insert(call.id)
            do {
                try await callKit.reportIncoming(call: call, displayName: contacts.displayName(for: call.phoneNumber))
            } catch {
                incomingAwaitingUserAnswer.remove(call.id)
                errorMessage = "CallKit could not present the incoming call: \(error.localizedDescription)"
                if call.recipientStatus == .ringing {
                    try? await api.sendEvent(callId: call.id, type: "reject")
                } else {
                    await failMedia("The recovered call could not be restored in CallKit.")
                }
            }
            return
        case .restartOutgoingSession:
            do {
                try await callKit.startOutgoing(call: call, displayName: contacts.displayName(for: call.phoneNumber))
            } catch {
                await failMedia("The recovered outgoing call could not be restored in CallKit: \(error.localizedDescription)")
                return
            }
        case .none:
            return
        case .useExistingSession:
            break
        }

        if incomingAwaitingUserAnswer.contains(call.id), !acceptedLocallyCallIds.contains(call.id) { return }
        if (call.recipientStatus == .selected || call.direction == .outgoing), mediaCallId != call.id {
            do { try await beginMedia(for: call) }
            catch { await failMedia(error.localizedDescription) }
        }
    }

    private func answer(_ action: CXAnswerCallAction) async {
        guard let callId = callKit.callId(for: action), currentCall?.id == callId else { action.fail(); return }
        guard await AudioSessionController.ensureMicrophonePermission() else {
            if currentCall?.recipientStatus == .ringing {
                try? await api.sendEvent(callId: callId, type: "reject")
            } else {
                try? await api.sendEvent(callId: callId, type: "failed", code: "ios_microphone_denied")
            }
            action.fail()
            finishLocalCall(reason: .unanswered, outcome: "Declined – microphone unavailable")
            errorMessage = "Enable Microphone access for Call Relay in iPhone Settings."
            return
        }
        do {
            try await api.sendEvent(callId: callId, type: "accept")
            acceptedLocallyCallIds.insert(callId)
            incomingAwaitingUserAnswer.remove(callId)
            action.fulfill()
            await recoverAuthoritativeCall()
        } catch RelayError.callClaimed {
            action.fail()
            finishLocalCall(reason: .answeredElsewhere, outcome: "Answered elsewhere")
        } catch {
            action.fail()
            errorMessage = error.localizedDescription
            finishLocalCall(reason: .failed)
        }
    }

    private func end(_ action: CXEndCallAction) async {
        let callId = callKit.callId(for: action)
        if let callId {
            let isUnansweredIncoming = currentCall?.id == callId && currentCall?.direction == .incoming &&
                currentCall?.recipientStatus == .ringing && !acceptedLocallyCallIds.contains(callId)
            if !isUnansweredIncoming { await sendMediaSummary(callId: callId) }
            try? await api.sendEvent(callId: callId, type: isUnansweredIncoming ? "reject" : "end")
        }
        action.fulfill()
        finishLocalCall(reason: .remoteEnded)
    }

    private func mute(_ action: CXSetMutedCallAction) async {
        guard let callId = callKit.callId(for: action) else { action.fail(); return }
        do {
            try await api.sendEvent(callId: callId, type: "mute", payload: ["muted": action.isMuted])
            isMuted = action.isMuted
            media.setMuted(action.isMuted)
            action.fulfill()
        } catch { action.fail(); errorMessage = error.localizedDescription }
    }

    private func dtmf(_ action: CXPlayDTMFCallAction) async {
        guard let callId = callKit.callId(for: action), action.digits.count == 1 else { action.fail(); return }
        do {
            try await api.sendEvent(callId: callId, type: "dtmf", payload: ["digit": action.digits])
            action.fulfill()
        } catch { action.fail(); errorMessage = error.localizedDescription }
    }

    private func beginMedia(for call: RelayCall) async throws {
        guard mediaCallId != call.id else { return }
        resetMedia(clearPendingSignals: false)
        pendingOffers = pendingOffers.filter { $0.key == call.id }
        pendingCandidates = pendingCandidates.filter { $0.key.hasPrefix("\(call.id)|") }
        mediaCallId = call.id
        let generation = mediaGeneration
        mediaState = .preparing
        let configuration = try await api.mediaConfiguration(callId: call.id)
        guard mediaGeneration == generation, mediaCallId == call.id,
              currentCall?.id == call.id else { return }
        guard configuration.transport == "webrtc_p2p", configuration.offerer == "android", configuration.protocolVersion == 1 else {
            throw RelayError.media("The server returned an unsupported media configuration.")
        }
        try media.prepare(configuration: configuration, relayOnly: false)
        media.setMode(mode)
        media.setMuted(isMuted)
        mediaPreparedCallId = call.id
        scheduleDeadlines(call: call, configuration: configuration)
        if let pending = pendingOffers.removeValue(forKey: call.id) {
            await processOffer(
                pending.payload,
                callId: call.id,
                negotiationId: pending.negotiationId
            )
        }
    }

    private func scheduleDeadlines(call: RelayCall, configuration: ICEConfiguration) {
        directDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(8))
            guard !Task.isCancelled, let self, self.currentCall?.id == call.id, self.mediaState != .connected else { return }
            await self.switchToRelay(call: call, configuration: configuration, reason: "direct_timeout")
        }
        setupDeadline = Task { [weak self] in
            try? await Task.sleep(for: .seconds(20))
            guard !Task.isCancelled, let self, self.currentCall?.id == call.id, self.mediaState != .connected else { return }
            await self.failMedia("Audio could not connect within 20 seconds.")
        }
        let refreshIn = max(30, TimeInterval(configuration.credentialsExpiresAt) / 1_000 - Date().timeIntervalSince1970 - 60)
        credentialRefresh = Task { [weak self] in
            try? await Task.sleep(for: .seconds(refreshIn))
            guard !Task.isCancelled, let self, self.currentCall?.id == call.id else { return }
            if let refreshed = try? await self.api.mediaConfiguration(callId: call.id), self.didForceRelay {
                try? self.media.forceRelay(configuration: refreshed)
            }
        }
    }

    private func startNetworkMonitoring() {
        networkMonitor.pathUpdateHandler = { [weak self] path in
            let satisfied = path.status == .satisfied
            let signature = [
                satisfied ? "online" : "offline",
                path.usesInterfaceType(.wifi) ? "wifi" : "",
                path.usesInterfaceType(.cellular) ? "cellular" : "",
                path.usesInterfaceType(.wiredEthernet) ? "wired" : "",
                path.isExpensive ? "expensive" : "",
                path.isConstrained ? "constrained" : ""
            ].joined(separator: "|")
            Task { @MainActor in
                await self?.networkPathChanged(satisfied: satisfied, signature: signature)
            }
        }
        networkMonitor.start(queue: networkQueue)
    }

    private func networkPathChanged(satisfied: Bool, signature: String) async {
        guard let previous = lastNetworkSignature else {
            lastNetworkSignature = signature
            networkWasSatisfied = satisfied
            return
        }
        let wasSatisfied = networkWasSatisfied
        lastNetworkSignature = signature
        networkWasSatisfied = satisfied
        guard satisfied, signature != previous,
              let call = currentCall,
              call.recipientStatus == .selected || call.direction == .outgoing,
              mediaPreparedCallId == call.id,
              mediaState == .connected || mediaState == .disconnected else { return }

        let reason = wasSatisfied ? "network_change" : "network_online"
        networkRestartTask?.cancel()
        networkRestartTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard !Task.isCancelled, let self, self.currentCall?.id == call.id else { return }
            await self.restartAfterNetworkChange(call: call, reason: reason)
        }
    }

    private func restartAfterNetworkChange(call: RelayCall, reason: String) async {
        do {
            let configuration = try await api.mediaConfiguration(callId: call.id)
            try await requestICERestart(
                call: call,
                configuration: configuration,
                reason: reason,
                forceRelay: didForceRelay
            )
        } catch {
            errorMessage = "Network recovery failed: \(error.localizedDescription)"
        }
    }

    private func switchToRelay(call: RelayCall, configuration: ICEConfiguration, reason: String) async {
        guard !didForceRelay else { return }
        do {
            try await requestICERestart(call: call, configuration: configuration, reason: reason, forceRelay: true)
        } catch { await failMedia(error.localizedDescription) }
    }

    private func requestICERestart(
        call: RelayCall,
        configuration: ICEConfiguration,
        reason: String,
        forceRelay: Bool
    ) async throws {
        guard currentCall?.id == call.id, mediaPreparedCallId == call.id else { return }
        if forceRelay {
            try media.forceRelay(configuration: configuration)
            didForceRelay = true
        }
        iceRestartCount += 1
        remoteDescriptionNegotiationId = nil
        currentNegotiationId = UUID().uuidString.lowercased()
        let policy = didForceRelay ? "relay" : "all"
        try await api.sendEvent(
            callId: call.id,
            type: "media_restarting",
            payload: ["reason": reason, "icePolicy": policy]
        )
        try await signal.send(
            type: "offer_request",
            callId: call.id,
            payload: ["iceRestart": true, "icePolicy": policy],
            negotiationId: currentNegotiationId
        )
    }

    private func handleSignal(_ type: String, payload: [String: Any], callId: String, negotiationId: String?) async {
        // SignalClient authenticates and binds every envelope to its authoritative
        // call snapshot. Coordinator snapshot delivery is asynchronous, so retain
        // an early offer/candidate until apply(_:) finishes preparing media.
        if currentCall?.id != callId {
            if type == "offer" {
                pendingOffers[callId] = (payload, negotiationId)
            } else if type == "ice_candidates" {
                do { try queueOrApplyCandidates(payload, callId: callId, negotiationId: negotiationId) }
                catch { errorMessage = error.localizedDescription }
            }
            return
        }
        do {
            switch type {
            case "offer":
                guard mediaPreparedCallId == callId, !offerInFlight else {
                    pendingOffers[callId] = (payload, negotiationId)
                    return
                }
                await processOffer(payload, callId: callId, negotiationId: negotiationId)
            case "ice_candidates":
                try queueOrApplyCandidates(payload, callId: callId, negotiationId: negotiationId)
            case "ice_complete", "media_ready": break
            case "ice_restart_request":
                guard let call = currentCall else { return }
                let config = try await api.mediaConfiguration(callId: call.id)
                await switchToRelay(call: call, configuration: config, reason: "peer_request")
            case "media_failed":
                await failMedia(payload["reason"] as? String ?? "Android media failed.")
            default: break
            }
        } catch { await failMedia(error.localizedDescription) }
    }

    private func processOffer(
        _ payload: [String: Any],
        callId: String,
        negotiationId: String?
    ) async {
        guard mediaPreparedCallId == callId else {
            pendingOffers[callId] = (payload, negotiationId)
            return
        }
        guard let sdp = payload["sdp"] as? String else {
            await failMedia("Android sent an invalid media offer.")
            return
        }
        offerInFlight = true
        let generation = mediaGeneration
        currentNegotiationId = negotiationId
        remoteDescriptionNegotiationId = nil
        do {
            let answer = try await media.answer(offerSDP: sdp)
            guard mediaGeneration == generation, currentCall?.id == callId,
                  currentNegotiationId == negotiationId else { return }
            remoteDescriptionNegotiationId = negotiationId ?? "legacy"
            let key = candidateKey(callId: callId, negotiationId: negotiationId)
            for candidate in pendingCandidates.removeValue(forKey: key) ?? [] {
                try media.addRemoteCandidate(candidate)
            }
            try await signal.send(type: "answer", callId: callId, payload: ["sdp": answer], negotiationId: negotiationId)
        } catch {
            guard mediaGeneration == generation, currentCall?.id == callId else { return }
            offerInFlight = false
            await failMedia(error.localizedDescription)
            return
        }
        guard mediaGeneration == generation, currentCall?.id == callId else { return }
        offerInFlight = false
        if let next = pendingOffers.removeValue(forKey: callId) {
            await processOffer(next.payload, callId: callId, negotiationId: next.negotiationId)
        }
    }

    private func candidateKey(callId: String, negotiationId: String?) -> String {
        "\(callId)|\(negotiationId ?? "legacy")"
    }

    private func queueOrApplyCandidates(
        _ payload: [String: Any],
        callId: String,
        negotiationId: String?
    ) throws {
        guard let candidates = payload["candidates"] as? [[String: Any]], candidates.count <= 128 else {
            throw RelayError.invalidResponse
        }
        let key = candidateKey(callId: callId, negotiationId: negotiationId)
        for value in candidates {
            guard let candidate = value["candidate"] as? String,
                  let line = (value["sdpMLineIndex"] as? NSNumber)?.int32Value else { continue }
            let parsed = LocalICECandidate(
                candidate: candidate,
                sdpMid: value["sdpMid"] as? String,
                sdpMLineIndex: line
            )
            if mediaPreparedCallId == callId,
               remoteDescriptionNegotiationId == (negotiationId ?? "legacy") {
                try media.addRemoteCandidate(parsed)
            } else {
                pendingCandidates[key, default: []].append(parsed)
            }
        }
    }

    private func mediaChanged(_ state: MediaConnectionState, detail: String?) async {
        mediaState = state
        connectionDetail = detail
        guard let call = currentCall else { return }
        switch state {
        case .connected:
            directDeadline?.cancel()
            setupDeadline?.cancel()
            if activeSince == nil { activeSince = Date() }
            startStatsPolling(callId: call.id)
            if call.direction == .outgoing { callKit.reportConnected(callId: call.id) }
            try? await signal.send(
                type: "media_ready",
                callId: call.id,
                payload: ["icePolicy": didForceRelay ? "relay" : "all"],
                negotiationId: currentNegotiationId
            )
            try? await api.sendEvent(
                callId: call.id,
                type: "media_connected",
                payload: ["candidateType": detail ?? "host", "icePolicy": didForceRelay ? "relay" : "all"]
            )
        case .failed:
            if !didForceRelay, let call = currentCall, let config = try? await api.mediaConfiguration(callId: call.id) {
                await switchToRelay(call: call, configuration: config, reason: "ice_failed")
            } else { await failMedia(detail ?? "WebRTC failed.") }
        default: break
        }
    }

    private func startStatsPolling(callId: String) {
        guard statsTask == nil else { return }
        statsTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, let self, self.currentCall?.id == callId else { return }
                guard let statistics = await self.media.statistics() else { continue }
                await self.receiveStatistics(statistics, callId: callId)
            }
        }
    }

    private func receiveStatistics(_ statistics: MediaStatistics, callId: String) async {
        guard currentCall?.id == callId else { return }
        let previous = previousStatistics
        let lostDelta = max(0, statistics.packetsLost - (previous?.packetsLost ?? 0))
        let receivedDelta = max(0, statistics.packetsReceived - (previous?.packetsReceived ?? 0))
        let packetTotal = lostDelta + receivedDelta
        let loss = packetTotal > 0 ? Double(lostDelta) / Double(packetTotal) : 0

        previousStatistics = statistics
        mediaStatistics = statistics
        packetLossPercent = loss * 100
        mediaQuality = Self.quality(
            rttMs: statistics.rttMs,
            jitterMs: statistics.jitterMs,
            loss: loss,
            hasTraffic: statistics.bytesSent > 0 || statistics.bytesReceived > 0
        )
        if ["host", "srflx", "relay"].contains(statistics.candidateType),
           connectionDetail != statistics.candidateType {
            let priorPath = connectionDetail
            connectionDetail = statistics.candidateType
            if ["host", "srflx", "relay"].contains(priorPath ?? "") {
                try? await api.sendEvent(
                    callId: callId,
                    type: "media_path_changed",
                    payload: [
                        "candidateType": statistics.candidateType,
                        "icePolicy": didForceRelay ? "relay" : "all"
                    ]
                )
            }
        }
        statsEmissionCounter += 1
        if statsEmissionCounter % 5 == 0 { await sendMediaSummary(callId: callId) }
    }

    private static func quality(rttMs: Double, jitterMs: Double, loss: Double, hasTraffic: Bool) -> MediaQuality {
        guard hasTraffic else { return .unknown }
        if rttMs > 500 || jitterMs > 80 || loss > 0.08 { return .poor }
        if rttMs > 250 || jitterMs > 40 || loss > 0.03 { return .fair }
        if rttMs > 120 || jitterMs > 20 || loss > 0.01 { return .good }
        return .excellent
    }

    private func sendMediaSummary(callId: String) async {
        guard let statistics = mediaStatistics else { return }
        var payload = statistics.eventPayload
        payload["iceRestartCount"] = iceRestartCount
        try? await api.sendEvent(callId: callId, type: "media_summary", payload: payload)
    }

    private func failMedia(_ reason: String) async {
        errorMessage = reason
        if let call = currentCall {
            await sendMediaSummary(callId: call.id)
            try? await signal.send(type: "media_failed", callId: call.id, payload: ["reason": "ios_media_failed"])
            try? await api.sendEvent(callId: call.id, type: "failed", code: "ios_media_failed")
            finishLocalCall(reason: .failed, outcome: "Failed")
        }
    }

    private func finishLocalCall(reason: CXCallEndedReason, outcome: String? = nil) {
        guard let call = currentCall else {
            resetMedia()
            return
        }
        let duration = activeSince.map { Date().timeIntervalSince($0) } ?? 0
        if !recordedCallIds.contains(call.id) {
            recordedCallIds.insert(call.id)
            let defaultOutcome = call.direction == .incoming && activeSince == nil ? "Missed" : (call.state == .failed ? "Failed" : "Completed")
            history.record(
                call: call,
                contactName: contacts.displayName(for: call.phoneNumber),
                outcome: outcome ?? defaultOutcome,
                duration: duration
            )
        }
        callKit.reportEnded(callId: call.id, reason: reason)
        acceptedLocallyCallIds.remove(call.id)
        incomingAwaitingUserAnswer.remove(call.id)
        resetMedia()
        currentCall = nil
        activeSince = nil
        isMuted = false
        showingDTMF = false
    }

    private func resetMedia(clearPendingSignals: Bool = true) {
        mediaGeneration &+= 1
        mediaCallId = nil
        directDeadline?.cancel()
        setupDeadline?.cancel()
        credentialRefresh?.cancel()
        statsTask?.cancel()
        networkRestartTask?.cancel()
        directDeadline = nil
        setupDeadline = nil
        credentialRefresh = nil
        statsTask = nil
        networkRestartTask = nil
        media.close()
        mediaCallId = nil
        mediaState = .idle
        connectionDetail = nil
        mediaQuality = .unknown
        mediaStatistics = nil
        packetLossPercent = nil
        previousStatistics = nil
        statsEmissionCounter = 0
        currentNegotiationId = nil
        remoteDescriptionNegotiationId = nil
        mediaPreparedCallId = nil
        offerInFlight = false
        didForceRelay = false
        iceRestartCount = 0
        if clearPendingSignals {
            pendingOffers.removeAll(keepingCapacity: true)
            pendingCandidates.removeAll(keepingCapacity: true)
        }
        if clearPendingSignals {
            isMuted = false
            media.setMuted(false)
        }
    }
}
