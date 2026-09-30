# Fieldwatch

Festival safety-alert app. iPhone-only for users, no accounts, offline-first. Pick a festival, get channels: Weather (alerts, hourly forecast, a 12-hour radar loop), Festival official, Incidents, Attendee relay, Live audio (where a feed exists). "Fieldwatch" is a working name.

This repo was scaffolded in a chat session on a phone, then worked over in a Claude Code cloud session that had no Xcode. **The Swift has still never been compiled.** It has been read line by line for compile errors (see `docs/roadmap.md`, item 1, for what was fixed and what to expect), but the first job on a Mac is still: generate the Xcode project, build, and fix whatever the compiler finds. The backend and node run and have test suites.

## Layout

| Path | What | Status |
|---|---|---|
| `ios/` | SwiftUI app, iOS 17+, XcodeGen spec | written and reviewed, not compiled |
| `backend/` | Node 20 + Express + SQLite. NWS poller, APNs push, incidents, the festival list (curated seed; Ticketmaster, SeatGeek and Edmtrain imports; Wikidata plus each festival site's schema.org JSON-LD, robots honoured; feed URLs; community suggestions with moderation) | runs; `npm test` covers every route with a mocked NWS |
| `node/` | Raspberry Pi receiver: trunk-recorder + on-device Whisper + local API + uploader | runs; `python3 test_uploader.py`; never run against a real SDR |
| `web/` | The app in a browser: opens on the festival you are at or on your own spot, live NWS alerts, forecast with heat/gust/thunder panels and a day-by-day outlook, the radar loop, web push warnings, AirDrop warn-people-near-you, share with a QR code, hazard reports, staff screens (post, moderate, sources) | runs; `npm test` drives it in headless Chromium against fixture responses and a fake backend |
| `prototype/index.html` | Tap-through HTML prototype of every screen. Source of truth for UX | done |
| `docs/decisions.md` | Why the product is shaped this way, including the legal lines | read this first |
| `docs/roadmap.md` | Open items in priority order | |
| `docs/feature-set.md` | The complete feature set: live, next, later, not doing | |

## Commands

```
# backend
cd backend && npm install && cp .env.example .env && npm run seed && npm start
curl localhost:3000/festivals
npm test                      # node:test, no network: api.weather.gov is a fixture

# ios (needs macOS + Xcode 15+)
brew install xcodegen
cd ios && xcodegen generate && open Fieldwatch.xcodeproj

# node (on a Pi; on a dev machine you can run uploader.py directly)
cd node && cp node.env.example node.env && python3 uploader.py
python3 test_uploader.py      # stdlib only; whisper is stubbed, the backend is a fake server

# web
cd web && npm start           # http://localhost:8090; any static host works
npm install && npm test       # headless Chromium against fixture NWS and radar responses
```

`backend/.env` is read by `src/env.js` (Node 20.12+, `process.loadEnvFile`); variables already in the environment win. `npm start` runs `src/server.js`, which is only the listener; the Express app lives in `src/app.js` so tests can import it without binding a port.

## Architecture in one paragraph

The phone downloads a **festival pack** (`FestivalPack`: festival, alerts, posts, hourly forecast, incidents) once and works from disk after that. While online it polls the backend for alerts/posts/incidents and NWS directly for the hourly forecast, and falls back to NWS directly for alerts if the backend is down. The backend polls NWS for every festival that is on (grounds open, a week before gates or `groundsOpen`, to 1 day after the end), stores alerts, and pushes new ones over APNs with the full alert JSON in the payload so the detail screen opens offline, and over Web Push (`webpush.js`, VAPID) to browsers that switched warnings on, with a link that opens the web build on that alert. It also reads each live festival's hourly forecast and grid every 20 minutes and, up to `HEADS_UP_HOURS` before the forecast turns stormy, windy, wet or dangerously hot, stores and pushes a **heads-up** of its own (`incoming.js`, channel `headsup`, one per window) with the time it starts and what to do first; the web build shows the same thing as a countdown card under the sky and a prep screen (shelter, camp, timeline, what to pack). **Lightning** (`lightning.js`) reads the GOES lightning mapper's 20-second files from NOAA's public S3 buckets every minute while a festival is on (h5wasm reads the NetCDF-4 in Node) and grades each festival red, orange, yellow or green by the nearest flash (8, 15, 30 miles); red is pushed as a severe alert (channel `lightning`) that ends 30 minutes after the last flash within 8 miles, and the web build shows the code on the festival page, the home page and a screen of its own. Phones relay warning-level alerts to each other over MultipeerConnectivity (`RelayService`). A **receiver node** on site records county public-safety radio, transcribes, keeps only hazard traffic, serves it on its own Wi-Fi (`_fieldwatch-node._tcp` over Bonjour) and uploads to the backend. Pairing a phone with the node is joining its Wi-Fi; `NodeDiscovery` does the rest. Both the backend and the node are plain http on a local network, so `project.yml` sets `NSAllowsLocalNetworking`. **The web build** (`web/index.html`) is the same app for a browser: it reads `festivals.json` and then the backend's live list when one is set, asks NWS and the radar archive directly (or a backend when one is configured, with NWS as the fallback) and caches everything in the browser. **Radar** (`backend/src/radar.js`) fetches one NEXRAD composite image per 10 minutes for the last 12 hours from the Iowa Environmental Mesonet WMS-T archive, for a fixed Web Mercator square around each in-window festival, caches the frames on disk (they never change) and serves a manifest plus the PNGs; the phone (`RadarStore`, `RadarView`) keeps the frames on disk and draws them as an `MKOverlay` on MapKit, so the last loop plays offline.

## Shared data shapes

`Festival` records come from `backend/src/festivals.js` (`normalizeFestival`), whatever the source: the curated seed, the Ticketmaster, SeatGeek and Edmtrain APIs, Wikidata plus each festival site's schema.org JSON-LD (`backend/src/importers/wikidata.js`, a polite crawler: robots.txt honoured, redirects followed by hand, public DNS names only, off until `NWS_USER_AGENT` is a real contact), feed URLs and community suggestions. `SafetyAlert`, `Incident` and `RadarLoop` are defined in `ios/Fieldwatch/Models/Models.swift` and produced by `backend/src/nws.js`, `backend/src/app.js` (`incidentToAlert`), `backend/src/radar.js` (`radarLoop`) and `node/uploader.py`. `web/index.html` consumes all three and re-implements the NWS normalizer, the radar square and the incoming-weather logic (`backend/src/incoming.js`: the thresholds, the camp lists and the timing lines are copied into `incoming`, `PREP` and `timing` in the web build); change them in step. Keep them in sync by hand; there's no codegen. Dates are ISO 8601; the Swift decoder accepts with or without fractional seconds, the backend emits without (`util.js: iso()`).

Hazard categories live in two places on purpose (node must classify offline): `backend/src/incidents.js` and the `CATEGORIES` list in `node/uploader.py`. Change both, and add a line to `backend/test/fixtures/hazard-samples.json`; both test suites run every sample through their own classifier, so a drift fails one of them.

## Rules that are not up for debate

- No accounts, no login, no analytics that identify a person. Phones register only an APNs token + festival id.
- The receiver node records **county public-safety radio only**. Never the festival's operations channels without the promoter's written OK. See `docs/decisions.md`.
- Do not integrate Broadcastify. They are not licensing new scanner-style mobile apps.
- Only hazard traffic is stored. Non-matching calls are deleted, audio included. Redaction (`redact()`) runs before storage.
- Attendee reports always go through the moderation queue. Never auto-publish them.
- No festival name, coordinates or date goes into `backend/data/festivals.json` without a `source` URL. Coordinates must be the grounds, not the town. Imported and suggested festivals carry their source URL too, and never overwrite a curated record.
- Only festivals that are on are listed, polled and watched: grounds open (a week before gates, or `groundsOpen`) through the day after the end. `isLive` in `backend/src/festivals.js` and `web/index.html` must agree.

## Conventions

- Swift: iOS 17, `@Observable`, one `AppState` as source of truth, views read from it, `Route` enum for navigation. No third-party packages so far. Anything an `@Observable` class mutates off the main thread, or declares `lazy`, is marked `@ObservationIgnored`.
- Backend: ESM, no build step, prepared statements in `db.js` only, all env in `.env.example`, async routes wrapped so a rejected promise becomes a JSON 500 instead of a crash. Tests are `node:test` in `backend/test/`.
- Node: one file, stdlib plus faster-whisper. Anything that must be testable without hardware is a function (`process_call`, `upload_once`), and the loops just call them.
- Copy in the UI is sentence case, plain, short. The prototype has the reference wording for every screen.
- Emergency alerts from carriers (WEA) are not something we replace; the UI tells users to keep them on.

## Things to verify early

1. `NWSClient.userAgent` and `NWS_USER_AGENT` need a real contact email or NWS will block us. Nobody has hit the real API from this code yet: the cloud session's network policy blocked api.weather.gov, so the normalizer is only proven against a fixture.
2. Festival names, venues and dates in `backend/data/festivals.json` were confirmed against each festival's own site on 2026-09-27 (`source`, `verifiedOn`). Coordinates are venue centroids typed from memory; drop a pin on each before relying on polygon-based NWS alerts.
3. `web/festivals.json` is a copy of that file; a backend test fails if they differ.
4. `project.yml` bundle id prefix. `FieldwatchBackendURL` is the Railway deployment; the web build's `DEFAULT_BACKEND` is the same address. The `aps-environment` entitlement needs a paid team; on a free team, delete the `entitlements:` block to build to a device (the simulator doesn't care).
5. APNs needs a paid developer account; until then the in-app banner covers the demo. The server starts fine without the keys.
7. Lightning has never read a real GLM file either (same network policy): `backend/test/lightning.test.js` writes files the way NOAA lays them out (with h5wasm) and the reader is proven on those. The first live run should confirm the bucket names (`noaa-goes19` for GOES-East since April 2025, `noaa-goes18` for West; `/health` shows `lightning.buckets[].lastError`), that a real file's `flash_lat`, `flash_lon` and `flash_time_offset_of_first_event` unpack to sane values (a flash should land within a few minutes of its file's start time), and how many flashes an active day keeps in the buffer.
6. Radar has never been fetched from the real archive by this code either (same network policy). The WMS parameters (`n0q-t.cgi`, layer `nexrad-n0q-wmst`, `EPSG:3857`, `TIME=`) follow the IEM documentation; the first real run should confirm a frame decodes and lines up with the map, and that a 10-minute lag is enough for the newest timestamp to exist.
