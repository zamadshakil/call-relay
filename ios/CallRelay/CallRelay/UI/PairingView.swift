import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var pairing: PairingService
    @State private var showingScanner = false
    @State private var confirmingReplacement = false
    @State private var errorMessage: String?

    init(model: AppModel) {
        self.model = model
        pairing = model.pairing
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 22) {
                Spacer()
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 68, weight: .medium))
                    .foregroundStyle(.green)
                VStack(spacing: 8) {
                    Text("Pair this iPhone").font(.title.bold())
                    Text("On Android, open Call Relay and display a new iPhone pairing QR. The QR is single-use and expires after five minutes.")
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                if case .pairing(let message) = pairing.status {
                    ProgressView(message).padding(.top, 8)
                } else {
                    Button {
                        showingScanner = true
                    } label: {
                        Label("Scan Android QR", systemImage: "camera.viewfinder")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(pairing.isBusy)
                }
                if case .unavailable(let message) = pairing.status {
                    Text(message).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                    Button("Retry registration") { Task { await model.retrySetup() } }
                    if pairing.canReplaceExistingIPhone {
                        Button("Replace old iPhone registration", role: .destructive) {
                            confirmingReplacement = true
                        }
                    }
                }
                Spacer()
                VStack(spacing: 4) {
                    Text(model.auth.user?.email ?? "")
                    Text("Incoming CallKit ringing requires this app to remain running and connected. No paid Apple membership is required for development installation.")
                }
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            }
            .padding(28)
            .navigationTitle("Call Relay")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Sign out") { model.signOut() }
                }
            }
        }
        .sheet(isPresented: $showingScanner) {
            NavigationStack {
                QRCodeScannerView { code in
                    showingScanner = false
                    Task {
                        do { try await model.pair(scannedValue: code) }
                        catch { errorMessage = error.localizedDescription }
                    }
                } onFailure: { message in
                    showingScanner = false
                    errorMessage = message
                }
                .ignoresSafeArea()
                .overlay(alignment: .center) {
                    RoundedRectangle(cornerRadius: 24)
                        .stroke(.white, lineWidth: 3)
                        .frame(width: 260, height: 260)
                        .shadow(radius: 4)
                }
                .navigationTitle("Scan pairing QR")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showingScanner = false }
                    }
                }
            }
        }
        .alert("Pairing failed", isPresented: Binding(
            get: { errorMessage != nil },
            set: { if !$0 { errorMessage = nil } }
        )) {
            Button("OK", role: .cancel) { errorMessage = nil }
        } message: { Text(errorMessage ?? "") }
        .confirmationDialog(
            "Replace the registered iPhone?",
            isPresented: $confirmingReplacement,
            titleVisibility: .visible
        ) {
            Button("Replace iPhone", role: .destructive) {
                Task {
                    do { try await model.replaceExistingIPhone() }
                    catch { errorMessage = error.localizedDescription }
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This revokes the old iPhone registration and its pairing. You will scan a new Android QR on this iPhone.")
        }
    }
}
