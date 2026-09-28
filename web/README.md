# Fieldwatch on the web

The same app for a browser, for people who won't install anything and for testing the data paths without a Mac. Same festivals, same sources, same shapes as the iPhone app.

## Run it

```
cd web && npm start          # python3 -m http.server 8090
open http://localhost:8090
```

Any static host works (GitHub Pages, Netlify, an S3 bucket). The site is `index.html`, `festivals.json`, `sw.js`, `manifest.webmanifest` and the icons; `.github/workflows/pages.yml` at the project root deploys exactly those to GitHub Pages on every push to `main` once Fieldwatch is in a public repository of its own, and turns Pages on by itself on the first run.

It installs: on an iPhone, Share then "Add to Home Screen" gives a full-screen app with its own icon, and the service worker keeps the shell opening with no signal (an update lands on the next refresh). The display face is Bricolage Grotesque from Google Fonts with the system face as fallback; everything else is inline. `festivals.json` is a copy of `backend/data/festivals.json`; a backend test fails if the two drift.

## The interface

One loud element per screen. The home screen's status card answers "am I safe right now" in colour, carries the next six hours, and adds one line derived from the forecast. The forecast is two aligned single-measure panels (temperature curve with a scrub-to-read tooltip, chance-of-rain bars), never a dual axis. Alert detail leads with what to do, then the NWS bullets as sections. Radar has crossfading frames, a stamp with time and age, and a scrubber with hour ticks. Dark theme is designed, not inverted; motion respects reduced-motion; everything is keyboard focusable. Change `icon.svg` and re-render the PNGs (`test/` has the Chromium harness) rather than editing the PNGs.

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
