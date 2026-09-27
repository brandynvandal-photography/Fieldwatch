import Foundation
import Observation

/// Single source of truth for the app. Everything the views show comes from here,
/// and everything here is persisted into the festival pack so it survives offline.
@Observable @MainActor
final class AppState {
    var festivals: [Festival] = []
    var selectedFestival: Festival?
    var alerts: [SafetyAlert] = []
    var posts: [OfficialPost] = []
    var hourly: [HourlyPeriod] = []
    var incidents: [Incident] = []
    var radar: RadarLoop?
    var lastUpdated: Date?
    var savedPackIDs: [String] = []
    var relayEnabled = true
    var incomingAlert: SafetyAlert?
    var seenWeather = false
    var seenOfficial = false
    var seenIncidents = false

    let connectivity = Connectivity()
    let node = NodeDiscovery()
    let relay = RelayService()
    let packs = PackStore()
    let radarStore = RadarStore()
    let backend = BackendClient()
    let nws = NWSClient()

    var isOnline: Bool { connectivity.isOnline }
    var receiverConnected: Bool { node.nodeURL != nil }

    var recentIncidents: [Incident] {
        incidents.filter { $0.occurredAt > Date().addingTimeInterval(-48 * 3600) }.sorted { $0.occurredAt > $1.occurredAt }
    }

    var activeAlerts: [SafetyAlert] {
        alerts.filter(\.isActive).sorted { $0.severity > $1.severity }
    }

    var statusLevel: StatusLevel {
        if activeAlerts.isEmpty { return .clear }
        return activeAlerts.contains(where: \.isWarning) ? .warning : .advisory
    }

    func start() async {
        relayEnabled = UserDefaults.standard.object(forKey: "relayEnabled") as? Bool ?? true
        savedPackIDs = packs.savedIDs()
        relay.onReceive = { [weak self] alert in self?.receive(alert) }
        if relayEnabled { relay.start() }
        if let id = UserDefaults.standard.string(forKey: "selectedFestival"), let pack = packs.load(id) {
            apply(pack)
        }
        node.start()
        await loadFestivals()
        await refresh()
        Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.refreshFromNode()
                try? await Task.sleep(for: .seconds(20))
            }
        }
    }

    func loadFestivals() async {
        if let data = UserDefaults.standard.data(forKey: "festivalsCache"),
           let cached = try? JSONDecoder.fieldwatch.decode([Festival].self, from: data) {
            festivals = cached
        }
        guard isOnline, let fresh = try? await backend.festivals() else { return }
        festivals = fresh
        UserDefaults.standard.set(try? JSONEncoder.fieldwatch.encode(fresh), forKey: "festivalsCache")
    }

    /// Picking a festival downloads its pack once. After that it opens instantly, online or not.
    func select(_ festival: Festival) async throws {
        let pack: FestivalPack
        if let saved = packs.load(festival.id) {
            pack = saved
        } else {
            pack = try await backend.pack(for: festival.id)
            try packs.save(pack)
        }
        UserDefaults.standard.set(festival.id, forKey: "selectedFestival")
        seenWeather = false
        seenOfficial = false
        seenIncidents = false
        apply(pack)
        savedPackIDs = packs.savedIDs()
        if let token = UserDefaults.standard.string(forKey: "apnsToken") {
            try? await backend.registerDevice(token: token, festivalID: festival.id)
        }
        await refresh()
    }

    func clearSelection() {
        selectedFestival = nil
        alerts = []; posts = []; hourly = []; incidents = []; radar = nil; lastUpdated = nil
        UserDefaults.standard.removeObject(forKey: "selectedFestival")
    }

    func removePack(_ id: String) {
        packs.remove(id)
        radarStore.remove(festivalID: id)
        savedPackIDs = packs.savedIDs()
        if selectedFestival?.id == id { clearSelection() }
    }

    func setRelay(_ on: Bool) {
        relayEnabled = on
        UserDefaults.standard.set(on, forKey: "relayEnabled")
        on ? relay.start() : relay.stop()
    }

    /// Pull fresh alerts, forecast and posts. Backend first, NWS directly as a fallback.
    func refresh() async {
        guard isOnline, let f = selectedFestival else { return }
        var fresh = try? await backend.alerts(for: f.id)
        if fresh == nil { fresh = try? await nws.activeAlerts(latitude: f.latitude, longitude: f.longitude) }
        if let fresh {
            let known = Set(alerts.map(\.id))
            merge(fresh)
            for alert in fresh where !known.contains(alert.id) && alert.isWarning {
                incomingAlert = alert
                seenWeather = false
                relay.broadcast(alert)
            }
        }
        if let h = try? await nws.hourlyForecast(latitude: f.latitude, longitude: f.longitude) { hourly = h }
        if let p = try? await backend.posts(for: f.id) { posts = p }
        if let list = try? await backend.incidents(for: f.id) { mergeIncidents(list, festival: f) }
        if let loop = try? await backend.radar(for: f.id) {
            radar = loop
            let store = radarStore
            // Frames are immutable and small; fetching them now is what makes the loop play offline later.
            Task.detached(priority: .utility) {
                await store.prefetch(loop, festivalID: f.id)
                store.prune(keeping: loop, festivalID: f.id)
            }
        }
        lastUpdated = Date()
        persist()
    }

    /// A receiver node on the festival's Wi-Fi is closer to the truth than the backend
    /// and works with no internet, so it's polled on its own schedule.
    func refreshFromNode() async {
        guard receiverConnected, let f = selectedFestival else { return }
        if let list = try? await node.fetchIncidents(expectingFestival: f.id) {
            mergeIncidents(list, festival: f)
            lastUpdated = Date()
            persist()
        }
    }

    func submitReport(_ summary: String, location: String?) async throws {
        guard let f = selectedFestival else { return }
        try await backend.report(festivalID: f.id, summary: summary, location: location)
    }

    private func mergeIncidents(_ incoming: [Incident], festival: Festival) {
        let known = Set(incidents.map(\.id))
        var byID = Dictionary(incidents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for i in incoming { byID[i.id] = i }
        incidents = Array(byID.values)
        for i in incoming where !known.contains(i.id) {
            seenIncidents = false
            if i.isWarning {
                let alert = i.asAlert(festival: festival)
                incomingAlert = alert
                relay.broadcast(alert)
            }
        }
    }

    /// An alert that arrived from a nearby phone or a tapped push notification.
    func receive(_ alert: SafetyAlert) {
        let isNew = !alerts.contains { $0.id == alert.id }
        merge([alert])
        if isNew {
            incomingAlert = alert
            seenWeather = false
        }
        persist()
    }

    private func apply(_ pack: FestivalPack) {
        selectedFestival = pack.festival
        alerts = pack.alerts
        posts = pack.posts
        hourly = pack.hourly
        incidents = pack.incidents
        radar = pack.radar
        lastUpdated = pack.generatedAt
    }

    private func merge(_ incoming: [SafetyAlert]) {
        var byID = Dictionary(alerts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        for alert in incoming {
            if var existing = byID[alert.id] {
                existing.relayCount = max(existing.relayCount, alert.relayCount)
                byID[alert.id] = existing
            } else {
                byID[alert.id] = alert
            }
        }
        alerts = Array(byID.values)
    }

    private func persist() {
        guard let f = selectedFestival else { return }
        let pack = FestivalPack(festival: f, alerts: alerts, posts: posts, hourly: hourly, incidents: incidents, radar: radar, generatedAt: lastUpdated ?? Date())
        try? packs.save(pack)
    }
}
