import SwiftUI

struct FestivalPickerView: View {
    @Environment(AppState.self) private var app
    @State private var query = ""
    @State private var downloading: Festival?
    @State private var errorMessage: String?

    private var filtered: [Festival] {
        guard !query.isEmpty else { return app.festivals }
        return app.festivals.filter {
            $0.name.localizedCaseInsensitiveContains(query) || $0.location.localizedCaseInsensitiveContains(query)
        }
    }
    private var soon: [Festival] { filtered.filter { $0.startDate.timeIntervalSinceNow < 8 * 86_400 } }
    private var later: [Festival] { filtered.filter { $0.startDate.timeIntervalSinceNow >= 8 * 86_400 } }

    var body: some View {
        List {
            if !soon.isEmpty {
                Section("Next weekend") { ForEach(soon, content: row) }
            }
            if !later.isEmpty {
                Section("Coming up") { ForEach(later, content: row) }
            }
            if filtered.isEmpty {
                ContentUnavailableView.search(text: query)
            }
        }
        .navigationTitle("Which festival?")
        .searchable(text: $query, prompt: "Search festivals")
        .toolbar {
            NavigationLink(value: Route.settings) { Image(systemName: "gearshape") }
        }
        .overlay {
            if let downloading { DownloadOverlay(festival: downloading) }
        }
        .alert("Couldn't download", isPresented: Binding(get: { errorMessage != nil }, set: { if !$0 { errorMessage = nil } })) {
            Button("OK") { errorMessage = nil }
        } message: {
            Text(errorMessage ?? "")
        }
    }

    private func row(_ festival: Festival) -> some View {
        Button {
            Task { await pick(festival) }
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(festival.name).font(.headline)
                    Text(festival.location).font(.subheadline).foregroundStyle(.secondary)
                }
                Spacer()
                VStack(alignment: .trailing, spacing: 2) {
                    Text(festival.dateRange).font(.subheadline.weight(.semibold))
                    if app.savedPackIDs.contains(festival.id) {
                        Text("Saved").font(.caption).foregroundStyle(.secondary)
                    }
                }
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.vertical, 4)
        }
        .foregroundStyle(.primary)
    }

    private func pick(_ festival: Festival) async {
        downloading = festival
        do {
            try await app.select(festival)
        } catch {
            errorMessage = "Check your connection and try again."
        }
        downloading = nil
    }
}

struct DownloadOverlay: View {
    let festival: Festival

    var body: some View {
        VStack(spacing: 12) {
            ProgressView().controlSize(.large)
            Text("Getting \(festival.name) ready for offline").font(.headline)
            Text("Map, forecast, medical and water spots.").font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(28)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20))
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black.opacity(0.2))
    }
}
