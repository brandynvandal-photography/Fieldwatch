import Foundation
import MultipeerConnectivity
import Observation

/// Phone-to-phone alert relay over Bluetooth and peer Wi-Fi. Any phone that
/// receives a new warning forwards it to every connected peer, which forwards
/// it on. Each alert is tracked by id so it only travels once per phone.
@Observable
final class RelayService: NSObject {
    static let serviceType = "fieldwatch-rl"

    private(set) var peerCount = 0
    var onReceive: (@MainActor (SafetyAlert) -> Void)?

    private let peerID = MCPeerID(displayName: String(UUID().uuidString.prefix(8)))
    @ObservationIgnored private var seen = Set<String>()
    @ObservationIgnored private var running = false

    @ObservationIgnored private lazy var session: MCSession = {
        let s = MCSession(peer: peerID, securityIdentity: nil, encryptionPreference: .required)
        s.delegate = self
        return s
    }()
    @ObservationIgnored private lazy var advertiser: MCNearbyServiceAdvertiser = {
        let a = MCNearbyServiceAdvertiser(peer: peerID, discoveryInfo: nil, serviceType: Self.serviceType)
        a.delegate = self
        return a
    }()
    @ObservationIgnored private lazy var browser: MCNearbyServiceBrowser = {
        let b = MCNearbyServiceBrowser(peer: peerID, serviceType: Self.serviceType)
        b.delegate = self
        return b
    }()

    func start() {
        guard !running else { return }
        running = true
        advertiser.startAdvertisingPeer()
        browser.startBrowsingForPeers()
    }

    func stop() {
        guard running else { return }
        running = false
        advertiser.stopAdvertisingPeer()
        browser.stopBrowsingForPeers()
        session.disconnect()
        peerCount = 0
    }

    func broadcast(_ alert: SafetyAlert) {
        seen.insert(alert.id)
        send(alert, to: session.connectedPeers)
    }

    private func send(_ alert: SafetyAlert, to peers: [MCPeerID]) {
        guard !peers.isEmpty, let data = try? JSONEncoder.fieldwatch.encode(alert) else { return }
        try? session.send(data, toPeers: peers, with: .reliable)
    }
}

extension RelayService: MCSessionDelegate {
    func session(_ session: MCSession, peer peerID: MCPeerID, didChange state: MCSessionState) {
        let count = session.connectedPeers.count
        Task { @MainActor in self.peerCount = count }
    }

    func session(_ session: MCSession, didReceive data: Data, fromPeer peerID: MCPeerID) {
        guard var alert = try? JSONDecoder.fieldwatch.decode(SafetyAlert.self, from: data),
              !seen.contains(alert.id) else { return }
        seen.insert(alert.id)
        alert.channel = .relay
        alert.relayCount += 1
        Task { @MainActor in self.onReceive?(alert) }
        send(alert, to: session.connectedPeers.filter { $0 != peerID })
    }

    func session(_: MCSession, didReceive: InputStream, withName: String, fromPeer: MCPeerID) {}
    func session(_: MCSession, didStartReceivingResourceWithName: String, fromPeer: MCPeerID, with: Progress) {}
    func session(_: MCSession, didFinishReceivingResourceWithName: String, fromPeer: MCPeerID, at: URL?, withError: Error?) {}
}

extension RelayService: MCNearbyServiceAdvertiserDelegate {
    func advertiser(_ advertiser: MCNearbyServiceAdvertiser, didReceiveInvitationFromPeer peerID: MCPeerID,
                    withContext context: Data?, invitationHandler: @escaping (Bool, MCSession?) -> Void) {
        invitationHandler(true, session)
    }
}

extension RelayService: MCNearbyServiceBrowserDelegate {
    func browser(_ browser: MCNearbyServiceBrowser, foundPeer peerID: MCPeerID, withDiscoveryInfo info: [String: String]?) {
        // Only one side invites, so two phones don't open two sessions with each other.
        if self.peerID.displayName < peerID.displayName {
            browser.invitePeer(peerID, to: session, withContext: nil, timeout: 20)
        }
    }

    func browser(_ browser: MCNearbyServiceBrowser, lostPeer peerID: MCPeerID) {}
}
