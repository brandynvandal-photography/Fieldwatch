import SwiftUI

struct SettingsView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        List {
            Section("Alerts") {
                Toggle(isOn: Binding(get: { app.relayEnabled }, set: { app.setRelay($0) })) {
                    Text("Relay alerts to nearby phones")
                }
            }

            Section {
                HStack {
                    Circle().fill(app.receiverConnected ? Color.green : Color.secondary).frame(width: 9, height: 9)
                    Text(app.receiverConnected ? "Connected to \(app.node.nodeName ?? "a receiver")" : "No receiver on this network")
                }
            } header: {
                Text("On-site receiver")
            } footer: {
                Text("A receiver is a small box a volunteer runs on site. Join its Wi-Fi (scan the QR code on the box) and this phone finds it automatically. You'll get county dispatch incidents even with no cell service.")
            }

            Section("Saved for offline") {
                if app.savedPackIDs.isEmpty {
                    Text("Nothing saved yet").foregroundStyle(.secondary)
                }
                ForEach(app.savedPackIDs, id: \.self) { id in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(app.festivals.first(where: { $0.id == id })?.name ?? id).font(.headline)
                            Text(ByteCountFormatter.string(fromByteCount: Int64(app.packs.sizeInBytes(of: id)), countStyle: .file))
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Button("Remove", role: .destructive) { app.removePack(id) }
                    }
                }
            }

            Section {
                LabeledContent("Backend", value: app.backend.baseURL.host() ?? "")
                LabeledContent("Version", value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1")
            } footer: {
                Text("No account, no login. Nothing leaves your phone except your alert subscription.")
            }
        }
        .navigationTitle("Settings")
    }
}
