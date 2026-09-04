import SwiftData
import XCTest
@testable import CallRelay

final class PersistenceTests: XCTestCase {
    @MainActor
    func testHistoryIsCappedAtTwoHundredNewestCalls() throws {
        let configuration = ModelConfiguration(isStoredInMemoryOnly: true)
        let container = try ModelContainer(
            for: RecentCallRecord.self,
            FavoriteRecord.self,
            configurations: configuration
        )
        let context = container.mainContext
        let history = CallHistoryStore(context: context)

        for index in 0..<205 {
            history.record(
                call: makeCall(index: index),
                contactName: nil,
                outcome: "Completed",
                duration: 30
            )
        }

        let rows = try context.fetch(FetchDescriptor<RecentCallRecord>(
            sortBy: [SortDescriptor(\.startedAt, order: .forward)]
        ))
        XCTAssertEqual(rows.count, 200)
        XCTAssertEqual(rows.first?.relayCallId, "call_00000000000000000000000000000005")
        XCTAssertEqual(rows.last?.relayCallId, "call_00000000000000000000000000000204")
    }

    private func makeCall(index: Int) -> RelayCall {
        let suffix = String(format: "%032d", index)
        let timestamp = Int64(1_700_000_000_000 + index * 1_000)
        return RelayCall(
            id: "call_\(suffix)",
            pairingId: "pair_0123456789abcdef0123456789abcdef",
            androidDeviceId: "dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            peerDeviceId: "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            direction: .outgoing,
            state: .ended,
            phoneNumber: "+14155552671",
            relayMode: .fullDuplex,
            createdAt: timestamp,
            updatedAt: timestamp + 500,
            endedAt: timestamp + 500,
            failureCode: nil,
            version: 1,
            selectedPairingId: "pair_0123456789abcdef0123456789abcdef",
            selectedPeerDeviceId: "dev_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            recipientStatus: .selected,
            icePolicy: "all",
            selectedCandidateType: "host"
        )
    }
}
