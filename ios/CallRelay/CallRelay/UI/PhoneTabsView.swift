import SwiftUI

struct PhoneTabsView: View {
    @ObservedObject var model: AppModel
    @ObservedObject private var calls: CallCoordinator
    @State private var selectedTab = 3

    init(model: AppModel) {
        self.model = model
        calls = model.calls
    }

    var body: some View {
        TabView(selection: $selectedTab) {
            FavoritesView(model: model)
                .tabItem { Label("Favorites", systemImage: "star.fill") }
                .tag(0)
            RecentsView(model: model)
                .tabItem { Label("Recents", systemImage: "clock.fill") }
                .tag(1)
            ContactsView(model: model)
                .tabItem { Label("Contacts", systemImage: "person.crop.circle.fill") }
                .tag(2)
            KeypadView(model: model)
                .tabItem { Label("Keypad", systemImage: "circle.grid.3x3.fill") }
                .tag(3)
            SettingsView(model: model)
                .tabItem { Label("Settings", systemImage: "gearshape.fill") }
                .tag(4)
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            if let call = calls.currentCall,
               call.direction == .incoming,
               call.recipientStatus == .ringing {
                HStack(spacing: 12) {
                    Image(systemName: "phone.arrow.down.left.fill")
                        .foregroundStyle(.white)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(model.contacts.displayName(for: call.phoneNumber) ?? call.displayNumber)
                            .fontWeight(.semibold)
                        Text("Incoming through Android — answer in CallKit")
                            .font(.caption)
                    }
                    Spacer()
                }
                .foregroundStyle(.white)
                .padding(.horizontal)
                .frame(height: 58)
                .background(.green.gradient)
            }
        }
    }
}

struct CallErrorPresenter: ViewModifier {
    @Binding var message: String?
    func body(content: Content) -> some View {
        content.alert("Call Relay", isPresented: Binding(
            get: { message != nil },
            set: { if !$0 { message = nil } }
        )) {
            Button("OK", role: .cancel) { message = nil }
        } message: { Text(message ?? "") }
    }
}

extension View {
    func callError(_ message: Binding<String?>) -> some View { modifier(CallErrorPresenter(message: message)) }
}
