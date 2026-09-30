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
| POST | `/festivals/:id/hide`, `/unhide` | Take a listing the importers got wrong out of every list, or put it back; an import keeps a hidden record hidden (admin key) |
| DELETE | `/festivals/:id` | Remove a festival (admin key) |
| POST | `/admin/import` | Start an import of every source now; answers 202 at once with `{started, running, last}`, and `GET` shows the report when it finishes (admin key) |
| GET | `/festivals/:id` | One festival (a pending one only with the admin key) |
| GET | `/festivals/:id/pack` | Offline pack: festival, active alerts, posts, hourly forecast |
| GET | `/festivals/:id/alerts` | Active NWS alerts, polled on demand if stale |
| GET | `/festivals/:id/radar` | Radar loop manifest: bounds, and one immutable URL per frame (see Radar) |
| GET | `/radar/:festivalId/:frame.png` | One radar frame, cached for a week |
| GET | `/festivals/:id/posts` | Staff updates |
| POST | `/festivals/:id/posts` | Staff update (admin key); pushes to subscribers |
| PUT | `/festivals/:id` | Add or edit a festival (admin key) |
| GET | `/festivals/:id/qr.svg` | A QR code that opens the web build on this festival (print it at the gate) |
| GET | `/push/vapid` | The public VAPID key the web build subscribes with; 404 until keys are set |
| POST | `/push/subscribe` | `{ subscription, festivalId }` a browser signs up for one festival's warnings, or `{ subscription, point: { latitude, longitude } }` for wherever it is; either way one test notification comes straight back |
| GET | `/admin/import` | The last festival import report, plus `running` while one is in progress (admin key) |
| GET | `/health` | Open it in a browser when the app cannot reach the backend: build, uptime, where the database is, which sources have keys, whether an import ran. No secrets |
| DELETE | `/push/subscribe` | `{ endpoint }` and it stops |
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
5. Every 20 minutes it also reads each live festival's hourly forecast and grid (`incoming.js`). When the next twelve hours turn stormy (thunder 30%+), windy (gusts 35 mph+), wet (rain 60%+) or dangerously hot (heat index 100+) and the start is within `HEADS_UP_HOURS` (default 3), it stores a heads-up of its own (`channel: "headsup"`, severity moderate, `onset` = when it starts, expires when the window ends) and pushes it once per window: "Storms expected around 5:00 PM", then what to do with the time there is and where to shelter. A watch or warning NWS already issued for the same thing is left to speak for itself. NWS never lists our heads-ups, so the poller does not end them; they end with the window.

The phone also polls `/alerts` when it's open, and falls back to NWS directly if this server is down.

## Festival data

Several sources feed one table, and every record passes through `normalizeFestival` in `src/festivals.js` on the way in:

- **Curated** (`data/festivals.json`): the featured list, hand-checked against each festival's own site, seeded on first boot and re-applied by `npm run seed`. Coordinates need to be the actual grounds, not the town: NWS alerts are polygon-based. These are the bubbles in the picker.
- **Ticketmaster** (`src/importers/ticketmaster.js`, needs `TICKETMASTER_KEY`, free at developer.ticketmaster.com): a daily walk through the next twelve months of US music listings, three nets: anything with "festival" in its text, anything Ticketmaster itself styles a festival (plus any listing with four or more acts), and everything Front Gate sells, which counts as a festival without a name check because Front Gate sells festivals and little else. The first two nets span every source behind the API, Universe included, which is where small self-serve festivals turn up. The report counts listings per ticket site (`hosts`) so the first real run shows what each net caught. Per-day and multi-day-pass listings fold into one festival, parking and camping add-ons are dropped, and a listing that matches a festival from another source (same grounds on overlapping dates, or the same name) is skipped, so a curated record is never overwritten by a ticket page. A listing that vanishes before it starts is treated as cancelled and removed; imports that ended a month ago are pruned. Around a hundred calls a run.
- **SeatGeek** (`src/importers/seatgeek.js`, needs `SEATGEEK_CLIENT_ID`, free at seatgeek.com/account/develop): every upcoming US listing in SeatGeek's `music_festival` taxonomy, folded the same way. Reaches a lot of ticketing Ticketmaster does not carry, including smaller independents. A few calls a run.
- **Edmtrain** (`src/importers/edmtrain.js`, needs `EDMTRAIN_KEY` from edmtrain.com/developer-api): every upcoming US festival on Edmtrain in one request, the electronic side of the calendar. Their API terms are honoured in the data model: each event's link is stored as the record's `source` and shown as given, the data is never resold, and the key stays on the server.
- **Wikidata** (`src/importers/wikidata.js`, no key, on by default; `WIKIDATA_IMPORT=false`, `0` or `no` turns it off, and it skips itself, saying so in the report, until `NWS_USER_AGENT` is a real contact rather than the `example.com` placeholder): every US festival on Wikidata with coordinates and an official website, from two SPARQL queries (every kind of festival, then the US instances of those kinds a few hundred kinds at a time, not dissolved; two items sharing a site count once, the lower id). Wikidata rarely knows this year's dates, so the importer reads each festival's own homepage for the schema.org JSON-LD sites publish for search engines (`Festival`, `MusicEvent`, `Event`, `@graph` included; cancelled, postponed and moved-online blocks skipped) and takes the dates from there: per-day blocks of one name fold into one festival, only the first fortnight a page announces counts (so this autumn's edition does not run into next spring's), an edition more than a year out is ignored, and the page's coordinates are used when they are within 50 km of Wikidata's, else Wikidata's. It is a polite crawler: robots.txt is honoured (the group naming our product token, else `*`; wildcards and `$` as written; a 5xx robots.txt is an error for that site, not permission), redirects are followed by hand (five at most, robots.txt read again on every new origin), nothing but a public DNS name is ever fetched (no IP literals, localhost or `.local`), at most `WIKIDATA_MAX_SITES` (250) sites a run with `WIKIDATA_PAUSE_MS` (400) between them, sites never seen first and then the ones checked longest ago, 8 s and 1 MB per page, and each site's result is kept in the settings table (`wikidata:sites`) for `WIKIDATA_CACHE_DAYS` (6), so a daily run only reads sites it has not seen lately. Ids carry the item (`wd-q123-riverfest-2026`), the site is the record's `source` and `website`, the item id is kept as `wikidata`, and a bad site keeps what it said last time and counts as an error without stopping the run or holding back pruning; only a failed query does that.
- **What stays out** (`src/names.js`): names come down to the festival (no day, pass, lineup, age note or year, so "Rock The South - Thursday - with Zach Top" folds into Rock The South); SeatGeek listings need a festival word in the name, a performer that is the festival, the placeholder start time a multi-day event gets, or three acts on the bill; tours, tributes and concerts without "fest" in the name, cancelled shows, kick-off shows, afterparties and car registration are dropped; anything outside the National Weather Service area is refused everywhere. Two records within 8 km on overlapping dates with the same core name are one festival. Staff hide the rest from the app's All festivals screen.
- **Feeds** (`src/importers/feeds.js`, `FESTIVAL_FEEDS`): your own CSV or JSON, anywhere that serves a file, for example a Google Sheet published to the web as CSV. Columns can be sheet-style (`Festival, Where, Lat, Lon, First day, Last day, Website`); a bare date means the whole day. Rows are trusted, so this is how a maintainer edits the list from a phone.
- **Community** (`POST /festivals`): the small independent ones no feed knows about. Anyone can send a name, a place and dates from the web build; it sits in the moderation queue until an admin approves it there. Nothing a stranger sends becomes a partner feed or a site map.

On Railway, attach a Volume to the service (service menu, Attach Volume; any mount path). The backend sees `RAILWAY_VOLUME_MOUNT_PATH` and keeps the database, radar frames and clips there, so a redeploy keeps the push keys, subscriptions, admin edits and reports. Without one, every deploy starts empty: the festival list re-imports itself, and phones that had warnings on register again, quietly, the next time the app opens (`POST /push/subscribe` with `quiet: true`).

Imports run at boot and every `IMPORT_HOURS` (24) when a source is configured, or on demand with `POST /admin/import` or `node src/importers/index.js`. They run widest first (Ticketmaster, SeatGeek, Edmtrain, Wikidata, feeds), and a festival that several sites list is kept once, from the first that listed it. The shared folding and write path is `src/importers/common.js`.

**What is listed.** `GET /festivals` returns only festivals that are on: from the grounds opening until the day after the end. Grounds open `LEAD_DAYS` (7) before gates for early entry, vendors and build crews, or on the record's own `groundsOpen` date when it has one. There is no point in a platform for alerts about a place nobody is at yet. The same window decides which festivals the poller watches and the radar loop pre-fetches (only featured ones and any a phone asked about in the last day; the rest fetch on request).

`feeds` holds public audio streams you have permission to relay. Broadcastify is not licensing new scanner apps, so leave this empty unless a feed owner has agreed.

## Deploying

One Node process with a disk. Run a single instance: the poller and the radar loop are not built to coordinate across several. The `Dockerfile` here is what hosts build from, and an empty database seeds itself from `data/festivals.json` on first boot, so there is no separate seed step.

### Railway, from a phone

1. railway.com, New Project, Deploy from GitHub repo, pick `Fieldwatch`.
2. Service, Settings, Source: set Root Directory to `backend`. Railway finds the Dockerfile there. (If it is left unset, the `Dockerfile` at the repository root builds the same image, so a build never falls back to Railpack and fails on the root folder.)
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
   SEATGEEK_CLIENT_ID=your-client-id-if-you-have-one
   EDMTRAIN_KEY=your-key-if-you-have-one
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

**Web push** (warnings on a phone's Home Screen, no app store) needs nothing: the server makes a VAPID key pair on first boot and keeps it in the database on the volume. To bring your own pair, run `npm run vapid` and set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY`; set `SITE_URL` if the web build does not live at the GitHub Pages address. A subscription made against an earlier pair is dropped on the next send and the phone switches warnings on again. From then on every new warning, watch and staff post reaches every browser that switched warnings on for that festival; advisories are not pushed. A browser that follows a point instead of a festival is polled the same way: the poller asks the weather service about every distinct point (rounded to about a kilometre) that some phone follows. Dead subscriptions are dropped on the next send. The switch is in the web build's home screen; on an iPhone it works once the site is on the Home Screen (iOS 16.4+).

## Radar

`radar.js` keeps a 12-hour loop of NEXRAD base reflectivity per festival: one 512 px PNG per `RADAR_STEP_MINUTES` for a 320 km Web Mercator square around the grounds, fetched from the Iowa Environmental Mesonet WMS-T archive (`RADAR_WMS`, no key) and stored under `RADAR_DIR/<festivalId>/<timestamp>.png`. A frame never changes once it exists, so only the newest is ever fetched, the oldest is pruned as the window moves, and every phone gets the same files from this server instead of hitting the archive. Festivals in their window refresh every `RADAR_REFRESH_SECONDS`; a request for `/radar` or `/pack` kicks off a refresh in the background if one is due and answers with what is on disk. A frame the archive won't produce is retried three times and then left out.

The manifest (also inside the pack as `radar`) mirrors `RadarLoop` in Swift: `bounds` in degrees, `frames` oldest first with relative URLs, `attribution` that the app must display. Newest frame is at least ten minutes old; that is how long the composite takes to land.

## Lightning

`lightning.js` grades lightning at every festival that is on from the GOES-R Geostationary Lightning Mapper. NOAA publishes every 20-second flash file (`GLM-L2-LCFA`) on public S3 buckets (`GLM_BUCKETS`, default `noaa-goes19,noaa-goes18`: GOES-East and GOES-West, no key, no signing) a minute or two after the fact. Every `LIGHTNING_SECONDS` (60) the server lists the current hour on each bucket, fetches the files it has not seen (newest first, 30 at most per pass), reads `flash_lat`, `flash_lon` and `flash_time_offset_of_first_event` with h5wasm (NetCDF-4 is HDF5; no native build), keeps the flashes within 40 miles of a live festival for 30 minutes, and grades: **red** a flash within 8 miles in the last 30 minutes (all clear 30 minutes after the last one; stale data never clears a red), **orange** nearest flash in the last 15 minutes 8 to 15 miles out, **yellow** 15 to 30, **green** nothing within 30 miles in the last 15 minutes, **none** no data in the last 5 minutes. A turn to red is stored and pushed as a severe alert (`channel: "lightning"`, id `lightning-<festival>-<minute>`) whose `expiresAt` moves out with every new flash within 8 miles. `GET /festivals/:id/lightning` returns the grade (also in the pack as `lightning` and on each `/alerts` item), `/health` has `lightning` with per-bucket counts and the last error. Nothing runs while no festival is on; `LIGHTNING=false` turns it off. The mapper sees cloud tops at about 8 km and misses some flashes under a thick anvil, so the app says the festival's own lightning vendor is the authority.

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
