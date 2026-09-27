import SwiftUI

struct AlertDetailView: View {
    let alert: SafetyAlert

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(alert.isWarning ? "Warning" : "Advisory").font(.subheadline.weight(.semibold))
                    Text(alert.event).font(.title.weight(.bold))
                    if let expires = alert.expiresAt {
                        Text("Until \(expires.formatted(date: .abbreviated, time: .shortened))").font(.subheadline)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(20)
                .foregroundStyle(alert.isWarning ? .white : Color.black.opacity(0.85))
                .background(alert.severity.color, in: RoundedRectangle(cornerRadius: 20))

                if let headline = alert.headline {
                    Text(headline).font(.headline)
                }
                Text(alert.body)
                if let instruction = alert.instruction {
                    Text(instruction).fontWeight(.medium)
                }

                VStack(spacing: 0) {
                    detail("Area", alert.area)
                    Divider()
                    detail("Source", alert.source)
                    Divider()
                    detail("Issued", alert.issuedAt.formatted(date: .abbreviated, time: .shortened))
                    Divider()
                    detail("Received", received)
                }
                .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 14))

                Text("Saved on your phone. You can open this with no signal.").font(.footnote).foregroundStyle(.secondary)
            }
            .padding(16)
        }
        .background(Color(.systemGroupedBackground))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ShareLink(item: shareText) { Text("Share") }
        }
    }

    private var received: String {
        switch alert.channel {
        case .weather: "Directly, over data"
        case .official: "From the festival"
        case .relay: "From \(alert.relayCount) phone\(alert.relayCount == 1 ? "" : "s") nearby"
        case .incident: "Incident feed"
        }
    }

    private var shareText: String {
        "\(alert.event) for \(alert.area). \(alert.headline ?? String(alert.body.prefix(200)))"
    }

    private func detail(_ key: String, _ value: String) -> some View {
        HStack(alignment: .top) {
            Text(key).foregroundStyle(.secondary)
            Spacer()
            Text(value).multilineTextAlignment(.trailing)
        }
        .font(.subheadline)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }
}
