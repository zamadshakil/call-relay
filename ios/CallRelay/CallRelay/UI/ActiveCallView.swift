import SwiftUI

struct ActiveCallView: View {
    @ObservedObject var coordinator: CallCoordinator
    @ObservedObject var contacts: ContactsService
    @State private var choosingAudio = false
    @State private var errorMessage: String?

    var body: some View {
        ZStack {
            LinearGradient(colors: [.black, Color(red: 0.08, green: 0.13, blue: 0.10)], startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea()
            if let call = coordinator.currentCall {
                VStack(spacing: 28) {
                    VStack(spacing: 8) {
                        Text("CALL RELAY").font(.caption.bold()).tracking(2).foregroundStyle(.green)
                        Text(contacts.displayName(for: call.phoneNumber) ?? call.displayNumber)
                            .font(.system(size: 32, weight: .medium)).lineLimit(1).minimumScaleFactor(0.6)
                        Text(call.phoneNumber ?? "Private or unavailable caller ID")
                            .font(.subheadline).foregroundStyle(.white.opacity(0.7))
                        durationView
                    }
                    .padding(.top, 42)

                    VStack(spacing: 7) {
                        Label(qualityTitle, systemImage: qualitySymbol)
                            .foregroundStyle(qualityColor)
                        if let detail = coordinator.connectionDetail {
                            Text(detail.uppercased()).font(.caption2.bold()).foregroundStyle(.white.opacity(0.55))
                        }
                        if let statistics = coordinator.mediaStatistics {
                            Text("RTT \(Int(statistics.rttMs.rounded())) ms · Jitter \(Int(statistics.jitterMs.rounded())) ms · Loss \(String(format: "%.1f", coordinator.packetLossPercent ?? 0))%")
                                .font(.caption2.monospacedDigit())
                                .foregroundStyle(.white.opacity(0.65))
                        }
                    }

                    HStack(spacing: 28) {
                        CallControlButton(title: "mute", symbol: coordinator.isMuted ? "mic.slash.fill" : "mic.fill", selected: coordinator.isMuted) {
                            Task { await coordinator.toggleMute() }
                        }
                        CallControlButton(title: "keypad", symbol: "circle.grid.3x3.fill", selected: coordinator.showingDTMF) {
                            coordinator.showingDTMF.toggle()
                        }
                        CallControlButton(title: "audio", symbol: audioSymbol, selected: coordinator.audio.output == .speaker) {
                            choosingAudio = true
                        }
                    }

                    Picker("Relay audio mode", selection: Binding(
                        get: { coordinator.mode },
                        set: { value in Task { await coordinator.setMode(value) } }
                    )) {
                        ForEach(RelayMode.allCases) { mode in Label(mode.title, systemImage: mode.symbol).tag(mode) }
                    }
                    .pickerStyle(.segmented)
                    .padding(.horizontal, 18)
                    .colorScheme(.dark)

                    if coordinator.showingDTMF {
                        InCallKeypad { digit in Task { await coordinator.sendDTMF(digit) } }
                            .transition(.move(edge: .bottom).combined(with: .opacity))
                    } else {
                        Spacer()
                    }

                    Button { Task { await coordinator.endCurrentCall() } } label: {
                        Image(systemName: "phone.down.fill")
                            .font(.title2.bold()).foregroundStyle(.white)
                            .frame(width: 72, height: 72).background(.red, in: Circle())
                    }
                    .accessibilityLabel("End call")
                    .padding(.bottom, 26)
                }
                .foregroundStyle(.white)
            }
        }
        .confirmationDialog("Audio Route", isPresented: $choosingAudio, titleVisibility: .visible) {
            ForEach(AudioSessionController.Output.allCases) { output in
                Button(output.rawValue) { coordinator.setAudioOutput(output) }
            }
        }
        .callError(Binding(
            get: { coordinator.errorMessage },
            set: { coordinator.errorMessage = $0 }
        ))
    }

    @ViewBuilder
    private var durationView: some View {
        if let start = coordinator.activeSince {
            TimelineView(.periodic(from: start, by: 1)) { context in
                Text(formatDuration(context.date.timeIntervalSince(start)))
                    .font(.system(.body, design: .monospaced)).foregroundStyle(.white.opacity(0.8))
            }
        } else {
            Text(coordinator.mediaState == .connected ? "Connecting cellular call…" : "Connecting audio…")
                .font(.body).foregroundStyle(.white.opacity(0.8))
        }
    }

    private var qualitySymbol: String {
        guard coordinator.mediaState == .connected else {
            return coordinator.mediaState == .failed ? "exclamationmark.triangle.fill" : "wave.3.right.circle"
        }
        switch coordinator.mediaQuality {
        case .excellent: return "wave.3.right"
        case .good: return "wave.3.right"
        case .fair: return "wave.2.right"
        case .poor: return "wave.1.right"
        case .unknown: return "wave.3.right.circle"
        }
    }

    private var qualityTitle: String {
        coordinator.mediaState == .connected ? "\(coordinator.mediaQuality.rawValue) connection" : coordinator.mediaState.rawValue
    }

    private var qualityColor: Color {
        guard coordinator.mediaState == .connected else { return .white.opacity(0.75) }
        switch coordinator.mediaQuality {
        case .excellent, .good: return .green
        case .fair: return .yellow
        case .poor: return .red
        case .unknown: return .white.opacity(0.75)
        }
    }

    private var audioSymbol: String { coordinator.audio.output == .speaker ? "speaker.wave.3.fill" : "speaker.wave.2.fill" }
}

private struct CallControlButton: View {
    let title: String
    let symbol: String
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Image(systemName: symbol).font(.title2)
                    .frame(width: 68, height: 68)
                    .background(selected ? .white : .white.opacity(0.18), in: Circle())
                    .foregroundStyle(selected ? .black : .white)
                Text(title).font(.caption)
            }
        }
        .buttonStyle(.plain)
    }
}

private struct InCallKeypad: View {
    let send: (String) -> Void
    private let values = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"]
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(58), spacing: 17), count: 3), spacing: 10) {
            ForEach(values, id: \.self) { value in
                Button(value) { send(value) }
                    .font(.title2)
                    .frame(width: 58, height: 52)
                    .background(.white.opacity(0.15), in: Circle())
                    .foregroundStyle(.white)
            }
        }
    }
}

private func formatDuration(_ interval: TimeInterval) -> String {
    let total = max(0, Int(interval))
    let hours = total / 3600
    let minutes = total % 3600 / 60
    let seconds = total % 60
    return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, seconds) : String(format: "%02d:%02d", minutes, seconds)
}
