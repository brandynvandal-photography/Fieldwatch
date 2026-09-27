#!/usr/bin/env bash
# Fieldwatch receiver node setup for Raspberry Pi OS (Bookworm, 64-bit) or Debian/Ubuntu.
# Run once as the "pi" user from ~/fieldwatch-node:  bash setup.sh
set -euo pipefail
cd "$(dirname "$0")"

[ -f node.env ] || { cp node.env.example node.env; echo "Created node.env; edit it before starting the services."; }
set -a; source node.env; set +a

echo "== packages"
sudo apt-get update -qq
sudo apt-get install -y -qq rtl-sdr avahi-daemon python3-venv python3-pip ffmpeg qrencode curl network-manager acl

echo "== blacklist the kernel DVB driver so the SDR is free"
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/blacklist-rtl.conf >/dev/null
sudo modprobe -r dvb_usb_rtl28xxu 2>/dev/null || true

echo "== docker (for trunk-recorder)"
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sudo sh; sudo usermod -aG docker "$USER"; fi
sudo docker pull robotastic/trunk-recorder:latest

echo "== python env with on-device whisper"
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q faster-whisper
mkdir -p recordings public/audio
# trunk-recorder runs as root inside Docker; this lets the uploader (running as you) delete finished calls.
setfacl -R -m "u:$USER:rwx" -d -m "u:$USER:rwx" recordings || echo "setfacl failed; if the uploader logs 'cannot delete', run: sudo chown -R $USER recordings"

echo "== hotspot: phones join this network to pair with the receiver"
sudo nmcli device wifi hotspot ifname wlan0 con-name fieldwatch ssid "${HOTSPOT_SSID:-Fieldwatch}" password "${HOTSPOT_PASSWORD:-change-me-now}" || true
sudo nmcli connection modify fieldwatch connection.autoconnect yes ipv4.method shared || true

echo "== bonjour so the app finds the node automatically"
sudo cp avahi/fieldwatch-node.service /etc/avahi/services/
sudo systemctl restart avahi-daemon

echo "== services"
sudo cp systemd/fieldwatch-uploader.service systemd/fieldwatch-trunk-recorder.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable fieldwatch-uploader fieldwatch-trunk-recorder

echo
echo "Scan this with an iPhone camera to join the receiver's Wi-Fi:"
qrencode -t ANSIUTF8 "WIFI:T:WPA;S:${HOTSPOT_SSID:-Fieldwatch};P:${HOTSPOT_PASSWORD:-change-me-now};;"
echo
echo "Next: put your county's P25 control channels in trunk-recorder/config.json (see README), then:"
echo "  sudo systemctl start fieldwatch-trunk-recorder fieldwatch-uploader"
echo "  curl localhost:${LOCAL_PORT:-8080}/health"
