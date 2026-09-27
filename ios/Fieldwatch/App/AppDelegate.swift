import UIKit
import UserNotifications

/// Handles APNs registration and notification taps. Push needs a paid
/// developer account and the backend's APNs key; everything else works without it.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    var app: AppState?

    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            Task { @MainActor in UIApplication.shared.registerForRemoteNotifications() }
        }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        let token = deviceToken.map { String(format: "%02x", $0) }.joined()
        UserDefaults.standard.set(token, forKey: "apnsToken")
        Task { @MainActor in
            try? await app?.backend.registerDevice(token: token, festivalID: app?.selectedFestival?.id)
        }
    }

    /// Show the system banner even while the app is in the foreground.
    func userNotificationCenter(_ center: UNUserNotificationCenter,
                                willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    /// The backend puts the full alert in the payload so the detail screen opens with no network.
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let json = response.notification.request.content.userInfo["alert"] as? String,
              let alert = try? JSONDecoder.fieldwatch.decode(SafetyAlert.self, from: Data(json.utf8)) else { return }
        await MainActor.run { app?.receive(alert) }
    }
}
