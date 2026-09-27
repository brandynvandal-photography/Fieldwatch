# Fieldwatch iOS

SwiftUI scaffold for the festival alert app. iOS 17+, no accounts, offline-first.

## Open it

1. `brew install xcodegen`
2. In this folder: `xcodegen generate`
3. Open `Fieldwatch.xcodeproj`, pick your team under Signing.
4. Change `bundleIdPrefix` and `FieldwatchBackendURL` in `project.yml` and regenerate whenever they change.

Prefer not to use XcodeGen? Make a new iOS App project in Xcode named Fieldwatch, delete its ContentView, drag the `Fieldwatch` folder in, then add the Info.plist keys and the `aps-environment` entitlement listed in `project.yml`.

On a free (personal) team the `aps-environment` entitlement stops the app installing on a device; delete the `entitlements:` block from `project.yml` until you have a paid account. The simulator doesn't care.

`project.yml` allows plain-http local networking (`NSAllowsLocalNetworking`). Without it neither `http://localhost:3000` nor a receiver node's API would load; a deployed backend should still be https.

This code has been reviewed but never compiled. Expect the first build to turn up something; `docs/roadmap.md` item 1 lists the likely spots.

## What's here

- `App/` entry point, routing enum, and the APNs delegate
- `Models/` festival, alert, pack, and forecast types shared with the backend
- `Services/` NWS client, backend client, on-disk pack store, network monitor, Bluetooth relay (MultipeerConnectivity)
- `State/AppState.swift` the single source of truth; every view reads from it
- `Views/` one file per screen, matching the prototype

## Running without the backend

The app still works: pick a festival from the cached list (empty on first run until the backend answers), and `NWSClient` pulls alerts and the hourly forecast straight from api.weather.gov. Set a real contact in `NWSClient.userAgent`; NWS blocks anonymous clients.

## Testing the relay

Run on two devices (or one device plus the simulator on the same Wi-Fi). Turn airplane mode on for one, keep Bluetooth on, and pull-to-refresh on the other while a warning is active. The banner should appear on the offline phone within a few seconds.

## Push

Needs a paid developer account. Create an APNs key in the developer portal and give it to the backend. Until then, everything except push works, including the in-app banner.

## Incidents and the on-site receiver

The Incidents channel shows safety-relevant county dispatch traffic and attendee reports. Where it comes from:

- The backend (`/festivals/:id/incidents`) when the phone has data.
- A receiver node on site (see `fieldwatch-node`) when the phone is on the node's Wi-Fi, even with no internet.

Pairing with a receiver is just joining its Wi-Fi. The node advertises `_fieldwatch-node._tcp` over Bonjour; `NodeDiscovery` picks it up, checks `/health` to make sure it's for the same festival, and polls `/incidents` every 20 seconds. The Incidents screen and Settings both show when a receiver is connected. Nothing to type, no codes.

Warning-level incidents (weather holds, evacuations, security) pop the same banner as a weather alert and are relayed over Bluetooth to nearby phones, so one phone in Wi-Fi range of the node can carry an incident to the far end of the campground.
