import Foundation

/// Talks to api.weather.gov directly. Used as a fallback when the backend is
/// unreachable, and for the hourly forecast. NWS requires a User-Agent that
/// identifies the app and gives a contact.
struct NWSClient {
    var userAgent = "Fieldwatch/0.1 (you@example.com)"

    func activeAlerts(latitude: Double, longitude: Double) async throws -> [SafetyAlert] {
        let url = URL(string: "https://api.weather.gov/alerts/active?point=\(fmt(latitude)),\(fmt(longitude))")!
        let collection: FeatureCollection = try await get(url)
        return collection.features.map { feature in
            let p = feature.properties
            return SafetyAlert(
                id: p.id,
                event: p.event,
                headline: p.headline,
                body: p.description ?? "",
                instruction: p.instruction,
                severity: AlertSeverity(rawValue: p.severity.lowercased()) ?? .unknown,
                area: p.areaDesc,
                source: p.senderName,
                issuedAt: p.effective,
                expiresAt: p.ends ?? p.expires,
                channel: .weather,
                relayCount: 0
            )
        }
    }

    func hourlyForecast(latitude: Double, longitude: Double) async throws -> [HourlyPeriod] {
        let pointURL = URL(string: "https://api.weather.gov/points/\(fmt(latitude)),\(fmt(longitude))")!
        let point: PointResponse = try await get(pointURL)
        let forecast: ForecastResponse = try await get(point.properties.forecastHourly)
        return forecast.properties.periods.prefix(36).map {
            HourlyPeriod(startTime: $0.startTime, temperature: $0.temperature, shortForecast: $0.shortForecast,
                         windSpeed: $0.windSpeed, precipChance: $0.probabilityOfPrecipitation?.value)
        }
    }

    private func fmt(_ d: Double) -> String { String(format: "%.4f", d) }

    private func get<T: Decodable>(_ url: URL) async throws -> T {
        var request = URLRequest(url: url)
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/geo+json", forHTTPHeaderField: "Accept")
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder.fieldwatch.decode(T.self, from: data)
    }

    private struct FeatureCollection: Decodable { let features: [Feature] }
    private struct Feature: Decodable { let properties: Properties }
    private struct Properties: Decodable {
        let id: String
        let event: String
        let headline: String?
        let description: String?
        let instruction: String?
        let severity: String
        let areaDesc: String
        let senderName: String
        let effective: Date
        let expires: Date
        let ends: Date?
    }
    private struct PointResponse: Decodable { let properties: PointProperties }
    private struct PointProperties: Decodable { let forecastHourly: URL }
    private struct ForecastResponse: Decodable { let properties: ForecastProperties }
    private struct ForecastProperties: Decodable { let periods: [Period] }
    private struct Period: Decodable {
        let startTime: Date
        let temperature: Int
        let shortForecast: String
        let windSpeed: String
        let probabilityOfPrecipitation: Precipitation?
    }
    private struct Precipitation: Decodable { let value: Int? }
}
