import SwiftUI

struct WeatherView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        List {
            Section {
                NavigationLink(value: Route.radar) {
                    HStack(spacing: 12) {
                        Image(systemName: "dot.radiowaves.left.and.right")
                            .font(.title3).foregroundStyle(Color.accentColor).frame(width: 28)
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Radar").font(.headline)
                            Text(radarSubtitle).font(.subheadline).foregroundStyle(.secondary)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }

            if app.activeAlerts.isEmpty {
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("No active alerts").font(.headline)
                        Text("Nothing in effect for \(county) right now.").font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                Section("Active alerts") {
                    ForEach(app.activeAlerts) { alert in
                        NavigationLink(value: Route.alert(alert)) {
                            HStack(spacing: 12) {
                                Circle().fill(alert.severity.color).frame(width: 12, height: 12)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(alert.event).font(.headline)
                                    if let expires = alert.expiresAt {
                                        Text("Until \(expires.formatted(date: .abbreviated, time: .shortened))")
                                            .font(.subheadline).foregroundStyle(.secondary)
                                    }
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }

            Section {
                if app.hourly.isEmpty {
                    Text("The forecast downloads when you have signal.").foregroundStyle(.secondary)
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(app.hourly.prefix(24)) { HourCard(period: $0) }
                        }
                    }
                    .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            } header: {
                Text("Next hours")
            } footer: {
                Text("National Weather Service. \(updatedText)")
            }
        }
        .navigationTitle("Weather")
        .onAppear { app.seenWeather = true }
    }

    private var county: String { app.selectedFestival?.county ?? "this area" }

    private var radarSubtitle: String {
        guard let loop = app.radar, let newest = loop.newest else { return "Downloads with the pack when you have signal" }
        let to = newest.time.formatted(date: .omitted, time: .shortened)
        return app.isOnline ? "Last \(loop.hours) hours, to \(to)" : "Last \(loop.hours) hours, to \(to), saved before signal dropped"
    }

    private var updatedText: String {
        guard let updated = app.lastUpdated else { return "Not updated yet." }
        let when = updated.formatted(.relative(presentation: .named))
        return app.isOnline ? "Updated \(when)." : "Last updated \(when), before signal dropped."
    }
}

struct HourCard: View {
    let period: HourlyPeriod

    var body: some View {
        VStack(spacing: 6) {
            Text(period.startTime.formatted(.dateTime.hour())).font(.caption).foregroundStyle(.secondary)
            Image(systemName: symbol).font(.title3).frame(height: 26)
            Text("\(period.temperature)°").font(.subheadline.weight(.semibold))
        }
        .frame(width: 64)
        .padding(.vertical, 12)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 14))
    }

    private var symbol: String {
        let s = period.shortForecast.lowercased()
        if s.contains("thunder") { return "cloud.bolt.rain" }
        if s.contains("rain") || s.contains("shower") { return "cloud.rain" }
        if s.contains("snow") { return "cloud.snow" }
        if s.contains("fog") || s.contains("haze") { return "cloud.fog" }
        if s.contains("cloud") { return s.contains("partly") ? "cloud.sun" : "cloud" }
        return "sun.max"
    }
}
