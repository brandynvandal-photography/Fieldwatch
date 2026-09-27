import SwiftUI

struct RelayView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        List {
            Section {
                Toggle(isOn: Binding(get: { app.relayEnabled }, set: { app.setRelay($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Relay alerts nearby").font(.headline)
                        Text("Uses Bluetooth and peer Wi-Fi.").font(.subheadline).foregroundStyle(.secondary)
                    }
                }
            } footer: {
                Text("Alerts hop phone to phone when there's no signal. Anyone nearby who catches a bar passes new alerts to you automatically.")
            }

            Section {
                VStack(spacing: 6) {
                    Text("\(app.relayEnabled ? app.relay.peerCount : 0)")
                        .font(.system(size: 56, weight: .bold, design: .rounded))
                        .contentTransition(.numericText())
                    Text(app.relayEnabled ? "phones within reach" : "Relay is off").foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 12)
            }

            Section("Received from nearby phones") {
                let relayed = app.alerts.filter { $0.relayCount > 0 }
                if relayed.isEmpty {
                    Text("Nothing relayed yet.").foregroundStyle(.secondary)
                }
                ForEach(relayed) { alert in
                    NavigationLink(value: Route.alert(alert)) {
                        ChannelRow(title: alert.event,
                                   subtitle: "From \(alert.relayCount) phone\(alert.relayCount == 1 ? "" : "s") nearby",
                                   dot: alert.severity.color)
                    }
                }
            }
        }
        .navigationTitle("Attendee relay")
    }
}
