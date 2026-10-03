# The first live weekend

Nothing in the weather chain has touched real data: the weather service, the lightning mapper's files, the radar
archive, the ground lookups, the zone alerts, the live stream through Railway, push. This is the list of what a person
sets, watches and tries, in order. `node backend/scripts/shakedown.mjs https://your-host ADMIN_KEY` does the reading.

## Before the weekend, from a laptop

1. **Deploy with a volume.** Nothing to set: the database seeds itself, the admin key and the web push keys are made on the
   first boot, and the weather service sees `Fieldwatch/<version> (+the site address)`, a contact it can reach. Open the first
   deploy's log and copy the admin key from the line that says it is shown once. Optional, in Variables: `NWS_USER_AGENT=Fieldwatch
   (a mailbox you read)` to give a mailbox instead; `TICKETMASTER_KEY` (developer.ticketmaster.com), `SEATGEEK_CLIENT_ID`
   (seatgeek.com/account/develop), `EDMTRAIN_KEY` (edmtrain.com/developer-api) for sources beside Wikidata and the festival sites.
2. **Run the shakedown script.** Good looks like: `health: ok` with no PROBLEM lines; `database on a volume`; lightning on with
   files arriving and no bucket error (a 403 or NoSuchKey means the bucket names moved: `GLM_BUCKETS`); polling ok within a minute;
   for each festival that is on: alerts counted, a lightning code with data a minute old, radar frames with the newest under twenty
   minutes old, ground with a surface and a soil from a lookup rather than assumed, nowcast tracked; the live stream open with hello
   and a ping.
3. **Open `/health` in a browser** and read `warnings`. Each one says what is missing or ignored.
4. **The sources screen** (Settings, five taps on the credits, the key): Run now, read the report, hide what is not a festival on
   All festivals. Check the first imported festivals' pins on a map: an imported pin often sits on a box office or a lodge.
5. **Point an uptime monitor at `/health?strict=1`.** It answers 503 while a feed is stale.

## During the weekend, from a phone, at the grounds if you can

6. **Landing.** Open the app with location on. It should open on the festival, or on your spot with nothing near.
   Settings, Check the backend: a green pill.
7. **Warnings.** Favorite the festival; a welcome notification arrives. Close the app. Have staff post an update: the phone should
   buzz within seconds. On an iPhone this needs the site on the Home Screen first.
8. **Lightning.** When a storm is within twenty miles, compare the code and the nearest flash with the festival's own detection and
   with the radar. The all-clear countdown should match thirty minutes after the last close flash.
9. **No signal.** Airplane mode: the festival page opens from the cache, the last radar loop plays, an alert opens in full. Back
   online, the page catches up within a minute without a reload.
10. **Battery.** Note the percentage at the start and after four hours with the app open, and after four with it closed.
11. **Ground.** After rain, tap How is the ground. Staff: Correct it on the Ground screen if the lookup read the surface wrong, and
    Pin it here if the pin is not on the grounds.
12. **Relay** (iOS, later): airplane mode on one phone, Bluetooth on, a warning on the other.

## After

13. Read `/admin/stats`: packs, pushes, alert latency. Read the log for `poll failed`, `radar:`, `lightning alert failed`,
    `backup failed`. Download `/admin/backup`.
14. Put every wrong thing in `docs/roadmap.md`, with the screen it was on.
