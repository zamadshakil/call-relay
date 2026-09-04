import Combine
import FirebaseAuth
import FirebaseCore
import Foundation
import GoogleSignIn
import UIKit

@MainActor
final class AuthService: ObservableObject {
    @Published private(set) var user: User?
    @Published private(set) var isConfigured = false
    @Published private(set) var isBusy = false
    @Published var errorMessage: String?

    private var listener: AuthStateDidChangeListenerHandle?

    init() {
        configureFirebase()
    }

    deinit {
        if let listener { Auth.auth().removeStateDidChangeListener(listener) }
    }

    func configureFirebase() {
        guard FirebaseApp.app() == nil else {
            configureGoogleSignIn(from: FirebaseApp.app()?.options)
            observeAuth()
            return
        }
        guard let path = Bundle.main.path(forResource: "GoogleService-Info", ofType: "plist"),
              let options = FirebaseOptions(contentsOfFile: path) else {
            errorMessage = "Add GoogleService-Info.plist to the iOS target before signing in."
            return
        }
        FirebaseApp.configure(options: options)
        configureGoogleSignIn(from: options)
        observeAuth()
    }

    private func configureGoogleSignIn(from options: FirebaseOptions?) {
        guard let clientID = options?.clientID, !clientID.isEmpty else {
            errorMessage = "Google Sign-In client ID is missing from GoogleService-Info.plist."
            return
        }
        GIDSignIn.sharedInstance.configuration = GIDConfiguration(clientID: clientID)
    }

    private func observeAuth() {
        guard !isConfigured else { return }
        isConfigured = true
        user = Auth.auth().currentUser
        listener = Auth.auth().addStateDidChangeListener { [weak self] _, user in
            Task { @MainActor in self?.user = user }
        }
    }

    func signInWithGoogle() async {
        guard isConfigured else { configureFirebase(); return }
        guard let presenter = Self.topViewController() else {
            errorMessage = "Unable to present Google sign-in."
            return
        }
        isBusy = true
        errorMessage = nil
        defer { isBusy = false }
        do {
            let result = try await GIDSignIn.sharedInstance.signIn(withPresenting: presenter)
            guard let idToken = result.user.idToken?.tokenString else {
                throw RelayError.authenticationRequired
            }
            let credential = GoogleAuthProvider.credential(
                withIDToken: idToken,
                accessToken: result.user.accessToken.tokenString
            )
            let authResult: AuthDataResult = try await withCheckedThrowingContinuation { continuation in
                Auth.auth().signIn(with: credential) { result, error in
                    if let error { continuation.resume(throwing: error) }
                    else if let result { continuation.resume(returning: result) }
                    else { continuation.resume(throwing: RelayError.invalidResponse) }
                }
            }
            guard authResult.user.isEmailVerified else {
                try? Auth.auth().signOut()
                throw RelayError.configuration("Use a verified Google email address.")
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func token(forceRefresh: Bool = false) async throws -> String {
        guard let user = Auth.auth().currentUser else { throw RelayError.authenticationRequired }
        return try await withCheckedThrowingContinuation { continuation in
            user.getIDTokenForcingRefresh(forceRefresh) { token, error in
                if let error { continuation.resume(throwing: error) }
                else if let token { continuation.resume(returning: token) }
                else { continuation.resume(throwing: RelayError.authenticationRequired) }
            }
        }
    }

    func signOut() {
        GIDSignIn.sharedInstance.signOut()
        do { try Auth.auth().signOut() }
        catch { errorMessage = error.localizedDescription }
    }

    func handleOpenURL(_ url: URL) -> Bool {
        GIDSignIn.sharedInstance.handle(url)
    }

    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .first { $0.activationState == .foregroundActive }
        var controller = scene?.windows.first(where: \.isKeyWindow)?.rootViewController
        while let presented = controller?.presentedViewController { controller = presented }
        return controller
    }
}
