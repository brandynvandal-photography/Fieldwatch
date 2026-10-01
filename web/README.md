# Fieldwatch on the web

The same app for a browser, for people who won't install anything and for testing the data paths without a Mac. Same festivals, same sources, same shapes as the iPhone app.

The picker lists only what is on: from a week before gates (early entry, vendors, build crews) to the day after the end, the same window as `backend/src/festivals.js`. Bubbles are the featured festivals happening now, the rest a list, and the last row is "Right where you are" for anyone at a festival the list does not know.

## Run it

```
cd web && npm start          # python3 -m http.server 8090
open http://localhost:8090
```

Any static host works (GitHub Pages, Netlify, an S3 bucket). The site is `index.html`, `festivals.json`, `sw.js`, `manifest.webmanifest` and the icons; `.github/workflows/pages.yml` at the project root deploys exactly those to GitHub Pages on every push to `main` once Fieldwatch is in a public repository of its own, and turns Pages on by itself on the first run.

It installs: on an iPhone, Share then "Add to Home Screen" gives a full-screen app with its own icon, and the service worker keeps the shell opening with no signal (an update lands on the next refresh). The display face is Bricolage Grotesque from Google Fonts with the system face as fallback; everything else is inline. `festivals.json` is a copy of `backend/data/festivals.json`; a backend test fails if the two drift.

## What it does for someone at the grounds

- **Opens on your festival.** With location allowed, the picker skips itself when you are within a few miles of a festival that is on, and sorts the rest by distance. A link with `?f=<festival>` (a QR code at the gate, a pushed warning) opens there too, past the walkthrough.
- **Right where you are.** The last row of the picker. Alerts, forecast, radar and push warnings for the phone's own spot, whether or not the festival is listed: the spot is a festival of its own for the week, named by OpenStreetMap, and warnings follow it as it moves. `?here=1` opens it. This replaced adding a festival by hand.
- **Warn people near you.** On a warning, one button hands the alert text and its link to the phones around you over AirDrop (or the system share sheet), which reaches people with nothing installed and no signal.
- **Favorites.** The heart on a festival page (or its Favorite row) follows that festival's warnings on this phone: warnings, watches, heads-ups, lightning codes and staff posts arrive with the app closed. A phone can favorite several; the home page (Right now) has a Favorites section with a card for each, its lightning code beside its name (green included) and its alerts under it, then every other festival that is on with something going on under Everywhere else (never the festival you last looked at), and the festival list puts favorites in their own group at the top. On the festival page the code is on the lightning tile under the sky card. On an iPhone the warnings need the site on the Home Screen. Right after a festival is picked, one card offers the favorite (Favorite, Not now) and never asks again for that festival. A favorite of a festival that is over drops away on its own. A warning that lands while the app is open vibrates the phone and shows a banner.
- **Live.** With a backend, the page holds its event stream open (`/events`) and refreshes the festival or the feed the moment an alert, heads-up, lightning code, post or ground report lands there; its own polls (lightning every minute, everything every five) are the fallback.
- **Heat, wind, lightning.** The weather screen reads the grid behind the forecast: heat index with the 90 and 103 guides, wind gusts with the 25 and 40 mph guides crews watch for tents and stages, chance of thunder. One crosshair across all three. The home card leads with whichever matters most in the next twelve hours.
- **Day by day.** One row per festival day through the day after, and one line about what to pack.
- **Share.** A QR code (rendered by the backend) and a link that open straight on the festival.
- **Report a hazard.** What, where, your position if you allow it. It goes to the backend's moderation queue; a human checks it before it goes out.
- **Staff.** With the admin key in Settings: post an official update (it goes out as an alert and a push), review reports before they go out, and see what feeds the festival list. Settings hides the backend address, its check and the key until five taps on the credits line at the bottom, `?staff=1`, or `?backend=`; a saved key keeps them shown.

## The interface

One loud element per screen. The home screen's status card answers "am I safe right now" in color, carries the next six hours, and adds one line derived from the forecast. The forecast is two aligned single-measure panels (temperature curve with a scrub-to-read tooltip, chance-of-rain bars), never a dual axis. Alert detail leads with what to do, then the NWS bullets as sections. Radar has crossfading frames, a stamp with time and age, and a scrubber with hour ticks. Dark theme is designed, not inverted; motion respects reduced-motion; everything is keyboard focusable. Change `icon.svg` and re-render the PNGs (`test/` has the Chromium harness) rather than editing the PNGs.

## Where the data comes from

- **The backend**: this build talks to `https://fieldwatch-production.up.railway.app` (`DEFAULT_BACKEND` in `index.html`) unless Settings or `?backend=https://...` names another; `none` goes without one. Everything below still works when it is down.
- **Alerts and hourly forecast**: the National Weather Service API, straight from the browser (it allows cross-origin requests). Alerts come from the backend first and fall back to NWS, exactly like the app.
- **Radar**: the last 12 hours of NEXRAD base reflectivity. The backend's cached 10-minute frames once it holds two hours of them; until then, or without a backend, one image every 15 minutes from the Iowa Environmental Mesonet WMS-T archive for the 320 km square around the grounds. Attribution stays on screen. OpenStreetMap tiles sit under the radar; if they don't load the square still draws.
- **The festival list**: the bundled `festivals.json` at once, then the backend's live list when a backend is set (cached, so the last list shows if the backend is down). Suggesting a festival and reviewing suggestions need the backend.
- **The grid and the days**: the same weather service, `/gridpoints` for heat index, gusts and thunder and `/gridpoints/.../forecast` for the 7-day outlook. One `/points` call per festival feeds all of it.
- **Where you are**: the browser's own location, asked once on the picker; only the spot you chose to follow is kept on the phone. Nominatim (OpenStreetMap) names that spot.
- **Incidents, posts, reports, push, the QR code**: backend only.
- Everything fetched is cached in the browser, so the last good data shows with "before signal dropped" wording when the network goes.

Be polite to the archive: one browser pulling 48 frames now and then is fine; a hosted build with real traffic should point at the backend, which fetches each frame once for everyone.

## Test

```
npm install && npm test
```

Headless Chromium (the one Playwright installs; `CHROMIUM=/path/to/chrome` to use another) loads the page against fixture responses for NWS, the archive and the tile server, so it needs no network. `SHOTS=./shots npm test` also writes phone-sized screenshots of every screen.

## Inside a Claude artifact preview

The page detects the preview frame and says so: that frame blocks requests to outside hosts, so weather and radar cannot load there. The festival list still works. Host the folder anywhere else and it goes live.
