import Foundation
import PhoneNumberKit

struct PhoneNumberPolicy {
    private let utility = PhoneNumberUtility()

    func normalize(_ raw: String, region: String? = Locale.current.region?.identifier) throws -> String {
        let compact = raw.filter { !$0.isWhitespace && $0 != "-" && $0 != "(" && $0 != ")" }
        guard !compact.isEmpty else { throw RelayError.blockedNumber("Enter a phone number.") }
        if compact.contains("*") || compact.contains("#") || compact.contains(",") || compact.contains(";") {
            throw RelayError.blockedNumber("MMI, USSD, extension, and service codes cannot be relayed.")
        }
        let digits = compact.filter(\.isNumber)
        if Self.emergencyNumbers.contains(digits) {
            throw RelayError.blockedNumber("Emergency calls cannot be placed through Call Relay. Use this iPhone's cellular Phone app.")
        }
        do {
            let parsed = try utility.parse(compact, withRegion: region ?? "US", ignoreType: true)
            let e164 = utility.format(parsed, toType: .e164)
            guard e164.range(of: #"^\+[1-9][0-9]{7,14}$"#, options: .regularExpression) != nil else {
                throw RelayError.blockedNumber("Enter a complete international phone number.")
            }
            return e164
        } catch let relay as RelayError {
            throw relay
        } catch {
            throw RelayError.blockedNumber("That phone number is not valid for \(region ?? "your region").")
        }
    }

    static func isEmergencyOrServiceCode(_ raw: String) -> Bool {
        let compact = raw.filter { !$0.isWhitespace }
        return compact.contains("*") || compact.contains("#") || emergencyNumbers.contains(compact.filter(\.isNumber))
    }

    private static let emergencyNumbers: Set<String> = [
        "000", "08", "110", "112", "118", "119", "911", "999", "15", "17", "18"
    ]
}
