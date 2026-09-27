import SwiftUI

@main
struct FieldwatchApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @State private var app = AppState()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .onAppear { delegate.app = app }
                .task { await app.start() }
        }
    }
}

/// Every screen the app can push. Alerts carry their own value so a tapped
/// notification or banner can deep-link straight to the detail screen.
enum Route: Hashable {
    case weather, official, incidents, relay, audio, settings
    case alert(SafetyAlert)
}

struct RootView: View {
    @Environment(AppState.self) private var app
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if app.selectedFestival != nil {
                    ChannelsView(path: $path)
                } else {
                    FestivalPickerView()
                }
            }
            .navigationDestination(for: Route.self) { route in destination(route) }
        }
        .overlay(alignment: .top) { IncomingAlertBanner(path: $path) }
        .animation(.default, value: app.selectedFestival?.id)
    }

    @ViewBuilder
    private func destination(_ route: Route) -> some View {
        switch route {
        case .weather: WeatherView()
        case .official: OfficialView()
        case .incidents: IncidentsView()
        case .relay: RelayView()
        case .audio: LiveAudioView()
        case .settings: SettingsView()
        case .alert(let alert): AlertDetailView(alert: alert)
        }
    }
}
