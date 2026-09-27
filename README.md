# Fieldwatch

Festival safety alerts for attendees: weather with a 12-hour radar loop, official notices, county-dispatch incidents, phone-to-phone relay. No accounts, works offline.

See `CLAUDE.md` for the map of the repo and how to run each part, `docs/decisions.md` for why it's built this way, and `docs/roadmap.md` for what's next. Open `prototype/index.html` on a phone for the tap-through of every screen.

Quick checks without hardware: `cd backend && npm test`, `cd node && python3 test_uploader.py`, `cd web && npm test`.

No iPhone build yet? `web/` is the same app for a browser with live NWS data and radar; serve the folder from any static host.
