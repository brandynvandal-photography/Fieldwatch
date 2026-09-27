import SwiftUI
import AVFoundation

struct LiveAudioView: View {
    @Environment(AppState.self) private var app
    @State private var player: AVPlayer?
    @State private var playingID: AudioFeed.ID?

    var body: some View {
        List {
            if !app.isOnline {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Needs a connection").font(.headline)
                        Text("These feeds stream over the internet. They'll play again when signal comes back.")
                            .font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            }
            Section {
                ForEach(app.selectedFestival?.feeds ?? []) { feed in
                    HStack(spacing: 14) {
                        Button { toggle(feed) } label: {
                            Image(systemName: playingID == feed.id ? "stop.fill" : "play.fill")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(playingID == feed.id ? .white : Color.accentColor)
                                .frame(width: 40, height: 40)
                                .background(playingID == feed.id ? Color.accentColor : Color(.tertiarySystemFill), in: Circle())
                        }
                        .buttonStyle(.plain)
                        .disabled(!app.isOnline)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(feed.name).font(.headline)
                            Text(playingID == feed.id ? "Listening" : feed.detail).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            } footer: {
                Text("Feeds are run by volunteers and cover the county, not the festival. Some areas have none.")
            }
        }
        .navigationTitle("Live audio")
        .onDisappear { stop() }
    }

    private func toggle(_ feed: AudioFeed) {
        if playingID == feed.id { stop(); return }
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let newPlayer = AVPlayer(url: feed.streamURL)
        newPlayer.play()
        player = newPlayer
        playingID = feed.id
    }

    private func stop() {
        player?.pause()
        player = nil
        playingID = nil
    }
}
