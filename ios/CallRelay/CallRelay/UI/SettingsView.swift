import AVFoundation
import Contacts
import SwiftUI
import UIKit

struct SettingsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var pairing: PairingService
    @ObservedObject private var signal: SignalClient
    @ObservedObject private var audio: AudioSessionController
    @Environment(\.openURL) private var openURL
    @State private var errorMessage: String?
    @State private var confirmingRemoval = false
    @State private var showingDiagnostics = false
    @State private var permissionRevision = 0

    init(model: AppModel) {
        self.model = model
        pairing = model.pairing
        signal = model.calls.signal
        audio = model.calls.audio
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Account") {
                    LabeledContent("Google account", value: pairing.account?.account.email ?? model.auth.user?.email ?? "Signed in")
                    LabeledContent("Access", value: pairing.account?.subscription.active == true ? "Active" : "Check required")
                    Button("Sign Out", role: .destructive) { model.signOut() }
                }

                Section("Relay devices") {
                    if let devices = pairing.account?.devices {
                        ForEach(devices) { device in
                            DeviceStatusRow(device: device, localDeviceId: model.api.deviceId, socketState: signal.state.rawValue)
                        }
                    } else {
                        ProgressView("Loading devices…")
                    }
                }

                Section("Pairing") {
                    if let active = pairing.activePairing {
                        LabeledContent("Status", value: "Encrypted and confirmed")
                        LabeledContent("Pairing", value: String(active.id.suffix(8)))
                        LabeledContent("Android", value: String(active.androidDeviceId.suffix(8)))
                    }
                    Button("Remove This iPhone", role: .destructive) { confirmingRemoval = true }
                }

                Section("Permissions") {
                    PermissionRow(title: "Microphone", value: microphoneStatus).id(permissionRevision)
                    PermissionRow(title: "Contacts", value: contactsStatus)
                    if AVAudioApplication.shared.recordPermission == .undetermined {
                        Button("Allow Microphone") {
                            AVAudioApplication.requestRecordPermission { _ in
                                DispatchQueue.main.async { permissionRevision += 1 }
                            }
                        }
                    }
                    if CNContactStore.authorizationStatus(for: .contacts) == .notDetermined {
                        Button("Allow Contacts") { Task { await model.contacts.requestAndLoad() } }
                    }
                    Button("Review iPhone Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                    }
                }

                Section("Audio") {
                    Picker("Output", selection: Binding(
                        get: { audio.output },
                        set: { model.calls.setAudioOutput($0) }
                    )) {
                        ForEach(AudioSessionController.Output.allCases) { output in Text(output.rawValue).tag(output) }
                    }
                    Text("Bluetooth appears after a headset with call audio is connected.")
                        .font(.caption).foregroundStyle(.secondary)
                }

                Section("Connection") {
                    LabeledContent("Environment", value: AppConfiguration.current.environmentName)
                    LabeledContent("Secure socket", value: signal.state.rawValue)
                    LabeledContent("Android online", value: signal.androidOnline ? "Yes" : "No")
                    Button("Refresh status") {
                        Task {
                            await pairing.refreshAccount()
                            await model.calls.recoverAuthoritativeCall()
                        }
                    }
                    Button("Diagnostics") { showingDiagnostics = true }
                }

                Section {
                    Text("With a free Personal Team, incoming calls ring only while Call Relay is alive and connected. Active calls can continue while locked. Reinstall from Xcode when the development profile expires.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Settings")
            .refreshable { await pairing.refreshAccount() }
        }
        .confirmationDialog("Remove this iPhone from Call Relay?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
            Button("Remove This iPhone", role: .destructive) {
                Task {
                    do { try await model.removeThisIPhone() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
        } message: {
            Text("The encrypted pairing will be revoked. Pair again with a new QR to use calling.")
        }
        .sheet(isPresented: $showingDiagnostics) {
            DiagnosticsView(model: model)
        }
        .callError($errorMessage)
    }

    private var microphoneStatus: String {
        switch AVAudioApplication.shared.recordPermission {
        case .granted: "Allowed"
        case .denied: "Denied"
        case .undetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }

    private var contactsStatus: String {
        switch CNContactStore.authorizationStatus(for: .contacts) {
        case .authorized: "Allowed"
        case .denied: "Denied"
        case .restricted: "Restricted"
        case .notDetermined: "Not requested"
        @unknown default: "Unknown"
        }
    }
}

private struct PermissionRow: View {
    let title: String
    let value: String
    var body: some View {
        LabeledContent(title) {
            Label(value, systemImage: value == "Allowed" ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(value == "Allowed" ? .green : .secondary)
        }
    }
}

private struct DeviceStatusRow: View {
    let device: AccountSnapshot.Device
    let localDeviceId: String?
    let socketState: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: symbol).font(.title3).frame(width: 26).foregroundStyle(isReady ? .green : .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(device.displayName)
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Circle().fill(isReady ? .green : .gray).frame(width: 9, height: 9)
        }
    }

    private var symbol: String {
        switch device.platform {
        case "android": "apps.iphone"
        case "browser": "safari"
        case "ios": "iphone"
        default: "questionmark.circle"
        }
    }
    private var isReady: Bool {
        if device.platform == "android" { return device.relayPresence?.relayReady == true && device.relayPresence?.heartbeatFresh == true }
        if device.id == localDeviceId { return socketState == "Connected" }
        return true
    }
    private var subtitle: String {
        if device.platform == "android" {
            return device.relayPresence?.relayReady == true ? "Android relay ready" : "Android relay unavailable"
        }
        if device.id == localDeviceId { return "This iPhone · \(socketState)" }
        return device.platform == "browser" ? "Browser/PWA peer" : "iPhone peer"
    }
}

private struct DiagnosticsView: View {
    @ObservedObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                row("Environment", AppConfiguration.current.environmentName)
                row("API host", AppConfiguration.current.apiBaseURL.host ?? "Unknown")
                row("iPhone device", model.api.deviceId.map { String($0.suffix(12)) } ?? "Not registered")
                row("Pairing", model.pairing.activePairing.map { String($0.id.suffix(12)) } ?? "Not paired")
                row("Signaling", model.calls.signal.state.rawValue)
                row("Android presence", model.calls.signal.androidOnline ? "Online" : "Offline")
                row("Call", model.calls.currentCall?.id ?? "None")
                row("Call state", model.calls.currentCall?.state.rawValue ?? "Idle")
                row("Media", model.calls.mediaState.rawValue)
                row("Path", model.calls.connectionDetail ?? "Not selected")
                row("Quality", model.calls.mediaQuality.rawValue)
                if let statistics = model.calls.mediaStatistics {
                    row("RTT / jitter", "\(Int(statistics.rttMs.rounded())) / \(Int(statistics.jitterMs.rounded())) ms")
                    row("Packet loss", String(format: "%.1f%%", model.calls.packetLossPercent ?? 0))
                }
                row("Last signal error", model.calls.signal.lastError ?? "None")
                row("Last call error", model.calls.errorMessage ?? "None")
            }
            .navigationTitle("Diagnostics")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func row(_ title: String, _ value: String) -> some View {
        LabeledContent(title, value: value)
    }
}
