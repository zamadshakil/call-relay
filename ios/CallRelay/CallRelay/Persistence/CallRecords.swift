import Foundation
import SwiftData

@Model
final class RecentCallRecord {
    @Attribute(.unique) var id: UUID
    var relayCallId: String
    var phoneNumber: String?
    var contactName: String?
    var directionRaw: String
    var outcome: String
    var startedAt: Date
    var durationSeconds: Int

    init(
        relayCallId: String,
        phoneNumber: String?,
        contactName: String?,
        direction: CallDirection,
        outcome: String,
        startedAt: Date,
        durationSeconds: Int
    ) {
        id = UUID()
        self.relayCallId = relayCallId
        self.phoneNumber = phoneNumber
        self.contactName = contactName
        directionRaw = direction.rawValue
        self.outcome = outcome
        self.startedAt = startedAt
        self.durationSeconds = durationSeconds
    }

    var direction: CallDirection { CallDirection(rawValue: directionRaw) ?? .outgoing }
    var displayName: String { contactName ?? phoneNumber ?? "Android cellular call" }
}

@Model
final class FavoriteRecord {
    @Attribute(.unique) var id: UUID
    var contactIdentifier: String?
    var displayName: String
    var phoneNumber: String
    var createdAt: Date

    init(contactIdentifier: String? = nil, displayName: String, phoneNumber: String) {
        id = UUID()
        self.contactIdentifier = contactIdentifier
        self.displayName = displayName
        self.phoneNumber = phoneNumber
        createdAt = Date()
    }
}

@MainActor
final class CallHistoryStore {
    private let context: ModelContext
    init(context: ModelContext) { self.context = context }

    func record(call: RelayCall, contactName: String?, outcome: String, duration: TimeInterval) {
        let callId = call.id
        let descriptor = FetchDescriptor<RecentCallRecord>(predicate: #Predicate { $0.relayCallId == callId })
        guard (try? context.fetch(descriptor))?.isEmpty != false else { return }
        context.insert(RecentCallRecord(
            relayCallId: call.id,
            phoneNumber: call.phoneNumber,
            contactName: contactName,
            direction: call.direction,
            outcome: outcome,
            startedAt: call.createdDate,
            durationSeconds: max(0, Int(duration))
        ))
        trim()
        try? context.save()
    }

    private func trim() {
        var descriptor = FetchDescriptor<RecentCallRecord>(sortBy: [SortDescriptor(\.startedAt, order: .reverse)])
        descriptor.fetchOffset = 200
        (try? context.fetch(descriptor))?.forEach(context.delete)
    }
}
