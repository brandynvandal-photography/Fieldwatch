import SwiftUI

struct OfficialView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        List {
            if let festival = app.selectedFestival {
                if festival.isPartner {
                    Section("Updates") {
                        if app.posts.isEmpty {
                            Text("Nothing posted yet.").foregroundStyle(.secondary)
                        }
                        ForEach(app.posts) { post in
                            VStack(alignment: .leading, spacing: 3) {
                                Text(post.title).font(.headline)
                                Text(post.body).font(.subheadline).foregroundStyle(.secondary)
                                Text(post.postedAt.formatted(.relative(presentation: .named))).font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 2)
                        }
                    }
                } else {
                    Section {
                        VStack(alignment: .leading, spacing: 4) {
                            Text("This festival hasn't joined yet").font(.headline)
                            Text("When it does, staff updates and evacuation notices show up here. The site info below came with your download.")
                                .font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 4)
                    }
                }
                Section("On site") {
                    ForEach(festival.site) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.title).font(.headline)
                            Text(item.detail).font(.subheadline).foregroundStyle(.secondary)
                        }
                        .padding(.vertical, 2)
                    }
                }
            }
        }
        .navigationTitle("Festival official")
        .onAppear { app.seenOfficial = true }
    }
}
