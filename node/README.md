# Fieldwatch receiver node

A small box a volunteer runs on site. It listens to county public-safety radio (sheriff, fire, EMS), keeps only the safety-relevant calls, and hands them to phones two ways: over its own Wi-Fi with no internet at all, and up to the Fieldwatch backend whenever it has a route out.

It does not record the festival's own operations radio. That stays off unless the promoter puts it on.

## Parts (about $100)

- Raspberry Pi 5 (4 GB) with a 32 GB card and a decent USB-C power supply. A Pi 4 works with `WHISPER_MODEL=tiny.en`. Any old laptop running Debian or Ubuntu also works and transcribes faster.
- RTL-SDR Blog V4 dongle.
- A mag-mount antenna for 700–800 MHz (most county systems) on the roof of the car. The stock antenna works in a pinch.
- A power bank or the van's 12 V. The Pi draws about 5 W.

## Setup

1. Flash Raspberry Pi OS (64-bit, Bookworm), boot, connect to the internet.
2. Copy this folder to `~/fieldwatch-node`, then `bash setup.sh`. It installs the SDR tools, Docker, trunk-recorder, on-device Whisper, turns the Pi into a Wi-Fi hotspot, and prints a QR code phones can scan to join.
3. Edit `node.env`: backend URL, the shared `NODE_KEY`, the festival id, and a hotspot password.
4. Put your county's radio system into `trunk-recorder/config.json` and `talkgroups.csv`. RadioReference lists every system's control channels and talkgroups; you need the P25 control-channel frequencies and the dispatch talkgroup ids. Set `center` so all control channels fall within about 1 MHz of it.
5. `sudo systemctl start fieldwatch-trunk-recorder fieldwatch-uploader`, then `curl localhost:8080/health`.

`node.env` is `KEY=value` per line; quote values that contain spaces (`NODE_NAME="Fieldwatch receiver"`), and `# comments` after a value are fine. Real environment variables override the file.

To check the pipeline on any machine without a radio: `python3 test_uploader.py`. It stubs Whisper and stands in a fake backend, and runs the same hazard samples the backend's tests use.

Once it's running, a phone that joins the node's Wi-Fi finds it automatically. The Fieldwatch app shows "Receiver on site" and starts pulling incidents.

## How a call flows

trunk-recorder writes each call as a `.wav` plus a `.json` with the talkgroup and time. `uploader.py` watches that folder, transcribes the audio with faster-whisper, and checks the text against the same hazard categories the backend uses. A match is kept, named, redacted and served on `/incidents`; anything else is deleted, audio included. Kept calls also queue for upload to the backend, which pushes them to every subscribed phone. If the backend is unreachable the queue just waits.

## Who owns the files

trunk-recorder runs as root inside Docker, so its recordings are root-owned, while the uploader runs as you. `setup.sh` puts a default ACL on `recordings/` so you can still delete finished calls. If the uploader ever logs `cannot delete`, it tells you the exact `setfacl` and `chown` to run; until then it copies each call out and leaves the original, so nothing is lost, just not cleaned up.

Audio is kept on the node only while a local incident points at it (48 hours by default). A call the node couldn't transcribe itself is uploaded for the backend to judge and deleted locally once the backend has answered.

## Why county radio and not the festival's

County dispatch is public-safety radio, unencrypted in most places, and relaying it is what scanner sites have done for decades. The festival's operations channels are private business radio. Recording them without the promoter's OK is the fastest way to get every festival to encrypt, and it ends any chance of the Official channel. If a promoter says yes, add their system to `config.json` and set `source` handling accordingly; the pipeline doesn't care where the audio came from.

## Local API

- `GET /health` name, festival id, counts
- `GET /incidents` same shape as the backend's incidents
- `GET /audio/<file>` the clip

Bonjour service: `_fieldwatch-node._tcp` on port 8080.
