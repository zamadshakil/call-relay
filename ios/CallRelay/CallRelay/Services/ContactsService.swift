import Combine
import Contacts
import Foundation

struct ContactChoice: Identifiable, Hashable, Sendable {
    let id: String
    let contactIdentifier: String
    let displayName: String
    let label: String
    let phoneNumber: String
    let normalizedNumber: String?
}

@MainActor
final class ContactsService: ObservableObject {
    @Published private(set) var contacts: [ContactChoice] = []
    @Published private(set) var authorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
    @Published var searchText = ""
    @Published var errorMessage: String?

    private let store = CNContactStore()
    private let policy = PhoneNumberPolicy()

    var filtered: [ContactChoice] {
        guard !searchText.isEmpty else { return contacts }
        return contacts.filter {
            $0.displayName.localizedCaseInsensitiveContains(searchText) ||
            $0.phoneNumber.localizedCaseInsensitiveContains(searchText)
        }
    }

    func requestAndLoad() async {
        do {
            if authorizationStatus == .notDetermined {
                _ = try await store.requestAccess(for: .contacts)
            }
            authorizationStatus = CNContactStore.authorizationStatus(for: .contacts)
            guard authorizationStatus == .authorized else {
                contacts = []
                return
            }
            load()
        } catch { errorMessage = error.localizedDescription }
    }

    func displayName(for number: String?) -> String? {
        guard let number else { return nil }
        return contacts.first { $0.normalizedNumber == number }?.displayName
    }

    private func load() {
        let keys: [CNKeyDescriptor] = [
            CNContactIdentifierKey as CNKeyDescriptor,
            CNContactGivenNameKey as CNKeyDescriptor,
            CNContactFamilyNameKey as CNKeyDescriptor,
            CNContactOrganizationNameKey as CNKeyDescriptor,
            CNContactPhoneNumbersKey as CNKeyDescriptor
        ]
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.sortOrder = .userDefault
        var result: [ContactChoice] = []
        do {
            try store.enumerateContacts(with: request) { [policy] contact, _ in
                let personal = [contact.givenName, contact.familyName].filter { !$0.isEmpty }.joined(separator: " ")
                let name = personal.isEmpty ? contact.organizationName : personal
                for (index, number) in contact.phoneNumbers.enumerated() {
                    let raw = number.value.stringValue
                    result.append(ContactChoice(
                        id: "\(contact.identifier)-\(index)",
                        contactIdentifier: contact.identifier,
                        displayName: name.isEmpty ? raw : name,
                        label: CNLabeledValue<NSString>.localizedString(forLabel: number.label ?? "phone"),
                        phoneNumber: raw,
                        normalizedNumber: try? policy.normalize(raw)
                    ))
                }
            }
            contacts = result.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
