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
- **Festival official**: a dashboard for partner festivals to push alerts. The legitimate "hear what staff hear".
- **Incidents**: county public-safety radio (unencrypted, public) captured by a volunteer-run receiver node on site, transcribed on-device, filtered to hazards only, redacted, served locally and uploaded. Plus moderated attendee reports.
- **Attendee relay**: MultipeerConnectivity mesh so one phone with signal (or on the node's Wi-Fi) carries a warning across the campground.
- **Live audio**: only feeds a stream owner has agreed to. Empty for now.

## Phone-only, hardware on the volunteer side

Users need nothing but the app. The hardware (RTL-SDR + Pi, ~$100) lives in a volunteer's car. Pairing is joining the node's Wi-Fi; Bonjour discovery does the rest. Wi-Fi reach is ~50–100 m from the car; the relay mesh extends it.

## Receiver node scope

County sheriff/fire/EMS dispatch only. The festival's own channels are private business radio and stay off the config unless the promoter opts in, at which point they become the Official channel's feed rather than a scanner feature.

## Festival data

There is no clean public feed of every U.S. festival, and scraping aggregators violates their terms. The list is curated by hand in `backend/data/festivals.json` (or `PUT /festivals/:id`). Fall 2026 seed: Aftershock, ACL (both weekends), Neverender, III Points, Suwannee Hulaween, Sick New World Texas, Escape: Psycho Circus, EDC Orlando, Camp Flog Gnaw, Dreamstate SoCal. When We Were Young is on hiatus for 2026.
