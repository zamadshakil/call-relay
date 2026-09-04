import SwiftData
import SwiftUI

struct FavoritesView: View {
    @ObservedObject var model: AppModel
    @Query(sort: \FavoriteRecord.createdAt) private var favorites: [FavoriteRecord]
    @Environment(\.modelContext) private var context
    @State private var adding = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if favorites.isEmpty {
                    ContentUnavailableView(
                        "No Favorites",
                        systemImage: "star",
                        description: Text("Add a contact or number for one-tap relay calling.")
                    )
                } else {
                    List {
                        ForEach(favorites) { favorite in
                            Button {
                                Task { await place(favorite.phoneNumber) }
                            } label: {
                                HStack(spacing: 14) {
                                    ContactAvatar(name: favorite.displayName)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(favorite.displayName).foregroundStyle(.primary)
                                        Text(favorite.phoneNumber).font(.subheadline).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Image(systemName: "phone.fill").foregroundStyle(.green)
                                }
                            }
                            .swipeActions {
                                Button("Delete", role: .destructive) { context.delete(favorite); try? context.save() }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Favorites")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { adding = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .sheet(isPresented: $adding) {
            FavoriteEditor(contacts: model.contacts) { name, number, identifier in
                if !favorites.contains(where: { $0.phoneNumber == number }) {
                    context.insert(FavoriteRecord(contactIdentifier: identifier, displayName: name, phoneNumber: number))
                    try? context.save()
                }
                adding = false
            }
        }
        .callError($errorMessage)
    }

    private func place(_ number: String) async {
        do { try await model.placeCall(number) }
        catch { errorMessage = error.localizedDescription }
    }
}

private struct FavoriteEditor: View {
    @ObservedObject var contacts: ContactsService
    let onSave: (String, String, String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var number = ""
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section("Enter a number") {
                    TextField("Name", text: $name)
                    TextField("Phone number", text: $number).keyboardType(.phonePad)
                    Button("Add favorite") { saveManual() }
                        .disabled(number.isEmpty)
                }
                if !contacts.contacts.isEmpty {
                    Section("Choose a contact") {
                        ForEach(contacts.contacts) { contact in
                            Button {
                                guard let number = contact.normalizedNumber else {
                                    errorMessage = "That contact number is incomplete."
                                    return
                                }
                                onSave(contact.displayName, number, contact.contactIdentifier)
                            } label: {
                                VStack(alignment: .leading) {
                                    Text(contact.displayName).foregroundStyle(.primary)
                                    Text("\(contact.label)  \(contact.phoneNumber)").font(.caption).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Add Favorite")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .callError($errorMessage)
    }

    private func saveManual() {
        do {
            let normalized = try PhoneNumberPolicy().normalize(number)
            onSave(name.trimmingCharacters(in: .whitespaces).isEmpty ? normalized : name, normalized, nil)
        } catch { errorMessage = error.localizedDescription }
    }
}

struct ContactAvatar: View {
    let name: String
    var body: some View {
        Circle()
            .fill(Color(.secondarySystemFill))
            .frame(width: 44, height: 44)
            .overlay(Text(String(name.prefix(1)).uppercased()).font(.headline).foregroundStyle(.secondary))
            .accessibilityHidden(true)
    }
}
