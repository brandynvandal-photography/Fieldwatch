# Fieldwatch on the web

The same app for a browser, for people who won't install anything and for testing the data paths without a Mac. Same festivals, same sources, same shapes as the iPhone app.

## Run it

```
cd web && npm start          # python3 -m http.server 8090
open http://localhost:8090
```

Any static host works (GitHub Pages, Netlify, an S3 bucket): the folder is `index.html` plus `festivals.json`. `.github/workflows/pages.yml` at the project root deploys it to GitHub Pages on every push to `main` once Fieldwatch is in a public repository of its own; it turns Pages on by itself on the first run. `festivals.json` is a copy of `backend/data/festivals.json`; a backend test fails if the two drift.

## Where the data comes from

- **Alerts and hourly forecast**: the National Weather Service API, straight from the browser (it allows cross-origin requests). With a backend address saved in Settings (or `?backend=https://...`), alerts come from the backend first and fall back to NWS, exactly like the app.
- **Radar**: the last 12 hours of NEXRAD base reflectivity. Without a backend, one image every 15 minutes from the Iowa Environmental Mesonet WMS-T archive for the 320 km square around the grounds; with a backend, its cached 10-minute frames. Attribution stays on screen. OpenStreetMap tiles sit under the radar; if they don't load the square still draws.
- **Incidents and posts**: backend only.
- Everything fetched is cached in the browser, so the last good data shows with "before signal dropped" wording when the network goes.

Be polite to the archive: one browser pulling 48 frames now and then is fine; a hosted build with real traffic should point at the backend, which fetches each frame once for everyone.

## Test

```
npm install && npm test
```

Headless Chromium (the one Playwright installs; `CHROMIUM=/path/to/chrome` to use another) loads the page against fixture responses for NWS, the archive and the tile server, so it needs no network. `SHOTS=./shots npm test` also writes phone-sized screenshots of every screen.

## Inside a Claude artifact preview

The page detects the preview frame and says so: that frame blocks requests to outside hosts, so weather and radar cannot load there. The festival list still works. Host the folder anywhere else and it goes live.
