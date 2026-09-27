import SwiftUI
import AVFoundation

struct IncidentsView: View {
    @Environment(AppState.self) private var app
    @State private var player: AVPlayer?
    @State private var playingID: Incident.ID?
    @State private var showReport = false

    var body: some View {
        List {
            Section {
                HStack(spacing: 10) {
                    Circle().fill(app.receiverConnected ? Color.green : Color.secondary).frame(width: 9, height: 9)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(app.receiverConnected ? "Receiver on site" : "No receiver nearby").font(.headline)
                        Text(app.receiverConnected
                             ? "Connected to \(app.node.nodeName ?? "the receiver"). Works with no signal."
                             : "Join the receiver's Wi-Fi to get county dispatch with no signal.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }

            Section {
                if app.recentIncidents.isEmpty {
                    Text("Nothing reported in the last 48 hours.").foregroundStyle(.secondary)
                }
                ForEach(app.recentIncidents) { incident in
                    IncidentRow(incident: incident, playing: playingID == incident.id) { toggle(incident) }
                        .background {
                            if let festival = app.selectedFestival {
                                NavigationLink(value: Route.alert(incident.asAlert(festival: festival))) { EmptyView() }.opacity(0)
                            }
                        }
                }
            } header: {
                Text("Last 48 hours")
            } footer: {
                Text("Only safety-relevant traffic is kept: weather holds, flooding, closures, medical surges, security incidents. Names and numbers are removed.")
            }

            Section {
                Button { showReport = true } label: {
                    Label("Report something you're seeing", systemImage: "square.and.pencil")
                }
                .disabled(!app.isOnline)
            } footer: {
                Text(app.isOnline ? "Reports are checked by a person before they go out." : "Reporting needs a connection.")
            }
        }
        .navigationTitle("Incidents")
        .onAppear { app.seenIncidents = true }
        .onDisappear { stop() }
        .refreshable { await app.refreshFromNode(); await app.refresh() }
        .sheet(isPresented: $showReport) { ReportSheet() }
    }

    private func toggle(_ incident: Incident) {
        if playingID == incident.id { stop(); return }
        guard let url = incident.audio else { return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let newPlayer = AVPlayer(url: url)
        newPlayer.play()
        player = newPlayer
        playingID = incident.id
    }

    private func stop() {
        player?.pause(); player = nil; playingID = nil
    }
}

struct IncidentRow: View {
    let incident: Incident
    let playing: Bool
    let onPlay: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: incident.symbol)
                .font(.body.weight(.semibold))
                .foregroundStyle(incident.isWarning ? .red : .orange)
                .frame(width: 28)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                Text(incident.title).font(.headline)
                Text(incident.summary).font(.subheadline).foregroundStyle(.secondary).lineLimit(3)
                HStack(spacing: 6) {
                    Text(incident.occurredAt.formatted(date: .omitted, time: .shortened))
                    if let location = incident.location { Text(location) }
                    Text(incident.sourceLabel)
                }
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer()
            if incident.audio != nil {
                Button(action: onPlay) {
                    Image(systemName: playing ? "stop.fill" : "play.fill")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(playing ? .white : Color.accentColor)
                        .frame(width: 34, height: 34)
                        .background(playing ? Color.accentColor : Color(.tertiarySystemFill), in: Circle())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
    }
}

struct ReportSheet: View {
    @Environment(AppState.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var summary = ""
    @State private var location = ""
    @State private var sending = false
    @State private var failed = false

    var body: some View {
        NavigationStack {
            Form {
                Section("What's happening") {
                    TextField("Flooded path behind Stage 2, knee deep", text: $summary, axis: .vertical).lineLimit(3...6)
                }
                Section("Where") {
                    TextField("Stage, camp, gate", text: $location)
                }
                if failed {
                    Text("Couldn't send. Check your connection and try again.").foregroundStyle(.red)
                }
            }
            .navigationTitle("Report")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Send") { Task { await send() } }.disabled(summary.count < 8 || sending)
                }
            }
        }
    }

    private func send() async {
        sending = true; failed = false
        do {
            try await app.submitReport(summary, location: location.isEmpty ? nil : location)
            dismiss()
        } catch {
            failed = true
        }
        sending = false
    }
}
