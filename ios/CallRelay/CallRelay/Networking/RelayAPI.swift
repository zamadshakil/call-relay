import Foundation
import UIKit

final class RelayAPI: @unchecked Sendable {
    private let configuration: AppConfiguration
    private let identity: DeviceIdentity
    private let auth: AuthService
    private let keychain: KeychainStore
    private let session: URLSession

    init(
        configuration: AppConfiguration = .current,
        identity: DeviceIdentity = .shared,
        auth: AuthService,
        keychain: KeychainStore = .shared,
        session: URLSession = .shared
    ) {
        self.configuration = configuration
        self.identity = identity
        self.auth = auth
        self.keychain = keychain
        self.session = session
    }

    var deviceId: String? { try? keychain.string(for: "device-id-v2") }

    func registerThisIPhone(replaceExisting: Bool = false) async throws -> DeviceRegistration {
        let name = await UIDevice.current.name
        let body: [String: Any] = [
            "platform": "ios",
            "displayName": name,
            "publicKeySpki": identity.signingPublicKeySPKI,
            "agreementPublicKeyRaw": identity.agreementPublicKeyRaw,
            "appVersion": configuration.appVersion,
            "replaceExisting": replaceExisting
        ]
        let response: DeviceRegistration = try await bearer("POST", "/v1/devices/register", json: body)
        try keychain.set(response.deviceId, for: "device-id-v2")
        return response
    }

    func sessionSnapshot() async throws -> AccountSnapshot {
        try await bearer("POST", "/v1/auth/session", json: [:])
    }

    func accountSnapshot() async throws -> AccountSnapshot {
        try await bearer("GET", "/v1/me")
    }

    func pairings() async throws -> PairingsResponse {
        try await bearer("GET", "/v1/pairings/current")
    }

    func consume(_ invitation: PairingInvitation, secret: Data) async throws -> PairingConsumeResponse {
        guard let deviceId else { throw RelayError.deviceNotRegistered }
        let commitment = PairingCrypto.commitment(secret)
        let peerKey = identity.agreementPublicKeyRaw
        return try await bearer(
            "POST",
            "/v1/pairing-invitations/\(invitation.id)/consume",
            json: [
                "peerDeviceId": deviceId,
                "challengeHash": PairingCrypto.challengeHash(invitation.challenge),
                "peerPublicKeyRaw": peerKey,
                "commitment": commitment,
                "proof": PairingCrypto.peerProof(
                    secret: secret,
                    invitationId: invitation.id,
                    peerDeviceId: deviceId,
                    peerPublicKeyRaw: peerKey,
                    commitment: commitment
                )
            ]
        )
    }

    func revokeThisDevice() async throws {
        guard let deviceId else { return }
        let _: EmptyResponse = try await bearer("POST", "/v1/devices/\(deviceId)/revoke", json: [:])
        try keychain.remove("device-id-v2")
    }

    func currentCall() async throws -> RelayCall? {
        let response: CallResponse = try await signed("GET", "/v1/calls/current")
        return response.call
    }

    func call(id: String) async throws -> RelayCall? {
        let response: CallResponse = try await signed("GET", "/v1/calls/\(id)")
        return response.call
    }

    func createOutgoing(phoneNumber: String, pairingId: String) async throws -> CreatedCall {
        try await signed("POST", "/v1/calls/outgoing", json: [
            "requestId": UUID().uuidString.lowercased(),
            "pairingId": pairingId,
            "phoneNumber": phoneNumber
        ])
    }

    func sendEvent(
        callId: String,
        type: String,
        code: String? = nil,
        payload: [String: Any] = [:],
        commandId: UUID = UUID()
    ) async throws {
        var body: [String: Any] = [
            "type": type,
            "commandId": commandId.uuidString.lowercased()
        ]
        if let code { body["code"] = code }
        if !payload.isEmpty { body["payload"] = payload }
        do {
            let _: EmptyResponse = try await signed("POST", "/v1/calls/\(callId)/events", json: body)
        } catch RelayError.api(let status, let apiCode, _) where status == 409 && apiCode == "CALL_CLAIMED" {
            throw RelayError.callClaimed
        }
    }

    func mediaConfiguration(callId: String) async throws -> ICEConfiguration {
        try await signed("POST", "/v1/calls/\(callId)/media-config", json: [:])
    }

    func signalTicket(pairingId: String) async throws -> SignalTicket {
        try await signed("POST", "/v1/pairings/\(pairingId)/signal-ticket", json: [:])
    }

    private func bearer<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> T {
        var lastError: Error?
        for attempt in 0...1 {
            do {
                let token = try await auth.token(forceRefresh: attempt == 1)
                var request = try makeRequest(method: method, path: path, body: RelayRequestSigning.bodyData(json))
                request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                return try await execute(request)
            } catch RelayError.api(let status, _, _) where status == 401 && attempt == 0 {
                lastError = RelayError.authenticationRequired
            }
        }
        throw lastError ?? RelayError.authenticationRequired
    }

    private func signed<T: Decodable>(_ method: String, _ path: String, json: [String: Any]? = nil) async throws -> T {
        guard let deviceId, !deviceId.isEmpty else { throw RelayError.deviceNotRegistered }
        let body = RelayRequestSigning.bodyData(json)
        let timestamp = String(Int64(Date().timeIntervalSince1970 * 1_000))
        let nonce = UUID().uuidString.lowercased()
        let canonical = RelayRequestSigning.canonical(
            method: method,
            path: path,
            body: body,
            timestamp: timestamp,
            nonce: nonce
        )
        var request = try makeRequest(method: method, path: path, body: body)
        request.setValue(deviceId, forHTTPHeaderField: "x-relay-device")
        request.setValue(timestamp, forHTTPHeaderField: "x-relay-timestamp")
        request.setValue(nonce, forHTTPHeaderField: "x-relay-nonce")
        request.setValue(try identity.sign(Data(canonical.utf8)), forHTTPHeaderField: "x-relay-signature")
        return try await execute(request)
    }

    private func makeRequest(method: String, path: String, body: Data) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: configuration.apiBaseURL)?.absoluteURL else {
            throw RelayError.configuration("Invalid API path.")
        }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("ios-native-\(configuration.appVersion)", forHTTPHeaderField: "x-relay-app-version")
        if method != "GET" && method != "HEAD" { request.httpBody = body }
        return request
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, rawResponse) = try await session.data(for: request)
        guard let response = rawResponse as? HTTPURLResponse else { throw RelayError.invalidResponse }
        guard (200..<300).contains(response.statusCode) else {
            let failure = (try? JSONDecoder().decode(APIErrorBody.self, from: data))
            throw RelayError.api(
                status: response.statusCode,
                code: failure?.code,
                message: failure?.error ?? "Call Relay request failed (\(response.statusCode))."
            )
        }
        if T.self == EmptyResponse.self, data.isEmpty || data == Data("{}".utf8) {
            return EmptyResponse() as! T
        }
        do { return try Self.decoder.decode(T.self, from: data) }
        catch { throw RelayError.invalidResponse }
    }

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }()
}

enum RelayRequestSigning {
    static func bodyData(_ value: [String: Any]?) -> Data {
        guard let value else { return Data() }
        return (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data("{}".utf8)
    }

    static func canonical(method: String, path: String, body: Data, timestamp: String, nonce: String) -> String {
        [method.uppercased(), path, body.sha256Hex, timestamp, nonce].joined(separator: "\n")
    }
}

struct PairingsResponse: Codable, Sendable {
    let pairing: AccountSnapshot.Pairing?
    let pairings: [AccountSnapshot.Pairing]?
}

private struct APIErrorBody: Codable { let error: String?; let code: String? }
struct EmptyResponse: Codable { init() {} }
