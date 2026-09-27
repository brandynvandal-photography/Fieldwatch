import Foundation

struct Festival: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let location: String
    let latitude: Double
    let longitude: Double
    let startDate: Date
    let endDate: Date
    let county: String
    let isPartner: Bool
    let feeds: [AudioFeed]
    let site: [SiteItem]

    private static let rangeFormatter: DateIntervalFormatter = {
        let f = DateIntervalFormatter()
        f.dateStyle = .medium
        f.timeStyle = .none
        return f
    }()

    var dateRange: String { Self.rangeFormatter.string(from: startDate, to: endDate) }
}

struct AudioFeed: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let detail: String
    let streamURL: URL
}

struct SiteItem: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let detail: String
}

struct OfficialPost: Codable, Identifiable, Hashable {
    let id: String
    let title: String
    let body: String
    let postedAt: Date
}

/// Mirrors the NWS severity scale so alerts from the API map 1:1.
enum AlertSeverity: String, Codable, Comparable, CaseIterable {
    case unknown, minor, moderate, severe, extreme

    static func < (lhs: AlertSeverity, rhs: AlertSeverity) -> Bool {
        allCases.firstIndex(of: lhs)! < allCases.firstIndex(of: rhs)!
    }
}

enum AlertChannel: String, Codable {
    case weather, official, relay, incident
}

struct SafetyAlert: Codable, Identifiable, Hashable {
    let id: String
    let event: String
    let headline: String?
    let body: String
    let instruction: String?
    let severity: AlertSeverity
    let area: String
    let source: String
    let issuedAt: Date
    let expiresAt: Date?
    var channel: AlertChannel
    var relayCount: Int

    var isWarning: Bool { severity >= .severe }
    var isActive: Bool { expiresAt.map { $0 > Date() } ?? true }
}

struct HourlyPeriod: Codable, Identifiable, Hashable {
    var id: Date { startTime }
    let startTime: Date
    let temperature: Int
    let shortForecast: String
    let windSpeed: String
    let precipChance: Int?
}

/// One safety-relevant radio call or attendee report. Same shape whether it came
/// from the backend or from a receiver node on the festival's own Wi-Fi.
struct Incident: Codable, Identifiable, Hashable {
    let id: String
    let category: String
    let level: String
    let summary: String
    let transcript: String?
    let source: String
    let talkgroup: String?
    let location: String?
    let audioURL: String?
    let occurredAt: Date
    /// Where this copy was fetched from, so the relative audioURL can be resolved. Set by the app.
    var origin: URL?

    var isWarning: Bool { level == "warning" }

    var title: String {
        switch category {
        case "threat": "Security incident"
        case "evacuation": "Evacuation notice"
        case "weather": "Weather hazard"
        case "flood": "Flooding reported"
        case "fire": "Fire reported"
        case "missing": "Missing person"
        case "medical": "Medical emergency"
        case "crowd": "Crowd hazard"
        case "traffic": "Road or gate closure"
        default: "Incident"
        }
    }

    var symbol: String {
        switch category {
        case "threat": "exclamationmark.shield"
        case "evacuation": "figure.walk.arrival"
        case "weather": "cloud.bolt"
        case "flood": "water.waves"
        case "fire": "flame"
        case "missing": "person.fill.questionmark"
        case "medical": "cross.case"
        case "crowd": "person.3"
        case "traffic": "road.lanes"
        default: "exclamationmark.circle"
        }
    }

    var sourceLabel: String {
        switch source {
        case "scanner": "County dispatch, via on-site receiver"
        case "attendee": "Attendee report"
        case "official": "Festival staff"
        default: source
        }
    }

    var audio: URL? {
        guard let audioURL else { return nil }
        if let absolute = URL(string: audioURL), absolute.scheme != nil { return absolute }
        return origin?.appending(path: audioURL.hasPrefix("/") ? String(audioURL.dropFirst()) : audioURL)
    }

    /// Lets an incident ride the same banner, relay and detail screen as a weather alert.
    func asAlert(festival: Festival) -> SafetyAlert {
        SafetyAlert(id: id, event: title, headline: location, body: summary, instruction: nil,
                    severity: isWarning ? .severe : .moderate, area: location ?? festival.name, source: sourceLabel,
                    issuedAt: occurredAt, expiresAt: occurredAt.addingTimeInterval(6 * 3600), channel: .incident, relayCount: 0)
    }
}

/// Everything saved to disk when a festival is picked. This is what makes offline work.
struct FestivalPack: Codable {
    var festival: Festival
    var alerts: [SafetyAlert]
    var posts: [OfficialPost]
    var hourly: [HourlyPeriod]
    var incidents: [Incident]
    var generatedAt: Date

    init(festival: Festival, alerts: [SafetyAlert], posts: [OfficialPost], hourly: [HourlyPeriod], incidents: [Incident], generatedAt: Date) {
        self.festival = festival; self.alerts = alerts; self.posts = posts; self.hourly = hourly; self.incidents = incidents; self.generatedAt = generatedAt
    }

    private enum CodingKeys: String, CodingKey { case festival, alerts, posts, hourly, incidents, generatedAt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        festival = try c.decode(Festival.self, forKey: .festival)
        alerts = try c.decodeIfPresent([SafetyAlert].self, forKey: .alerts) ?? []
        posts = try c.decodeIfPresent([OfficialPost].self, forKey: .posts) ?? []
        hourly = try c.decodeIfPresent([HourlyPeriod].self, forKey: .hourly) ?? []
        incidents = try c.decodeIfPresent([Incident].self, forKey: .incidents) ?? []
        generatedAt = try c.decode(Date.self, forKey: .generatedAt)
    }
}

enum StatusLevel {
    case clear, advisory, warning
}

// MARK: - JSON helpers that accept both plain and fractional ISO 8601 dates

extension ISO8601DateFormatter {
    static let plain: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f
    }()
    static let fractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
}

extension JSONDecoder {
    static let fieldwatch: JSONDecoder = {
        let d = JSONDecoder()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = ISO8601DateFormatter.fractional.date(from: s) ?? ISO8601DateFormatter.plain.date(from: s) {
                return date
            }
            throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Unreadable date: \(s)"))
        }
        return d
    }()
}

extension JSONEncoder {
    static let fieldwatch: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        e.outputFormatting = [.sortedKeys]
        return e
    }()
}
