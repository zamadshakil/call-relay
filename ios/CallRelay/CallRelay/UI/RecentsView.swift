import SwiftData
import SwiftUI

struct RecentsView: View {
    @ObservedObject var model: AppModel
    @Query(sort: \RecentCallRecord.startedAt, order: .reverse) private var recents: [RecentCallRecord]
    @Environment(\.modelContext) private var context
    @State private var clearing = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Group {
                if recents.isEmpty {
                    ContentUnavailableView("No Recent Calls", systemImage: "clock", description: Text("Your relay call history stays on this iPhone."))
                } else {
                    List {
                        ForEach(recents) { recent in
                            Button { Task { await call(recent) } } label: {
                                HStack(spacing: 12) {
                                    Image(systemName: recent.direction == .incoming ? "phone.arrow.down.left" : "phone.arrow.up.right")
                                        .foregroundStyle(recent.outcome == "Missed" ? .red : .secondary)
                                    VStack(alignment: .leading, spacing: 3) {
                                        Text(recent.displayName)
                                            .foregroundStyle(recent.outcome == "Missed" ? .red : .primary)
                                        Text("\(recent.outcome) · \(recent.direction == .incoming ? "Incoming" : "Outgoing")")
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    VStack(alignment: .trailing) {
                                        Text(recent.startedAt, style: .relative).font(.caption).foregroundStyle(.secondary)
                                        if recent.durationSeconds > 0 {
                                            Text(formatRecentDuration(recent.durationSeconds))
                                                .font(.caption2).foregroundStyle(.secondary)
                                        }
                                    }
                                }
                            }
                            .swipeActions {
                                Button("Delete", role: .destructive) { context.delete(recent); try? context.save() }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Recents")
            .toolbar {
                if !recents.isEmpty {
                    ToolbarItem(placement: .topBarLeading) { Button("Clear", role: .destructive) { clearing = true } }
                }
            }
            .confirmationDialog("Clear all recent calls?", isPresented: $clearing, titleVisibility: .visible) {
                Button("Clear All Recents", role: .destructive) {
                    recents.forEach(context.delete)
                    try? context.save()
                }
            }
        }
        .callError($errorMessage)
    }

    private func call(_ recent: RecentCallRecord) async {
        guard let number = recent.phoneNumber else { errorMessage = "This private caller has no number to call back."; return }
        do { try await model.placeCall(number) }
        catch { errorMessage = error.localizedDescription }
    }
}

private func formatRecentDuration(_ seconds: Int) -> String {
    let minutes = seconds / 60
    let remainder = seconds % 60
    return String(format: "%d:%02d", minutes, remainder)
}
