# Fieldwatch backend

Node 20, Express, SQLite. Watches the National Weather Service for every festival in its window, stores alerts, and pushes new ones to subscribed phones. No user accounts anywhere; phones register only an APNs token and a festival id.

## Run it

```
npm install
cp .env.example .env        # edit ADMIN_KEY, NODE_KEY and NWS_USER_AGENT at minimum
npm run seed                # loads data/festivals.json
npm start
npm test                    # every route, with api.weather.gov replaced by a fixture
```

`.env` is picked up automatically (Node 20.12+); anything already in the environment wins. Then point the iOS app at it: set `FieldwatchBackendURL` in `project.yml`.

`src/server.js` only listens and starts the poller. The routes are in `src/app.js`, which the tests import directly.

## Endpoints

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | `{ ok, at }` |
| GET | `/festivals` | What is on right now (the picker): grounds open through the day after the end. `?all=1` for every published festival |
| POST | `/festivals` | Anyone suggests a festival; it waits for an admin. 3 an hour per address |
| GET | `/festivals/pending` | Suggestions waiting (admin key) |
| POST | `/festivals/:id/approve` | Publish a suggestion, with optional edits in the body (admin key) |
| DELETE | `/festivals/:id` | Remove a festival (admin key) |
| POST | `/admin/import` | Run the Ticketmaster and feed imports now; returns the report (admin key) |
| GET | `/festivals/:id` | One festival (a pending one only with the admin key) |
| GET | `/festivals/:id/pack` | Offline pack: festival, active alerts, posts, hourly forecast |
| GET | `/festivals/:id/alerts` | Active NWS alerts, polled on demand if stale |
| GET | `/festivals/:id/radar` | Radar loop manifest: bounds, and one immutable URL per frame (see Radar) |
| GET | `/radar/:festivalId/:frame.png` | One radar frame, cached for a week |
| GET | `/festivals/:id/posts` | Staff updates |
| POST | `/festivals/:id/posts` | Staff update (admin key); pushes to subscribers |
| PUT | `/festivals/:id` | Add or edit a festival (admin key) |
| POST | `/devices` | `{ token, festivalId }` subscribe a phone |
| DELETE | `/devices/:token` | Unsubscribe |

Admin calls send `x-admin-key: <ADMIN_KEY>`. Errors are always JSON (`{ error }`), including malformed bodies and unknown paths. Staff posts take an optional `severity` (`unknown`, `minor`, `moderate`, `severe`, `extreme`; default `minor`) that maps onto the same scale as NWS alerts.

Post a staff update:

```
curl -X POST localhost:3000/festivals/dusk-ridge-2026/posts \
  -H 'content-type: application/json' -H 'x-admin-key: change-me' \
  -d '{"title":"Medical tent has moved","body":"Now beside the water station at the east gate."}'
```

## How the alert pipeline works

1. `poller.js` runs every `POLL_SECONDS`. A festival is "in window" from 3 days before it starts to 1 day after it ends.
2. For each, it calls `api.weather.gov/alerts/active?point=lat,lon` and normalizes the GeoJSON into the same `SafetyAlert` shape the app uses.
3. New alert ids get stored and pushed. Alerts NWS stops listing get an `expiresAt` of now, so phones drop them on their next refresh.
4. The push payload carries the full alert as JSON, so a tapped notification opens the detail screen even with no network.

The phone also polls `/alerts` when it's open, and falls back to NWS directly if this server is down.

## Festival data

Four sources feed one table, and every record passes through `normalizeFestival` in `src/festivals.js` on the way in:

- **Curated** (`data/festivals.json`): the featured list, hand-checked against each festival's own site, seeded on first boot and re-applied by `npm run seed`. Coordinates need to be the actual grounds, not the town: NWS alerts are polygon-based. These are the bubbles in the picker.
- **Ticketmaster** (`src/importers/ticketmaster.js`, needs `TICKETMASTER_KEY`, free at developer.ticketmaster.com): a daily walk through the next twelve months of US music listings, two nets (anything with "festival" in its text, anything Ticketmaster itself styles a festival, plus any listing with four or more acts). Per-day and multi-day-pass listings fold into one festival, parking and camping add-ons are dropped, and a listing that matches a festival from another source (same grounds on overlapping dates, or the same name) is skipped, so a curated record is never overwritten by a ticket page. A listing that vanishes before it starts is treated as cancelled and removed; imports that ended a month ago are pruned. Around a hundred calls a run.
- **Feeds** (`src/importers/feeds.js`, `FESTIVAL_FEEDS`): your own CSV or JSON, anywhere that serves a file, for example a Google Sheet published to the web as CSV. Columns can be sheet-style (`Festival, Where, Lat, Lon, First day, Last day, Website`); a bare date means the whole day. Rows are trusted, so this is how a maintainer edits the list from a phone.
- **Community** (`POST /festivals`): the small independent ones no feed knows about. Anyone can send a name, a place and dates from the web build; it sits in the moderation queue until an admin approves it there. Nothing a stranger sends becomes a partner feed or a site map.

Imports run at boot and every `IMPORT_HOURS` (24) when a source is configured, or on demand with `POST /admin/import` or `node src/importers/index.js`.

**What is listed.** `GET /festivals` returns only festivals that are on: from the grounds opening until the day after the end. Grounds open `LEAD_DAYS` (7) before gates for early entry, vendors and build crews, or on the record's own `groundsOpen` date when it has one. There is no point in a platform for alerts about a place nobody is at yet. The same window decides which festivals the poller watches and the radar loop pre-fetches (only featured ones and any a phone asked about in the last day; the rest fetch on request).

`feeds` holds public audio streams you have permission to relay. Broadcastify is not licensing new scanner apps, so leave this empty unless a feed owner has agreed.

## Deploying

One Node process with a disk. Run a single instance: the poller and the radar loop are not built to coordinate across several. The `Dockerfile` here is what hosts build from, and an empty database seeds itself from `data/festivals.json` on first boot, so there is no separate seed step.

### Railway, from a phone

1. railway.com, New Project, Deploy from GitHub repo, pick `Fieldwatch`.
2. Service, Settings, Source: set Root Directory to `backend`. Railway finds the Dockerfile there.
3. Add a Volume to the project and attach it to the service with mount path `/data`.
4. Service, Variables, Raw Editor, paste (fill in your own keys and contact):

   ```
   DB_PATH=/data/fieldwatch.db
   AUDIO_DIR=/data/audio
   RADAR_DIR=/data/radar
   ADMIN_KEY=a-long-random-string
   NODE_KEY=another-long-random-string
   NWS_USER_AGENT=Fieldwatch (your-contact@example.com)
   TRUST_PROXY=1
   CORS_ORIGIN=*
   TICKETMASTER_KEY=your-key-if-you-have-one
   ```

   Railway sets `PORT` itself. `NWS_USER_AGENT` is required by the weather service and must carry a way to contact you. `CORS_ORIGIN` can be narrowed to the web build's origin (for GitHub Pages, `https://<user>.github.io`) once you are done trying it from other places; the API sets no cookies, so `*` is safe.
5. Settings, Networking, Generate Domain. Open `https://<that domain>/health` and you should see `{"ok":true,...}`.
6. The web build already points at `https://fieldwatch-production.up.railway.app` (`DEFAULT_BACKEND` in `web/index.html`, and `FieldwatchBackendURL` in `ios/project.yml`). Another deployment's domain goes in the web build's Settings, or in those two places.

Deploys again on every push to `main` that touches `backend/`.

### Elsewhere

- Fly.io: `fly launch` inside `backend/`, `fly volumes create data`, mount it at `/data`, same variables. Needs the CLI, so a computer.
- Render: works with the same Dockerfile and a disk at `/data`, but the free tier sleeps between requests and the poller sleeps with it. Use a paid instance.
- A VPS: `npm ci --omit=dev`, the `.env` from `.env.example`, `node src/server.js` under systemd, nginx in front with `TRUST_PROXY=1`.

Push is optional everywhere: leave the `APNS_*` lines out until there is a key, and the server starts without them (alerts are stored and served, just not pushed).

## Radar

`radar.js` keeps a 12-hour loop of NEXRAD base reflectivity per festival: one 512 px PNG per `RADAR_STEP_MINUTES` for a 320 km Web Mercator square around the grounds, fetched from the Iowa Environmental Mesonet WMS-T archive (`RADAR_WMS`, no key) and stored under `RADAR_DIR/<festivalId>/<timestamp>.png`. A frame never changes once it exists, so only the newest is ever fetched, the oldest is pruned as the window moves, and every phone gets the same files from this server instead of hitting the archive. Festivals in their window refresh every `RADAR_REFRESH_SECONDS`; a request for `/radar` or `/pack` kicks off a refresh in the background if one is due and answers with what is on disk. A frame the archive won't produce is retried three times and then left out.

The manifest (also inside the pack as `radar`) mirrors `RadarLoop` in Swift: `bounds` in degrees, `frames` oldest first with relative URLs, `attribution` that the app must display. Newest frame is at least ten minutes old; that is how long the composite takes to land.

## Incidents

Scanner traffic and attendee reports, filtered down to hazards.

| Method | Path | Auth | What it does |
|---|---|---|---|
| GET | `/festivals/:id/incidents` | none | Published incidents from the last 48 hours |
| POST | `/festivals/:id/incidents` | `x-node-key` | A receiver node uploads one radio call (multipart: `audio`, `transcript`, `talkgroup`, `occurredAt`, `id`) |
| POST | `/festivals/:id/reports` | none | Attendee report, goes to the moderation queue, 5 attempts per 10 minutes per IP |
| GET | `/festivals/:id/incidents/pending` | admin | Moderation queue |
| POST | `/festivals/:id/incidents/:iid/publish` | admin | Publish (optionally with an edited `summary`), pushes to subscribers |
| DELETE | `/festivals/:id/incidents/:iid` | admin | Remove |
| GET | `/audio/:file` | none | The clip |

`incidents.js` holds the category rules. A call that matches none of them is dropped, audio and all. Phone numbers, plate-shaped tokens and name phrases are redacted before storage. `INCIDENT_AUTO_PUBLISH=false` sends scanner incidents to the queue too. A node's own incident id is kept when it sends one, so a phone that already saw the incident on the node's Wi-Fi doesn't get a duplicate; a re-upload of a known id is acknowledged and its audio discarded.

The rules are duplicated in `node/uploader.py`. `test/fixtures/hazard-samples.json` is run through both, so they can't drift silently.

If a node couldn't transcribe on-device, set `OPENAI_API_KEY` and the backend will run Whisper on the upload.
