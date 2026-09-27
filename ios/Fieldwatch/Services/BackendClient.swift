import Foundation

/// Thin client for the Fieldwatch backend. Base URL comes from Info.plist
/// (FieldwatchBackendURL in project.yml) so TestFlight and local builds differ only there.
struct BackendClient {
    let baseURL: URL = {
        let configured = Bundle.main.object(forInfoDictionaryKey: "FieldwatchBackendURL") as? String
        return URL(string: configured ?? "http://localhost:3000")!
    }()

    func festivals() async throws -> [Festival] { try await get("festivals") }
    func pack(for id: String) async throws -> FestivalPack {
        var pack: FestivalPack = try await get("festivals/\(id)/pack")
        for i in pack.incidents.indices { pack.incidents[i].origin = baseURL }
        pack.radar?.origin = baseURL
        return pack
    }
    func radar(for id: String) async throws -> RadarLoop {
        var loop: RadarLoop = try await get("festivals/\(id)/radar")
        loop.origin = baseURL
        return loop
    }
    func alerts(for id: String) async throws -> [SafetyAlert] { try await get("festivals/\(id)/alerts") }
    func posts(for id: String) async throws -> [OfficialPost] { try await get("festivals/\(id)/posts") }
    func incidents(for id: String) async throws -> [Incident] {
        var list: [Incident] = try await get("festivals/\(id)/incidents")
        for i in list.indices { list[i].origin = baseURL }
        return list
    }

    /// An attendee report. It goes to a moderation queue; nothing is published automatically.
    func report(festivalID: String, summary: String, location: String?) async throws {
        var request = URLRequest(url: baseURL.appending(path: "festivals/\(festivalID)/reports"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.fieldwatch.encode(["summary": summary, "location": location ?? ""])
        let (_, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else { throw URLError(.badServerResponse) }
    }

    func registerDevice(token: String, festivalID: String?) async throws {
        var request = URLRequest(url: baseURL.appending(path: "devices"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder.fieldwatch.encode(["token": token, "festivalId": festivalID ?? ""])
        _ = try await URLSession.shared.data(for: request)
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        let (data, response) = try await URLSession.shared.data(from: baseURL.appending(path: path))
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder.fieldwatch.decode(T.self, from: data)
    }
}
