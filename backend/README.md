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
| GET | `/festivals` | List of festivals (the picker) |
| GET | `/festivals/:id` | One festival |
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

`data/festivals.json` is the curated list. There's no clean public feed of every festival in the country, and scraping aggregators breaks their terms, so this is hand-maintained (or edited live through `PUT /festivals/:id`). Coordinates need to be the actual grounds, not the town: NWS alerts are polygon-based.

`feeds` holds public audio streams you have permission to relay. Broadcastify is not licensing new scanner apps, so leave this empty unless a feed owner has agreed.

## Deploying

Any host that runs Node and keeps a disk works (Fly.io, Railway, a small VPS). Mount a volume for `DB_PATH` and `AUDIO_DIR`. Run one instance; the poller isn't built to coordinate across several. Behind a proxy, set `TRUST_PROXY` to the hop count so the report rate limit sees phones, not the load balancer.

Push is optional: leave the `APNS_*` lines commented out until there's a key, and the server starts without it (alerts are stored and served, just not pushed).

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
