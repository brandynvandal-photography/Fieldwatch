# Roadmap

Priority order. Each item is sized for one Claude Code session.

1. **Compile the iOS app.** `xcodegen generate`, build, fix errors. A no-Xcode session already fixed what it could find by reading: `SWIFT_VERSION` was `5.9` (not a language mode; now `5.0`), `RelayService`'s `lazy var`s and off-main bookkeeping are `@ObservationIgnored`, `NodeDiscovery`'s browser and probe likewise, `AppDelegate` registers for push on the main actor, and `NSAllowsLocalNetworking` is set so `http://localhost:3000` and a node's `http://` API are reachable at all. Still worth a look if the compiler complains: switch expressions in `Models.swift` and the views (valid Swift 5.9+, need Xcode 15), `@Observable` on the `NSObject` subclass `RelayService`, and Sendable warnings around `AppDelegate`.
2. **Run against real NWS.** Set the User-Agent, pick a festival, confirm alerts and hourly decode. Check a real alert with `ends: null` (the fixture in `backend/test/fixtures/nws.js` covers it, reality may differ).
3. **Push end to end.** APNs key on the backend, device registration, tap-to-open into `AlertDetailView` with no network.
4. **Relay test on two devices.** Airplane mode on one, Bluetooth on, warning triggered on the other.
5. **Receiver node on real hardware.** Pi 5 + RTL-SDR V4, one county P25 system from RadioReference. Measure Whisper latency (target under 60 s per call on a Pi 5). Confirm Bonjour discovery from an iPhone on the hotspot. Check that the uploader can delete what trunk-recorder (root, in Docker) wrote: `setup.sh` sets a default ACL on `recordings/` for this and the uploader logs one clear line if it can't; neither has been tried on a Pi.
6. **Hazard rules against real traffic.** `fire` matches any call that says "fire", which on a fire/EMS dispatch talkgroup is most of them; `redact()` turns road names like "CR 136" into `[plate]`. Tune against a day of recordings, and add each decision to `backend/test/fixtures/hazard-samples.json`.
7. **Moderation UI.** The backend has the queue endpoints; there is no screen. A tiny web page with an admin key is enough.
8. **Festival official dashboard.** Same: a web page that hits `POST /festivals/:id/posts`.
9. **Offline map in the pack.** Medical, water, exits, harm reduction. Needs real site data from each festival; the schema (`SiteItem`) exists.
10. **Pack downloads with a map tile bundle.** Optional; the prototype promises "site map" and the pack doesn't carry one yet.
11. **App Store review notes.** Explain the Bonjour service, local network permission, background audio, and that scanner content is public-safety radio only. Drop `fetch` from `UIBackgroundModes` and the location usage string unless something starts using them.

Explicitly out of scope: any attempt to receive RF on the phone, Broadcastify integration, recording festival ops radio without consent, accounts.
