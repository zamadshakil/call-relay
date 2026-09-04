import SwiftData
import SwiftUI

@main
struct CallRelayApp: App {
    private let container: ModelContainer
    @StateObject private var model: AppModel

    init() {
        do {
            let container = try ModelContainer(for: RecentCallRecord.self, FavoriteRecord.self)
            self.container = container
            _model = StateObject(wrappedValue: AppModel(modelContext: container.mainContext))
        } catch {
            fatalError("Call Relay data store could not open: \(error.localizedDescription)")
        }
    }

    var body: some Scene {
        WindowGroup {
            RootView(model: model)
                .onOpenURL { _ = model.auth.handleOpenURL($0) }
        }
        .modelContainer(container)
    }
}
