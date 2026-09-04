import Foundation

struct AppConfiguration: Sendable {
    let apiBaseURL: URL
    let environmentName: String
    let appVersion: Int

    static let current: AppConfiguration = {
        let dictionary = Bundle.main.infoDictionary ?? [:]
        let rawURL = dictionary["API_BASE_URL"] as? String ?? ""
        guard let url = URL(string: rawURL), url.scheme == "https", url.host != nil else {
            fatalError("API_BASE_URL must be a valid HTTPS URL in the active xcconfig")
        }
        let build = Int(dictionary["CFBundleVersion"] as? String ?? "1") ?? 1
        return AppConfiguration(
            apiBaseURL: url,
            environmentName: dictionary["CALL_RELAY_ENVIRONMENT"] as? String ?? "Unknown",
            appVersion: build
        )
    }()
}

enum RelayError: LocalizedError, Equatable {
    case configuration(String)
    case api(status: Int, code: String?, message: String)
    case invalidResponse
    case authenticationRequired
    case deviceNotRegistered
    case pairingRequired
    case pairingExpired
    case pairingProofInvalid
    case callClaimed
    case blockedNumber(String)
    case signaling(String)
    case media(String)

    var errorDescription: String? {
        switch self {
        case .configuration(let message), .signaling(let message), .media(let message): message
        case .api(_, _, let message): message
        case .invalidResponse: "Call Relay received an invalid server response."
        case .authenticationRequired: "Sign in with Google to continue."
        case .deviceNotRegistered: "This iPhone has not been registered."
        case .pairingRequired: "Pair this iPhone with the Android relay first."
        case .pairingExpired: "That pairing QR has expired. Generate a new one on Android."
        case .pairingProofInvalid: "The Android pairing proof could not be verified."
        case .callClaimed: "This call was answered on another device."
        case .blockedNumber(let reason): reason
        }
    }
}
