# Fieldwatch: the feature set

Written 2026-09-30 from a three-angle design panel (attendee, crew, feasibility) scored by two judges, then corrected against what shipped the same day. Numbers are for reference, not priority; the order to build is in the Next section's first line.

## What it is for

Fieldwatch tells anyone standing in a field what the sky is about to do and what the festival's safety staff want them to do. It opens on the festival you are at, or on the weather where you stand, with every other festival a tap away by lightning code, red first, and gives NWS warnings, a forecast built for the day (heat, gusts, thunder), a radar loop, and official holds and updates, on a phone that may have no signal. No accounts, no tracking, no paid data, every source free and licensed for this use, run by one operator from a phone. For first-timers, seasoned goers, crews and vendors, and the safety staff who post to them.

## Live today

- Picker lists only what is on: a week before gates to the day after.
- List from the curated seed, Ticketmaster, SeatGeek, Edmtrain and feed importers (keys), and a keyless Wikidata pass that reads each festival site's own schema.org dates (robots honored); each festival listed once across them (same grounds, or the same name or its nickname within 8 km; side shows sold under the name are dropped; a stored copy a source ahead holds goes on the next run).
- Location opens the festival you are at and sorts by distance.
- Right where you are: the phone's own spot as a festival for the week (alerts, forecast, radar, push), named by one OpenStreetMap lookup. This replaced adding a festival by hand.
- Warn people near you: on a warning, the alert text and link go to the share sheet, so AirDrop reaches phones with nothing installed and no signal.
- Home card: NWS alerts and a 6-hour strip.
- Forecast: temperature and rain, heat index, gust and thunder panels, day rows with a pack line.
- On the way: when the next twelve hours turn stormy, windy, wet or dangerously hot, a card under the sky with a live countdown to when it starts, what to do first, and a prep screen behind it (where to shelter, how to solidify camp, a timeline you are somewhere on, what to pack for shelter). The backend pushes the same heads-up up to three hours ahead, once per window.
- Lightning codes: the backend reads the GOES lightning mapper's 20-second flash files from NOAA's public buckets every 20 seconds while a festival is on and grades each one on the festival safety protocol: red (a flash under 8 miles: rapid evacuation, full work stoppage, all clear 30 minutes after the last one, with the countdown), orange (8 to 12: execute evacuation procedures, staff hold posts to assist attendees), yellow (12 to 20: pay attention, prepare for orange and a work stoppage), green (none within 20 in 15 minutes). An indoor event (a club, a hall, an arena: staff, OpenStreetMap, or the venue's name) gets no code at all, since the building is the shelter; the tile, the screen and the home page say Indoors. The code beside every festival's name on the home page's cards (green included), a tile under the festival page's sky with the nearest flash and the all-clear countdown, a screen with the counts by ring and the protocol in its own words, and every change to orange or red pushed. The screen says the festival's own lightning vendor is the authority.
- Ground: the surface under each festival (OpenStreetMap under the point or within 250 m, else the national land cover map's 30 m cell), how its soil drains (USDA soil survey), low ground, the rain of the last two days (Iowa Mesonet), and a staff screen where the lookups' answers come already selected, to correct what they cannot see and to say what is standing (canopies, inflatables, a stage). Rain heads-ups are judged by the amount the grid forecasts, not the chance, against that ground: wet, soft, deep mud or standing water (slick or runoff on blacktop), each with its own list for who is asking (camping, day visitor, crew; tent and canopy advice only where people camp, and the car is never told to move as if it could), and every task with a start-by time worked back from the arrival, the longest first. Wind is judged against what is standing: inflatables at 20 mph, pop-up canopies at 30, a stage at 40, and the heads-up names the line crossed. One tap on the prep screen reports the ground (fine, soft, mud, water) to everyone there, and the venue learns how much rain it takes from what was reported. Heat is judged for people working or dancing too: an estimated wet-bulb globe temperature from air temperature, humidity, wind and cloud earns a flag (green, yellow, red, black) with work-rest guidance, and red or black is a heads-up on its own. Rain already on the radar is tracked frame to frame on the backend: inside two hours its arrival pulls the countdown in, or makes a heads-up of its own when the forecast has none, with the direction it is coming from and its speed.
- 12-hour radar loop with your position.
- A first-open walkthrough: an intro scene, three pages that teach, a start page; then a tour of the festival page, one spotlight per element. Once each, replayed from Settings.
- Live: an open page moves the second the backend does. A server-sent stream (`/events`) announces every alert that lands or ends, heads-up, lightning code, staff post and ground report, and the page refreshes just that festival or the feed; the backend asks the weather service every 30 seconds and the lightning buckets every 20.
- Alerts for the whole grounds: NWS alerts are pulled by the festival's county and forecast zone and kept when their polygon reaches within about a mile of the grounds, so a warning drawn across the edge of a large site is not missed the way a single-point query misses it.
- Favorites: the heart on a festival page follows its warnings on this phone, several festivals at once, one row per phone per festival on the backend; on the festivals list a favorite wears its heart, and one not on yet stays listed with when it opens; the picker groups favorites at the top, and a favorite of a festival that is over drops away. Right after a festival is picked, one card offers the favorite (Favorite, Not now; on an iPhone in Safari, Add to Home Screen first), and never again for that festival.
- Web push warnings (VAPID, keys made on first boot) for a festival or for a spot, with a test notification the moment you switch on; deep links; share with a QR and a plain link.
- Hazard reports into a moderated queue.
- Incidents from the on-site receiver node (Pi, county public-safety radio only).
- Staff settings out of sight: the backend address, its check and the admin key show in Settings after five taps on the credits line, `?staff=1`, or once a key is saved; the public sees location, forget, and the credits.
- A festival's own staff key, issued by the admin from Settings and shown once with a staff link: its safety team posts updates, reviews reports, corrects the ground and moves the pin for their festival, and nothing admin-wide (`docs/partner.md`).
- Staff screens behind the admin key: post an update (alert plus push), review reports before they go out, a sources screen with the last import and a run-now button, and an All festivals screen to search the whole list and hide a listing that is not a festival (an import keeps it hidden).
- Works from the cached pack when signal drops.
- iOS app with a Bluetooth relay: written, never compiled.

## Next

High value, buildable now with what is on Railway and GitHub Pages. Order: Here mode and place warnings, then staff keys, hold board and queue, then the AirDrop card, then the rest.

### Location first

**1. Finish Here mode ("Right where you are")**
Live: the picker row, the card, alerts, strip, panels, day rows, radar and push for the spot, the name from one OpenStreetMap lookup, and `?here=1`.
Left: switch to a listed festival within a few miles so staff posts reach you; for crews, a listed festival within 30 days and 3 km opens with an "In build" tag (new buildDays field; the public list keeps its 7-day rule); "Following this spot since Tue" with a Stop row. Nominatim stays at one lookup per spot with attribution, which its policy allows; NWS /points can name the place instead if that ever changes.

**2. Warnings for where you are**
Live: a subscription for a spot stores a cell rounded to 0.01 degrees, never the position; the poller asks the weather service about every such cell beside the festival list and pushes to the phones in it.
Left: a 7-day life renewed on every open, so cells nobody is at any more stop being polled; resolve a cell to its NWS zone once so zone-wide watches arrive too.

**3. Backend radar for points**
How: round to a 0.1-degree cell, add /points/:lat,:lon/radar reusing radar.js's cache and coverage square; the web build prefers it in Here mode. Stops a hundred phones in one field pulling 48 frames each from the IEM.
Needs: disk on the Railway volume (mounted). Prefetch only cells with subscribers; fetch the rest on request.

### Weather

**4. Warning polygon and storm line**
How: keep geometry and eventMotionDescription in normalizeAlert (backend, web, Swift in step). Outline active warning polygons on the radar square beside your dot. Alert screen adds "Storm 18 mi west, moving toward you at 35 mph, about 30 min".
Needs: nothing. Only storm-based warnings carry it; zone alerts draw nothing and the line hides. Turns "your county" into "is it us".

**5. Thunder 30/30 timer**
How: "I heard thunder" on the thunder panel and on any thunderstorm alert. 30-minute countdown on the home card, resets on tap, buzzes and banners at zero, works offline.
Needs: nothing. The card must say the web build cannot buzz with the tab closed.

**6. Measured wind and your thresholds**
How: a "Now" gauge above the gust panel: sustained, gust, direction, station, distance, age, from NWS stations/observations/latest (CORS, no key), every 5 minutes. Per-phone thresholds (presets: tents 25/40, lift 28, inflatables 15/25, roof from its letter) drawn on the gauge and the forecast. Push "gusts over 40 forecast from 3 pm" an hour before the crossing.
Needs: nothing for the gauge and lines. The push needs a threshold per subscription on the backend; do it second. Nearest ASOS can be 30 mi away, so print distance and age.

**7. Heat plan and work/rest timer**
How: the heat panel gains shade windows (hours over the 90 and 103 heat-index guides), sunrise and sunset computed on the phone, and an opt-in drink-water nudge while the app is open. WBGT strip with flag colors where the NWS gridpoint publishes it, estimated and labeled elsewhere. Timer card: workload, acclimatized or not, "work 40 / rest 20", buzz at each change.
Needs: nothing. WBGT is patchy by office; a week to get the strip right, then hang the timer off it.

**8. Severe outlook on the day rows**
How: backend fetches SPC day 1 to 3 categorical outlooks and the WPC excessive-rainfall outlook hourly, point-in-polygon per in-window festival and subscribed cell, serves outlook[] in the pack. Day rows get a tag ("Enhanced risk of severe storms Saturday"); the pack line adds a sentence. SPC watches and mesoscale discussions attach for nearly free.
Needs: backend only (SPC sends no CORS). Confirm the WPC endpoint on the first run.

**9. "This week" card**
How: take the office id from /points, fetch the Hazardous Weather Outlook straight from api.weather.gov (CORS), show the day-one and days-two-to-seven paragraphs as-is with office name and issue time.
Needs: nothing. Some offices issue it only when something is coming; fall back to the AFD.

**10. Sun, air and smoke**
How: UV hourly from Open-Meteo in the browser (free non-commercial, CC BY, attribution on screen). AQI through the backend from AirNow, shown from Moderate up with monitor distance; a Cal/OSHA 151 line and a mask line on the pack line. Backend also checks NIFC fire perimeters within 50 km and NOAA HMS smoke overhead; one row, only when something is there. A fourth aligned panel beside heat, wind and lightning.
Needs: a free AirNow key on Railway. ArcGIS URLs move, keep them in env. Smoke aloft can sit over clean air, so never show it without AQI.

**11. Rivers near the grounds**
How: backend polls USGS gauge height for sites within 30 km and NWS NWPS for action and flood stages and the crest, every 30 minutes. A "Rivers" row: "Suwannee at Suwannee Springs: 51.2 ft, rising, action 54 ft, crest 55.1 ft Sun". Curated records can pin gauge ids.
Needs: backend only. The nearest gauge is often the wrong reach, so the pin override matters more than distance. Check whether waterservices has moved to api.waterdata.usgs.gov.

### Share and on the ground

**12. AirDrop: warn people near you**
Live: the button on every warning, sending the text and the link.
Left: one button draws a PNG card (headline, what to do, until when, place, newest radar frame with your dot, the QR) and calls navigator.share with the file and a link whose fragment carries the alert itself. iOS shows AirDrop, Android Quick Share. A phone with no app and no signal reads the card; one with the app taps through and is offered "Follow this spot". Same card goes to group chats.
Needs: nothing; iOS 15+ for files. Radar layer only from backend frames (IEM frames taint the canvas). Repeat the essentials in the text field, some targets strip fragments. One line: "set AirDrop to Everyone for 10 minutes".

**13. Hold-up mode**
How: on any warning or hold, a full-bleed high-contrast page with the event and one instruction in the largest type that fits, Wake Lock keeps it on, optional tone. For a vendor row or a crew of six with no PA.
Needs: nothing. The browser cannot set brightness; say "turn brightness up".

**14. Catch-up digest and low-signal mode**
How: the first sync after a gap shows "While you were out": warnings first, then holds, posts and incidents newer than the last sync. Two timed-out fetches switch to low-signal: alerts only, radar paused, age shown on everything; toggle in Settings.
Needs: nothing. navigator.connection is absent on iOS Safari, so key it off timeouts.

**15. First-timer safety cards**
How: short static cards in the pack, in the walkthrough and a "Know before you go" row: heat and water; a tent is not lightning shelter; crowd crush (stay on your feet, arms up, move diagonally); harm reduction, Never Use Alone and 988; keep carrier WEA on; what a warning sounds like; the county SAME code for a weather radio. Festival staff cards append.
Needs: nothing. Highest value per line in this list.

**16. Source and age on every card**
How: "NWS Fort Worth, 4 min ago", "KDFW gust, 6 min ago". A card past its refresh grays to stale. The offline banner states the pack's age.
Needs: nothing. Nobody stakes a hold on a number with no age.

**17. Getting home card**
How: a "Leaving" section on the day rows: forecast for the exit hours (rain, temperature, gridpoint visibility for fog, lightning risk with "a car is a safe place in lightning"), sunrise, staff exit posts, road incidents from the county-radio queue, and the three nearest hospitals and urgent cares with phone numbers pulled once per festival from Overpass into the pack. "My car" saves a position on the phone only and shows an arrow and distance back to it.
Needs: nothing server-side beyond Overpass. iOS needs a tap-gated orientation permission for the arrow.

**18. Water, medical and exits from OpenStreetMap**
How: one Overpass query per in-window festival per day: drinking water, toilets, first aid, defibrillators, shelters, main and emergency entrances within 1.5 km, into site[] in the pack. The heat panel gets "nearest water 240 m"; a Site screen draws pins over tiles with your dot. Partner data overrides.
Needs: the heat-panel line ships now; the pin map waits on a tile provider with a usage agreement. Rich at parks and speedways, empty in a field, and the screen says "from OpenStreetMap, may be out of date".

**19. Crew role presets**
How: a role picker in Settings (attendee, stage and rigging, tents and vendors, gates and security, medical), phone only. Sets wind, heat and lightning defaults, card order and the pack-line wording. Attendees keep the simple view.
Needs: nothing. Worth it once the crew cards above exist.

### Staff (roadmap 9 and 10)

**20. Staff keys by QR (do first)**
How: admin mints per-festival keys with a label ("Safety lead"), expiry the day after the festival ends, revocable, hashed on the backend. Post, queue, publish, delete and export routes accept x-staff-key beside the admin key. A QR opens the web build with ?staff=, stored locally and stripped from the URL. Every post shows "Posted by festival safety" with the label.
Needs: backend only: a keys table, a DELETE route, a list on the sources screen. Unblocks every staff feature without handing out the admin key.

**21. Hold board (roadmap 10)**
How: the post screen becomes six big buttons: Wind hold, Lightning hold, Heat rest, Shelter now, Evacuate, All clear. Each has template wording, an area picker and an optional until-time. Posts gain kind and expiresAt. An open hold is a persistent banner above the weather on every home card until All clear or expiry; warning-level pushes as urgent with the buzz; it seeds the AirDrop card; the Official screen shows the hold timeline. Free text stays for the rest.
Needs: the staff key, two columns on posts, template chips. "Shelter in vehicles, gates paused" in ten seconds in the rain.

**22. Queue (roadmap 9)**
Live: pending reports and node incidents for the festival, publish or remove, behind the admin key.
Left: unlock by staff key; Reports within 200 m and 20 minutes group as one card with a count. One tap: publish (pick category and level, edit the summary), dismiss with a canned reason, or "make it official", which drafts a hold post. New "crowd" category. Attendees tap "still there?" on published incidents; unconfirmed ones expire after a few hours.
Needs: the staff key; category and level on the publish route; a confirm endpoint and an expiry field. The mini-map waits on the tile agreement.

**23. Log export**
How: one button on the staff screens: every NWS alert, hold, post, incident and report for the festival as CSV and JSON with UTC and local times, through the share sheet. What the promoter, insurer or regulator asks for afterward.
Needs: the staff key, one GET route. An afternoon, and the reason an officer runs holds through the app instead of a chat.

**24. Morning brief**
How: on demand or at a chosen hour: alerts in effect, SPC category and any watch, peak gust and the thunder window, peak heat hour, rain timing, sunrise and dark. Rendered as a PNG for AirDrop and pushed to phones that opted in. The 7 a.m. toolbox talk on one card.
Needs: nothing new; compose from what exists and let SPC and WBGT attach when they land.

### Festival list

**25. Known grounds**
How: a curated backend/data/grounds.json (Zilker, Spirit of the Suwannee, Discovery Park, Texas Motor Speedway, Las Vegas Festival Grounds, Mana Wynwood, Tinker Field, and so on), each with a source URL, grounds coordinates, county, NWS office, gauge ids and OSM relation. applyImport snaps any import within 3 km and inherits them; the picker shows the grounds under the festival.
Needs: a data file with a source per row. Warning polygons are drawn to the mile; this fixes box-office centroids for every importer at once.

**26. Year-round festival registry**
How: order of trust: curated seed, Ticketmaster, SeatGeek and Edmtrain, your feeds, Wikidata, festival sites, staff and admin suggestions. Every record keeps a source URL; the live window still decides what the picker shows. Steps: turn on the ticketing keys and read the first import report (none has run live); a Wikidata SPARQL gazetteer of US music festivals with coordinates and websites (CC0, a day); iCal and RSS from fairgrounds, parks, arts councils and venues through feeds.js, URLs picked by you; a polite weekly crawl of known festival sites for schema.org Festival JSON-LD dates (robots honored, registry sites only); an admin coverage report by state and month plus the subscriber-heavy cells that match no festival. Wikidata-fed festivals publish unfeatured; their pins can be the town rather than the grounds, so the sources screen is where an admin fixes a pin (PUT /festivals/:id) and the known-grounds file above snaps the common ones.
Needs: the existing keys, no new ones. JSON-LD is on perhaps a third of sites; the long tail is admin labor. JamBase (paid) for the jam and camping scene later.

**27. Search reaches ahead (your call)**
How: bubbles and the list stay strictly what is on. A typed search also matches published festivals up to 90 days out, grayed, "opens in 12 days", with one row "Tell me when it's on" that sends a single push at opensAt. Nothing is polled before then.
Needs: your yes. It bends "only what is on is listed" in CLAUDE.md. Small to build.

## Later

Needs the native app, hardware, a partner or paid data.

**1. Receiver node on real hardware (roadmap 7, you asked for it)**
Pi 5 and RTL-SDR V4 on one county P25 system from RadioReference. Measure Whisper latency (under 60 s a call), confirm Bonjour discovery from an iPhone on the hotspot, confirm the uploader can delete what trunk-recorder wrote, then tune the hazard rules against a day of traffic. Once it runs, the Pi's landing page shows the hold board and current alerts beside the QR, so a phone that just joined sees the status before installing anything.
Needs: the hardware in hand. County public-safety radio only.

**2. Native app**
Compile the Swift first (roadmap 1); nothing below exists until it builds. Then APNs end to end, the Bluetooth relay test on two devices, the thunder timer and water nudges as local notifications with the app closed, AirDrop while backgrounded, background location for zones, a Kestrel over Bluetooth for measured wind on stage.
Needs: a Mac with Xcode, an APNs key, two iPhones.

**3. Storm arrival from radar frames**
Decode dBZ from the cached IEM frames, cross-correlate the last few for motion, project the nearest 40 dBZ core toward the grounds: "Rain reaches the grounds in about 40 min (30 to 55)". Hidden whenever the vector wobbles.
Needs: the radar path run against the real archive first (roadmap 3). Unproven; the NWS motion line (Next 4) answers the same question for the warnings that matter.

**4. Lightning and the storm line on the radar loop**
The codes are live (`backend/src/lightning.js` reads the GLM files in Node with h5wasm, no second service) and the nowcast tracks the rain frame to frame (`backend/src/nowcast.js`). Still to do: the flashes as dots on the radar square with 8, 12 and 20-mile rings, the bearing of the nearest one, and the tracked motion drawn as an arrow on the loop.
Needs: the first real run against the buckets (roadmap 15). 8 km footprint; a wrong all-clear is a liability, so red never clears on stale data.

**5. Offline grounds map**
A self-hosted PMTiles extract (Protomaps, OSM-derived) of the square around the grounds in the pack, a Grounds screen with the radar overlay and your dot, staff placing points by tapping.
Needs: a vector renderer in a one-file build, per-festival extracts, staff or a partner to place points. Next 18 delivers most of it first.

**6. Shelter and evacuation zones**
Partner festivals supply shelter points and zone polygons (SiteItem as GeoJSON). A Shelter or Evacuate hold picks zones; the phone says "You are in Zone C: go to Lot B, 400 m north" with an arrow. Ships in the pack, works offline.
Needs: a partner festival's site data (none signed) and the native app for background location. Build the schema and hand-draw one festival when a partner appears.

## Not doing, and why

- **Lineups and set times.** Doubles the data problem, adds nothing to safety, and pulls every screen toward a festival app. The set-time apps already exist.
- **Chat.** A thread is what crews already have and do not trust. Holds are a status with a start time; reports cross the queue. Chat needs moderation at scale and an identity.
- **Accounts, logins, identifying analytics.** Not up for debate. Phones register a push token with a festival id or a rounded cell, never a position. Staff get a festival-scoped key that dies with the festival.
- **Scraping consumer apps and other people's radio.** No Broadcastify (not licensing new scanner apps), no festival operations channels without written OK, no ticket-site scraping, no Nominatim under load. Every source is free and licensed for this use or it is not in.
- **Open "add a festival" and auto-published reports.** The form put unmoderated records in front of you; Here mode covers the unlisted show, staff and admin suggestions cover the rest. Attendee reports always cross the queue.
- **Per-state 511 feeds and a weather-radio transmitter table.** A registration per state and a scraped HTML table for a handful of users; the county-radio queue and one SAME line in the safety cards cover it.
