import SwiftUI

struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: AppModel
    @ObservedObject private var auth: AuthService
    @ObservedObject private var pairing: PairingService
    @ObservedObject private var calls: CallCoordinator

    init(model: AppModel) {
        self.model = model
        auth = model.auth
        pairing = model.pairing
        calls = model.calls
    }

    var body: some View {
        Group {
            if !auth.isConfigured {
                FirebaseSetupView(message: auth.errorMessage)
            } else if auth.user == nil {
                SignInView(auth: auth)
            } else if case .ready = pairing.status {
                PhoneTabsView(model: model)
            } else {
                PairingView(model: model)
            }
        }
        .tint(.green)
        .task(id: auth.user?.uid) { await model.authenticationChanged() }
        .onChange(of: scenePhase) { _, phase in
            guard phase == .active, auth.user != nil else { return }
            if let ready = pairing.activePairing { calls.activate(pairing: ready) }
            Task { await calls.recoverAuthoritativeCall() }
        }
        .fullScreenCover(isPresented: Binding(
            get: {
                guard let call = calls.currentCall else { return false }
                return call.direction == .outgoing || call.recipientStatus == .selected || call.state == .active
            },
            set: { _ in }
        )) {
            ActiveCallView(coordinator: calls, contacts: model.contacts)
        }
    }
}

private struct FirebaseSetupView: View {
    let message: String?
    var body: some View {
        ContentUnavailableView {
            Label("Firebase setup needed", systemImage: "wrench.and.screwdriver")
        } description: {
            Text(message ?? "Add GoogleService-Info.plist to the Call Relay target.")
        } actions: {
            Text("See ios/CallRelay/README.md")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

private struct SignInView: View {
    @ObservedObject var auth: AuthService

    var body: some View {
        VStack(spacing: 24) {
            Spacer()
            Image(systemName: "phone.connection.fill")
                .font(.system(size: 68, weight: .semibold))
                .foregroundStyle(.green)
                .accessibilityHidden(true)
            VStack(spacing: 8) {
                Text("Call Relay").font(.largeTitle.bold())
                Text("Use your Android number from this iPhone")
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            Button {
                Task { await auth.signInWithGoogle() }
            } label: {
                HStack {
                    Image(systemName: "person.crop.circle.badge.checkmark")
                    Text("Continue with Google").fontWeight(.semibold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 5)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(auth.isBusy)
            if let error = auth.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }
            Spacer()
            Text("Sign in with the same approved account used on Android.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .padding(28)
    }
}
