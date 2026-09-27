#!/usr/bin/env python3
"""
Fieldwatch receiver node.

Watches trunk-recorder's output for finished radio calls, transcribes them on
this box, keeps only safety-relevant traffic, and does two things with each hit:
  1. serves it on the local network (phones on the node's Wi-Fi get it with no internet)
  2. uploads it to the Fieldwatch backend when there is a route out

Nothing that isn't a hazard is kept. Audio for dropped calls is deleted.
"""
import json, os, re, shutil, sys, threading, time, uuid
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

def _parse_env(path):
    """KEY=value lines. Inline `# comments` and surrounding quotes are stripped, like Node's --env-file."""
    out = {}
    for raw in path.read_text().splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        v = v.strip()
        if v[:1] in ('"', "'"):                      # quoted: take what is inside, ignore anything after
            end = v.find(v[0], 1)
            v = v[1:end] if end > 0 else v[1:]
        else:
            v = re.split(r'\s+#', v, 1)[0].strip()   # bare: drop an inline comment
        out[k.strip()] = v
    return out

_env_file = Path(os.environ.get('NODE_ENV_FILE', 'node.env'))
ENV = {**(_parse_env(_env_file) if _env_file.exists() else {}), **os.environ}   # real environment wins

BACKEND_URL   = ENV.get('BACKEND_URL', 'http://localhost:3000').rstrip('/')
NODE_KEY      = ENV.get('NODE_KEY', '')
FESTIVAL_ID   = ENV.get('FESTIVAL_ID', '')
NODE_NAME     = ENV.get('NODE_NAME', 'Fieldwatch receiver')
RECORDINGS    = Path(ENV.get('RECORDINGS_DIR', 'recordings'))
PUBLIC        = Path(ENV.get('PUBLIC_DIR', 'public'))
WHISPER_MODEL = ENV.get('WHISPER_MODEL', 'base.en')
LOCAL_PORT    = int(ENV.get('LOCAL_PORT', '8080'))
KEEP_HOURS    = int(ENV.get('KEEP_HOURS', '48'))
MIN_SECONDS   = float(ENV.get('MIN_CALL_SECONDS', '1.5'))

(PUBLIC / 'audio').mkdir(parents=True, exist_ok=True)
STATE_FILE = PUBLIC / 'incidents.json'
QUEUE_FILE = PUBLIC / 'upload-queue.json'

# Same categories as the backend's incidents.js. Keep them in sync.
CATEGORIES = [
    ('threat',     r'\b(shots? fired|gun|firearm|weapon|knife|stabb\w*|active shooter|armed)\b',                          'warning'),
    ('evacuation', r'\b(evacuat\w*|shelter in place|clear the (area|field|stage)|shut ?down the stage|stop the show)\b',   'warning'),
    ('weather',    r'\b(lightning|tornado|severe (storm|weather)|high winds?|wind hold|weather hold|hail)\b',           'warning'),
    ('flood',      r'\b(flood\w*|under ?water|washed out|standing water|the tunnel is)\b',                                 'advisory'),
    ('fire',       r'\b(fire|smoke|burning|propane)\b',                                                                'advisory'),
    ('missing',    r'\b(missing (child|kid|person|juvenile)|lost (child|kid)|amber)\b',                                 'advisory'),
    ('medical',    r'\b(unresponsive|not breathing|overdose|narcan|seizure|cardiac|mass casualty|multiple patients)\b', 'advisory'),
    ('crowd',      r'\b(crowd (crush|surge|collapse)|barricade (down|breach)|stampede|crush)\b',                        'warning'),
    ('traffic',    r'\b(road (closed|closure)|route \d+ (closed|blocked)|gate (closed|closure)|gridlock)\b',            'advisory'),
]
CATEGORIES = [(c, re.compile(p, re.I), l) for c, p, l in CATEGORIES]

def classify(text):
    for cat, rx, level in CATEGORIES:
        if rx.search(text or ''):
            return cat, level
    return None

def redact(text):
    t = re.sub(r'\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b', '[number]', text or '')
    t = re.sub(r'\b[A-Z]{1,3}[- ]?\d{3,4}[- ]?[A-Z]{0,3}\b', '[plate]', t)
    t = re.sub(r'\b(?:dob|date of birth)\b.{0,20}', '[dob]', t, flags=re.I)
    t = re.sub(r'\b(?:name is|last name|first name)\b.{0,30}', '[name]', t, flags=re.I)
    return t.strip()

def summarize(text):
    clean = re.sub(r'\s+', ' ', redact(text))
    first = re.split(r'(?<=[.!?])\s', clean)[0] or clean
    return first if len(first) <= 160 else first[:157] + '...'

def iso(dt=None):
    return (dt or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')

# ---- transcription -------------------------------------------------------

_model = None
def transcribe(path):
    """faster-whisper on-device. Returns None if it isn't installed, so the backend can try instead."""
    global _model
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return None
    if _model is None:
        _model = WhisperModel(WHISPER_MODEL, device='cpu', compute_type='int8')
        log(f'whisper {WHISPER_MODEL} loaded')
    segments, _ = _model.transcribe(str(path), language='en', beam_size=1, vad_filter=True,
                                    initial_prompt='Two-way radio dispatch at a music festival. Unit numbers, stage names, medical, security.')
    return ' '.join(s.text.strip() for s in segments).strip()

# ---- state ---------------------------------------------------------------

lock = threading.Lock()
incidents = json.loads(STATE_FILE.read_text()) if STATE_FILE.exists() else []
queue = json.loads(QUEUE_FILE.read_text()) if QUEUE_FILE.exists() else []

def save():
    STATE_FILE.write_text(json.dumps(incidents, indent=1))
    QUEUE_FILE.write_text(json.dumps(queue, indent=1))

def log(msg):
    print(f'[{iso()}] {msg}', flush=True)

def prune():
    cutoff = iso(datetime.now(timezone.utc) - timedelta(hours=KEEP_HOURS))
    with lock:
        old = [i for i in incidents if i['occurredAt'] < cutoff]
        for i in old:
            incidents.remove(i)
            if i.get('audioFile'):
                (PUBLIC / 'audio' / i['audioFile']).unlink(missing_ok=True)
        if old:
            save()

_perm_warned = False
def remove(path):
    """Delete a trunk-recorder file. Its output is root-owned when the container runs as root;
    say so once instead of failing every call (setup.sh sets a default ACL to avoid this)."""
    global _perm_warned
    try:
        Path(path).unlink(missing_ok=True)
    except PermissionError:
        if not _perm_warned:
            _perm_warned = True
            user = os.environ.get('USER', 'pi')
            log(f'cannot delete {path}: recordings are owned by another user. Run: sudo setfacl -R -m u:{user}:rwx -d -m u:{user}:rwx {RECORDINGS} && sudo chown -R {user} {RECORDINGS}')

# ---- processing one call -------------------------------------------------

def process_call(meta_path):
    meta = json.loads(meta_path.read_text())
    audio = next((p for p in [meta_path.with_suffix('.wav'), meta_path.with_suffix('.m4a')] if p.exists()), None)
    if audio is None:
        return
    if float(meta.get('call_length') or meta.get('stop_time', 0) - meta.get('start_time', 0) or 0) < MIN_SECONDS:
        remove(audio); remove(meta_path); return

    transcript = transcribe(audio)
    hit = classify(transcript) if transcript is not None else None
    if transcript is not None and hit is None:
        remove(audio); remove(meta_path); return   # gossip, gone

    occurred = iso(datetime.fromtimestamp(float(meta.get('start_time', time.time())), tz=timezone.utc))
    talkgroup = meta.get('talkgroup_tag') or meta.get('talkgroup_description') or str(meta.get('talkgroup', ''))
    audio_name = f'{int(time.time())}-{uuid.uuid4().hex[:8]}{audio.suffix}'
    shutil.copy2(audio, PUBLIC / 'audio' / audio_name)
    remove(audio); remove(meta_path)

    if hit:
        incident = {
            'id': f'inc-{uuid.uuid4()}', 'festivalId': FESTIVAL_ID, 'category': hit[0], 'level': hit[1],
            'summary': summarize(transcript), 'transcript': redact(transcript), 'source': 'scanner',
            'talkgroup': talkgroup, 'location': None, 'latitude': None, 'longitude': None,
            'audioURL': f'/audio/{audio_name}', 'audioFile': audio_name, 'occurredAt': occurred, 'published': True,
        }
        with lock:
            incidents.insert(0, incident)
        log(f'{hit[0]}/{hit[1]}: {incident["summary"]}')
    with lock:
        queue.append({'id': incident['id'] if hit else '', 'audioFile': audio_name, 'transcript': transcript or '',
                      'talkgroup': talkgroup, 'occurredAt': occurred})
        save()

def watch_recordings():
    seen = set()
    while True:
        try:
            for meta_path in sorted(RECORDINGS.rglob('*.json')):
                if meta_path in seen: continue
                if time.time() - meta_path.stat().st_mtime < 2: continue   # still being written
                seen.add(meta_path)
                try: process_call(meta_path)
                except Exception as e: log(f'call failed: {e}')
            seen = {p for p in seen if p.exists()}
            prune()
        except Exception as e:
            log(f'watch error: {e}')
        time.sleep(2)

# ---- upload --------------------------------------------------------------

def upload_once():
    """Send the oldest queued call. Returns False when the queue is empty."""
    import urllib.request
    with lock:
        item = queue[0] if queue else None
    if item is None:
        return False
    boundary = uuid.uuid4().hex
    parts = []
    for k in ('id', 'transcript', 'talkgroup', 'occurredAt'):
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{item[k]}\r\n'.encode())
    audio_path = PUBLIC / 'audio' / item['audioFile']
    if audio_path.exists():
        parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="audio"; filename="{item["audioFile"]}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode())
        parts.append(audio_path.read_bytes()); parts.append(b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    req = urllib.request.Request(f'{BACKEND_URL}/festivals/{FESTIVAL_ID}/incidents', data=b''.join(parts), method='POST',
                                 headers={'Content-Type': f'multipart/form-data; boundary={boundary}', 'x-node-key': NODE_KEY})
    with urllib.request.urlopen(req, timeout=30) as r:
        body = json.loads(r.read())
    log(f'uploaded {item["audioFile"]}: {body}')
    # Audio stays on the node only while a local incident points at it. A call this box could not
    # classify itself (no whisper) was uploaded for the backend to judge; either way it is not ours to keep.
    if not item['id'] or not body.get('stored'):
        audio_path.unlink(missing_ok=True)
    with lock:
        queue.pop(0); save()
    return True

def upload_loop():
    while True:
        try:
            if not upload_once():
                time.sleep(3)
        except Exception as e:
            log(f'upload failed, will retry: {e}')
            time.sleep(15)

# ---- local API for phones on the node's Wi-Fi ----------------------------

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(data)))
        self.send_header('Access-Control-Allow-Origin', '*'); self.end_headers(); self.wfile.write(data)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == '/health':
            return self._json({'ok': True, 'name': NODE_NAME, 'festivalId': FESTIVAL_ID, 'incidents': len(incidents), 'queued': len(queue), 'at': iso()})
        if path == '/incidents':
            with lock: return self._json([{k: v for k, v in i.items() if k != 'audioFile'} for i in incidents])
        if path.startswith('/audio/'):
            f = PUBLIC / 'audio' / Path(path).name
            if not f.exists(): return self._json({'error': 'not found'}, 404)
            data = f.read_bytes()
            self.send_response(200); self.send_header('Content-Type', 'audio/wav' if f.suffix == '.wav' else 'audio/mp4')
            self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data); return
        self._json({'error': 'not found'}, 404)

def serve():
    ThreadingHTTPServer(('0.0.0.0', LOCAL_PORT), Handler).serve_forever()

if __name__ == '__main__':
    if not FESTIVAL_ID:
        sys.exit('FESTIVAL_ID is not set; see node.env.example')
    RECORDINGS.mkdir(parents=True, exist_ok=True)
    log(f'{NODE_NAME} for {FESTIVAL_ID}; watching {RECORDINGS}, serving :{LOCAL_PORT}, uploading to {BACKEND_URL}')
    threading.Thread(target=watch_recordings, daemon=True).start()
    threading.Thread(target=upload_loop, daemon=True).start()
    serve()
