# Decisions

## What this is not

The original idea was a phone that acts as a staff radio: passively pick up festival ops, law enforcement and EMS traffic, offline. That cannot be built as a phone-only app:

- iPhones have no receiver for 150–470 MHz or 700/800 MHz bands and no practical USB SDR support. Passive listening still needs a physical receiver.
- Many police departments encrypt. Large festivals run private digital trunked systems.
- 47 U.S.C. § 605 prohibits divulging intercepted communications not intended for the public. Listening on your own device is scanner use (some states restrict scanners in vehicles); republishing festival ops traffic to attendees is the divulging problem.
- Broadcastify has explicitly stopped licensing new "police scanner" style mobile apps, so the online-stream route is closed too.
- Promoters treat apps that rebroadcast their radio as hostile. The Instagram account "airhack" (clips of Lost Lands 2026 event dispatch and county radio, redacted, posted days later) is the reference example of what gets festivals to encrypt.

## What it is instead

Same UX (pick festival, pick channels), different sources:

- **Weather**: NWS API alerts by coordinates + hourly forecast. Free, no key, official. Pushed while online; cached pack while offline. WEA carrier alerts still arrive on their own.
- **Radar**: a 12-hour loop of NEXRAD base reflectivity over a 320 km square around the grounds. Source is the Iowa Environmental Mesonet's WMS-T archive of the NWS composite: free, no key, any 5-minute timestamp. radar.weather.gov only keeps about an hour and RainViewer two, with terms written for their own apps. The backend fetches each frame once and serves it to every phone, so the archive sees one polite client instead of a festival's worth, and the phone keeps the last loop on disk so it still plays when signal drops. Attribution to NOAA and the IEM stays on the screen.
- **Festival official**: a dashboard for partner festivals to push alerts. The legitimate "hear what staff hear".
- **Incidents**: county public-safety radio (unencrypted, public) captured by a volunteer-run receiver node on site, transcribed on-device, filtered to hazards only, redacted, served locally and uploaded. Plus moderated attendee reports.
- **Attendee relay**: MultipeerConnectivity mesh so one phone with signal (or on the node's Wi-Fi) carries a warning across the campground.
- **Live audio**: only feeds a stream owner has agreed to. Empty for now.

## A web build alongside the app

`web/` is the same product in a browser: pick a festival, get live NWS alerts and the hourly forecast, the 12-hour radar loop, and whatever a backend adds. It exists because the iPhone app needs a Mac, a developer account and an install, and because the data paths deserve a way to be seen working without hardware. It talks to NWS and the radar archive directly when there is no backend, the same fallback the app has, and to the backend when one is configured. It is not the offline story: a browser tab has no push, no relay, no receiver pairing, and only what it cached.

## Phone-only, hardware on the volunteer side

Users need nothing but the app. The hardware (RTL-SDR + Pi, ~$100) lives in a volunteer's car. Pairing is joining the node's Wi-Fi; Bonjour discovery does the rest. Wi-Fi reach is ~50–100 m from the car; the relay mesh extends it.

## Receiver node scope

County sheriff/fire/EMS dispatch only. The festival's own channels are private business radio and stay off the config unless the promoter opts in, at which point they become the Official channel's feed rather than a scanner feature.

## Festival data

There is no clean public feed of every U.S. festival, and scraping aggregators violates their terms. So the list is built from sources that are allowed: a curated, featured set in `backend/data/festivals.json` (fall 2026 seed: Aftershock, ACL both weekends, Neverender, III Points, Suwannee Hulaween, Sick New World Texas, Escape: Psycho Circus, EDC Orlando, Camp Flog Gnaw, Dreamstate SoCal; When We Were Young is on hiatus); the Ticketmaster Discovery API (which also carries Front Gate, Live Nation's festival ticketing, and Universe), the SeatGeek Platform API and the Edmtrain API, all licensed for exactly this (Edmtrain's terms ask that each event's link be shown as given, so it is the record's source); Wikidata (CC0, no key: one SPARQL query for every US festival with coordinates and an official website) plus each festival site's own schema.org JSON-LD, the blocks sites publish for search engines, read for this year's dates by a polite crawler that honors robots.txt (the group naming our product token, else `*`, wildcards and `$` as written), follows redirects by hand with robots.txt re-read on every new origin, never fetches anything but a public DNS name, and stays off until `NWS_USER_AGENT` carries a real contact; a feed URL of the maintainer's own (a published Google Sheet); and the people at the festival, who can add one from the app and have it checked by a human before it shows. Small independent festivals come from SeatGeek, Wikidata and their own sites, the feed and the people at the festival. Nobody types a festival in by hand any more: someone at a festival the list does not know taps "Right where you are" and gets alerts, forecast, radar and push warnings for that spot, which is what they needed the listing for. Radiate and the other consumer apps have no API and their terms forbid pulling their lists, so they are out; so is The Ticketing Co., which publishes no feed. Festivals sold there arrive through SeatGeek, Edmtrain, Wikidata and their own sites, the feed, or the people at the gate. Nothing arrives without a source URL, and a curated record is never overwritten by an imported one.

**Only what is on is listed.** A festival appears from the moment its grounds open (a week before gates, for early entry, vendors and build crews, or the festival's own `groundsOpen` date) until the day after it ends, then disappears. There is no sense in offering alerts for a place nobody is at yet, and a list of everything a year out would bury the one that matters. The same window decides what the backend polls and what radar it pre-fetches.

## Web first; native when a partner needs it

The web build is the product that ships: it opens on the festival you are at, warns with the app closed (a push through the
service worker; on an iPhone the site has to be on the Home Screen), plays the last radar loop with no signal, and takes a
staff key. The Swift app has never been compiled and its push needs a paid developer account, a review, and release cycles
that a weekend festival cannot wait for. So the order is: the web build in the field first, the native app when a partner
festival needs what Safari cannot do (the phone-to-phone relay with no signal, background audio from a node). Until then
the iOS code stays reviewed but unbuilt, and every feature lands in the web build.

## A festival's staff key is not an account

A partner's safety team needs to post, moderate and correct the grounds without the admin key that runs everything. The
answer is one key per festival, issued by the admin and shown once, kept as a hash, good for that festival's staff routes
and nothing else. It is the festival's, not a person's: no name, no login, no record of who held it, in keeping with the
no-accounts rule. Revoking it is one call.

## Counters with nobody in them

To learn what is used, the backend counts packs opened, alert lists, alerts stored and their latency, pushes sent, heads-ups,
posts, reports and follows, per festival per day, for ninety days. Nothing in a counter names a phone, an address or a
person, and nothing is sent to a third party. That is the line between knowing whether the thing works and tracking people.
