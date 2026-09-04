import Contacts
import SwiftData
import SwiftUI
import UIKit

struct ContactsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var contacts: ContactsService
    @Query private var favorites: [FavoriteRecord]
    @Environment(\.modelContext) private var context
    @Environment(\.openURL) private var openURL
    @State private var errorMessage: String?

    init(model: AppModel) {
        self.model = model
        contacts = model.contacts
    }

    var body: some View {
        NavigationStack {
            Group {
                switch contacts.authorizationStatus {
                case .authorized, .limited:
                    if contacts.filtered.isEmpty {
                        ContentUnavailableView.search(text: contacts.searchText)
                    } else {
                        List(contacts.filtered) { contact in
                            HStack(spacing: 12) {
                                ContactAvatar(name: contact.displayName)
                                Button { Task { await call(contact) } } label: {
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(contact.displayName).foregroundStyle(.primary)
                                        Text("\(contact.label)  \(contact.phoneNumber)")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                }
                                Button { toggleFavorite(contact) } label: {
                                    Image(systemName: isFavorite(contact) ? "star.fill" : "star")
                                        .foregroundStyle(.yellow)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                case .denied, .restricted:
                    ContentUnavailableView {
                        Label("Contacts unavailable", systemImage: "person.crop.circle.badge.exclamationmark")
                    } description: {
                        Text("Contacts stay on this iPhone. Enable access to search names and numbers.")
                    } actions: {
                        Button("Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                default:
                    ContentUnavailableView {
                        Label("Use your contacts", systemImage: "person.2")
                    } description: {
                        Text("Call Relay never uploads your contacts.")
                    } actions: {
                        Button("Allow Contacts") { Task { await contacts.requestAndLoad() } }
                            .buttonStyle(.borderedProminent)
                    }
                }
            }
            .navigationTitle("Contacts")
            .searchable(text: $contacts.searchText, prompt: "Search")
            .refreshable { await contacts.requestAndLoad() }
        }
        .callError($errorMessage)
    }

    private func call(_ contact: ContactChoice) async {
        guard let number = contact.normalizedNumber else { errorMessage = "That contact number is incomplete."; return }
        do { try await model.placeCall(number) }
        catch { errorMessage = error.localizedDescription }
    }

    private func isFavorite(_ contact: ContactChoice) -> Bool {
        guard let number = contact.normalizedNumber else { return false }
        return favorites.contains { $0.phoneNumber == number }
    }

    private func toggleFavorite(_ contact: ContactChoice) {
        guard let number = contact.normalizedNumber else { errorMessage = "That contact number is incomplete."; return }
        if let existing = favorites.first(where: { $0.phoneNumber == number }) { context.delete(existing) }
        else {
            context.insert(FavoriteRecord(
                contactIdentifier: contact.contactIdentifier,
                displayName: contact.displayName,
                phoneNumber: number
            ))
        }
        try? context.save()
    }
}
