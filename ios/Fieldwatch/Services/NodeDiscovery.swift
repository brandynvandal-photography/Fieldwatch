import Foundation
import Network
import Observation

/// Finds a Fieldwatch receiver node on the local network. Pairing is just being on
/// the node's Wi-Fi: the node advertises itself over Bonjour and the phone picks it up.
@Observable
final class NodeDiscovery {
    static let serviceType = "_fieldwatch-node._tcp"

    private(set) var nodeURL: URL?
    private(set) var nodeName: String?
    @ObservationIgnored private var browser: NWBrowser?
    @ObservationIgnored private var probe: NWConnection?

    func start() {
        guard browser == nil else { return }
        let parameters = NWParameters.tcp
        parameters.includePeerToPeer = true
        let b = NWBrowser(for: .bonjour(type: Self.serviceType, domain: nil), using: parameters)
        b.browseResultsChangedHandler = { [weak self] results, _ in
            guard let self else { return }
            if let first = results.first {
                self.resolve(first.endpoint)
            } else {
                Task { @MainActor in self.nodeURL = nil; self.nodeName = nil }
            }
        }
        b.start(queue: DispatchQueue(label: "fieldwatch.node.browser"))
        browser = b
    }

    func stop() {
        browser?.cancel(); browser = nil
        probe?.cancel(); probe = nil
        nodeURL = nil; nodeName = nil
    }

    /// Bonjour gives a service name, not an address. Opening a connection and reading
    /// where it landed is the reliable way to turn that into a URL.
    private func resolve(_ endpoint: NWEndpoint) {
        probe?.cancel()
        let connection = NWConnection(to: endpoint, using: .tcp)
        connection.stateUpdateHandler = { [weak self] state in
            guard let self, case .ready = state else { return }
            if case let .hostPort(host, port)? = connection.currentPath?.remoteEndpoint {
                var hostString = "\(host)"
                if let percent = hostString.firstIndex(of: "%") { hostString = String(hostString[..<percent]) }
                if hostString.contains(":") { hostString = "[\(hostString)]" }
                let url = URL(string: "http://\(hostString):\(port.rawValue)")
                var name: String?
                if case let .service(serviceName, _, _, _) = endpoint { name = serviceName }
                Task { @MainActor in self.nodeURL = url; self.nodeName = name }
            }
            connection.cancel()
        }
        connection.start(queue: DispatchQueue(label: "fieldwatch.node.probe"))
        probe = connection
    }

    /// Reads incidents straight from the node. Works with no internet at all.
    func fetchIncidents(expectingFestival festivalID: String) async throws -> [Incident] {
        guard let nodeURL else { return [] }
        let (healthData, _) = try await URLSession.shared.data(from: nodeURL.appending(path: "health"))
        let health = try JSONDecoder.fieldwatch.decode(NodeHealth.self, from: healthData)
        guard health.festivalId == festivalID else { return [] }
        let (data, _) = try await URLSession.shared.data(from: nodeURL.appending(path: "incidents"))
        var list = try JSONDecoder.fieldwatch.decode([Incident].self, from: data)
        for i in list.indices { list[i].origin = nodeURL }
        return list
    }

    private struct NodeHealth: Decodable { let festivalId: String; let name: String }
}
