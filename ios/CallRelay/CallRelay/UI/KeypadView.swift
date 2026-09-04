import SwiftUI

struct KeypadView: View {
    @ObservedObject var model: AppModel
    @State private var digits = ""
    @State private var errorMessage: String?

    private let rows = [
        [DialKey(digit: "1", letters: ""), DialKey(digit: "2", letters: "ABC"), DialKey(digit: "3", letters: "DEF")],
        [DialKey(digit: "4", letters: "GHI"), DialKey(digit: "5", letters: "JKL"), DialKey(digit: "6", letters: "MNO")],
        [DialKey(digit: "7", letters: "PQRS"), DialKey(digit: "8", letters: "TUV"), DialKey(digit: "9", letters: "WXYZ")],
        [DialKey(digit: "*", letters: ""), DialKey(digit: "0", letters: "+"), DialKey(digit: "#", letters: "")]
    ]

    private var matchedContact: String? {
        let normalized = try? PhoneNumberPolicy().normalize(digits)
        return model.contacts.contacts.first { $0.normalizedNumber == normalized }?.displayName
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 17) {
                Spacer(minLength: 12)
                VStack(spacing: 4) {
                    Text(digits.isEmpty ? " " : digits)
                        .font(.system(size: 31, weight: .regular, design: .rounded))
                        .lineLimit(1).minimumScaleFactor(0.5)
                    Text(matchedContact ?? " ").font(.subheadline).foregroundStyle(.secondary)
                }
                .frame(height: 66)

                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    HStack(spacing: 24) {
                        ForEach(row) { key in
                            VStack(spacing: 0) {
                                Text(key.digit).font(.system(size: 31, weight: .regular, design: .rounded))
                                Text(key.letters).font(.system(size: 9, weight: .bold)).tracking(2)
                            }
                            .foregroundStyle(.primary)
                            .frame(width: 74, height: 74)
                            .background(Color(.secondarySystemFill), in: Circle())
                            .contentShape(Circle())
                            .gesture(
                                LongPressGesture(minimumDuration: 0.55)
                                    .exclusively(before: TapGesture())
                                    .onEnded { result in
                                        switch result {
                                        case .first:
                                            append(key.digit == "0" ? "+" : key.digit)
                                        case .second:
                                            append(key.digit)
                                        }
                                    }
                            )
                            .accessibilityElement(children: .combine)
                            .accessibilityAddTraits(.isButton)
                            .accessibilityLabel(key.digit == "0" ? "0, hold for plus" : key.digit)
                            .accessibilityAction { append(key.digit) }
                        }
                    }
                }

                HStack(spacing: 28) {
                    Color.clear.frame(width: 74, height: 74)
                    Button { Task { await placeCall() } } label: {
                        Image(systemName: "phone.fill")
                            .font(.title2.bold()).foregroundStyle(.white)
                            .frame(width: 74, height: 74)
                            .background(.green, in: Circle())
                    }
                    .disabled(digits.isEmpty)
                    Button { if !digits.isEmpty { digits.removeLast() } } label: {
                        Image(systemName: "delete.left.fill")
                            .font(.title2).foregroundStyle(.secondary)
                            .frame(width: 74, height: 74)
                    }
                    .opacity(digits.isEmpty ? 0 : 1)
                }
                Spacer(minLength: 8)
            }
            .navigationTitle("Keypad")
            .navigationBarTitleDisplayMode(.inline)
            .padding(.horizontal)
        }
        .callError($errorMessage)
    }

    private func placeCall() async {
        do {
            try await model.placeCall(digits)
            digits = ""
        } catch { errorMessage = error.localizedDescription }
    }

    private func append(_ value: String) {
        guard digits.count < 18 else { return }
        if value == "+" {
            guard digits.isEmpty else { return }
        }
        digits.append(value)
    }
}

private struct DialKey: Identifiable {
    let digit: String
    let letters: String
    var id: String { digit }
}
