import SwiftUI

struct ChannelsView: View {
    @Environment(AppState.self) private var app
    @Binding var path: [Route]

    var body: some View {
        if let festival = app.selectedFestival {
            List {
                Section {
                    Button { tapStatus() } label: {
                        StatusBlock(level: app.statusLevel, title: statusTitle, subtitle: statusSubtitle,
                                    footnote: app.statusLevel == .clear ? checkedText : nil)
                    }
                    .buttonStyle(.plain)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                } header: {
                    ConnectionPill(online: app.isOnline, updated: app.lastUpdated).textCase(nil)
                }

                Section {
                    NavigationLink(value: Route.weather) {
                        ChannelRow(title: "Weather", subtitle: weatherSubtitle,
                                   badge: app.seenWeather ? 0 : app.activeAlerts.count, dot: app.statusLevel.color)
                    }
                    NavigationLink(value: Route.official) {
                        ChannelRow(title: "Festival official",
                                   subtitle: festival.isPartner ? "Updates from the festival" : "Site info, not yet partnered",
                                   badge: app.seenOfficial ? 0 : app.posts.count)
                    }
                    NavigationLink(value: Route.incidents) {
                        ChannelRow(title: "Incidents",
                                   subtitle: app.receiverConnected ? "Receiver on site, live from county dispatch" : "County dispatch and attendee reports",
                                   badge: app.seenIncidents ? 0 : app.recentIncidents.count,
                                   dot: app.recentIncidents.contains(where: \.isWarning) ? .red : nil)
                    }
                    NavigationLink(value: Route.relay) {
                        ChannelRow(title: "Attendee relay",
                                   subtitle: app.relayEnabled ? "Sharing alerts with \(app.relay.peerCount) phones nearby" : "Off")
                    }
                    if !festival.feeds.isEmpty {
                        NavigationLink(value: Route.audio) {
                            ChannelRow(title: "Live audio",
                                       subtitle: app.isOnline ? "\(festival.feeds.count) public feeds for \(festival.county)" : "Needs a connection")
                        }
                    }
                } header: {
                    Text("Channels")
                } footer: {
                    Text("Emergency alerts from your carrier still arrive on their own, even when this app has no data.")
                }
            }
            .navigationTitle(festival.name)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Change") { app.clearSelection() }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    NavigationLink(value: Route.settings) { Image(systemName: "gearshape") }
                }
            }
            .refreshable { await app.refresh() }
        }
    }

    private var statusTitle: String {
        switch app.statusLevel {
        case .clear: "All clear"
        case .warning: app.activeAlerts.first(where: \.isWarning)?.event ?? "Warning"
        case .advisory: app.activeAlerts.count == 1 ? app.activeAlerts[0].event : "\(app.activeAlerts.count) advisories in effect"
        }
    }

    private var statusSubtitle: String {
        switch app.statusLevel {
        case .clear: "No weather alerts for \(app.selectedFestival?.county ?? "this area")."
        case .warning: "Take shelter now. Stages and tents are not safe shelter."
        case .advisory: app.activeAlerts.first?.expiresAt.map { "Until \($0.formatted(date: .omitted, time: .shortened)). Tap for details." } ?? "Tap for details."
        }
    }

    private var checkedText: String {
        if app.isOnline { return "Checked just now" }
        return "Last checked \(app.lastUpdated?.formatted(.relative(presentation: .named)) ?? "a while ago"), before signal dropped"
    }

    private var weatherSubtitle: String {
        let n = app.activeAlerts.count
        return n == 0 ? "Forecast and hazards" : "\(n) active alert\(n == 1 ? "" : "s")"
    }

    private func tapStatus() {
        if let warning = app.activeAlerts.first(where: \.isWarning) {
            path.append(.alert(warning))
        } else if let first = app.activeAlerts.first {
            path.append(.alert(first))
        } else {
            path.append(.weather)
        }
    }
}
