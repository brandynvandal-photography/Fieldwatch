import SwiftUI

extension StatusLevel {
    var color: Color {
        switch self {
        case .clear: .green
        case .advisory: .orange
        case .warning: .red
        }
    }
}

extension AlertSeverity {
    var color: Color { self >= .severe ? .red : .orange }
}

/// The one loud element in the app. Green, amber or red, and it pulses only for a warning.
struct StatusBlock: View {
    let level: StatusLevel
    let title: String
    let subtitle: String
    var footnote: String? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.title2.weight(.bold))
            Text(subtitle).font(.subheadline)
            if let footnote {
                Text(footnote).font(.footnote.weight(.semibold)).padding(.top, 6)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(20)
        .foregroundStyle(level == .advisory ? Color.black.opacity(0.85) : .white)
        .background(level.color, in: RoundedRectangle(cornerRadius: 20))
        .overlay {
            if level == .warning && !reduceMotion {
                RoundedRectangle(cornerRadius: 20)
                    .stroke(.white, lineWidth: 2)
                    .scaleEffect(pulse ? 1.04 : 1)
                    .opacity(pulse ? 0 : 0.7)
                    .animation(.easeOut(duration: 1.6).repeatForever(autoreverses: false), value: pulse)
                    .onAppear { pulse = true }
            }
        }
    }
}

struct ChannelRow: View {
    let title: String
    let subtitle: String
    var badge: Int = 0
    var dot: Color? = nil

    var body: some View {
        HStack(spacing: 12) {
            if let dot {
                Circle().fill(dot).frame(width: 12, height: 12)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline)
                Text(subtitle).font(.subheadline).foregroundStyle(.secondary)
            }
            Spacer()
            if badge > 0 {
                Text("\(badge)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.white)
                    .padding(.horizontal, 7).padding(.vertical, 3)
                    .background(.red, in: Capsule())
            }
        }
        .padding(.vertical, 4)
    }
}

struct ConnectionPill: View {
    let online: Bool
    let updated: Date?

    var body: some View {
        HStack(spacing: 7) {
            Circle().fill(online ? Color.green : Color.secondary).frame(width: 9, height: 9)
            Text(label)
        }
        .font(.subheadline.weight(.semibold))
        .padding(.horizontal, 12).padding(.vertical, 6)
        .background(.thinMaterial, in: Capsule())
    }

    private var label: String {
        if online { return "Live" }
        guard let updated else { return "Offline" }
        return "Offline, updated \(updated.formatted(.relative(presentation: .named)))"
    }
}

/// In-app banner for an alert that just arrived, whether over data, push or Bluetooth.
struct IncomingAlertBanner: View {
    @Environment(AppState.self) private var app
    @Binding var path: [Route]

    var body: some View {
        ZStack(alignment: .top) {
            if let alert = app.incomingAlert {
                Button {
                    app.incomingAlert = nil
                    path.append(.alert(alert))
                } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Image(systemName: "bell.badge.fill")
                            .font(.title3)
                            .foregroundStyle(.white)
                            .frame(width: 38, height: 38)
                            .background(Color.accentColor, in: RoundedRectangle(cornerRadius: 9))
                        VStack(alignment: .leading, spacing: 2) {
                            HStack {
                                Text("Fieldwatch")
                                Spacer()
                                Text("now")
                            }
                            .font(.caption).foregroundStyle(.secondary)
                            Text(alert.event).font(.subheadline.weight(.semibold))
                            Text(alert.headline ?? alert.body)
                                .font(.footnote).foregroundStyle(.secondary).lineLimit(2)
                        }
                    }
                    .padding(14)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
                    .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                    .padding(.horizontal, 10)
                }
                .buttonStyle(.plain)
                .transition(.move(edge: .top).combined(with: .opacity))
                .task(id: alert.id) {
                    try? await Task.sleep(for: .seconds(8))
                    if app.incomingAlert?.id == alert.id { app.incomingAlert = nil }
                }
            }
        }
        .animation(.spring(duration: 0.35), value: app.incomingAlert?.id)
    }
}
