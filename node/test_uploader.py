#!/usr/bin/env python3
"""
Tests for the receiver node. Standard library only, no SDR, no whisper:

    python3 test_uploader.py

Whisper is stubbed; the backend is a tiny fake HTTP server so the multipart upload is exercised for real.
"""
import json, os, shutil, sys, tempfile, threading, time, unittest
from datetime import datetime, timedelta, timezone
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import BaseHTTPRequestHandler, HTTPServer, ThreadingHTTPServer
from pathlib import Path
from urllib.request import urlopen
from urllib.error import HTTPError

HERE = Path(__file__).resolve().parent
WORK = Path(tempfile.mkdtemp(prefix='fieldwatch-node-test-'))
(WORK / 'node.env').write_text(
    'NODE_NAME="Test receiver"        # quoted value with an inline comment\n'
    'KEEP_HOURS=48                    # inline comment\n'
    '# a full-line comment\n'
    'WHISPER_MODEL=tiny.en\n')
os.environ.update({
    'NODE_ENV_FILE': str(WORK / 'node.env'), 'FESTIVAL_ID': 'hulaween-2026', 'NODE_KEY': 'test-node',
    'RECORDINGS_DIR': str(WORK / 'recordings'), 'PUBLIC_DIR': str(WORK / 'public'), 'BACKEND_URL': 'http://127.0.0.1:9/',
})
sys.path.insert(0, str(HERE))
import uploader  # noqa: E402  (needs the environment above)

SAMPLES = json.loads((HERE.parent / 'backend' / 'test' / 'fixtures' / 'hazard-samples.json').read_text())


def write_call(name='call', length=6.0, start=None, talkgroup_tag='SO Dispatch'):
    """A finished trunk-recorder call: .wav plus .json, in a dated subfolder like the real thing."""
    start = start or (time.time() - 30)
    folder = uploader.RECORDINGS / 'county' / '2026' / '10' / '24'
    folder.mkdir(parents=True, exist_ok=True)
    wav = folder / f'{name}.wav'
    wav.write_bytes(b'RIFF' + bytes(60))
    (folder / f'{name}.json').write_text(json.dumps({
        'freq': 770506250, 'start_time': start, 'stop_time': start + length, 'call_length': length,
        'talkgroup': 1001, 'talkgroup_tag': talkgroup_tag, 'talkgroup_description': 'Sheriff dispatch',
    }))
    return folder / f'{name}.json'


class FakeBackend(BaseHTTPRequestHandler):
    """Records what the node sends and answers with whatever the test put in `reply`."""
    reply = {'stored': False, 'reason': 'not safety-relevant'}
    status = 200
    seen = []

    def log_message(self, *a): pass

    def do_POST(self):
        body = self.rfile.read(int(self.headers['Content-Length']))
        msg = BytesParser(policy=email_default).parsebytes(b'Content-Type: ' + self.headers['Content-Type'].encode() + b'\r\n\r\n' + body)
        fields = {}
        for part in msg.iter_parts():
            name = part.get_param('name', header='content-disposition')
            fields[name] = part.get_payload(decode=True) if part.get_filename() else part.get_content()
            if part.get_filename(): fields[name + '.filename'] = part.get_filename()
        FakeBackend.seen.append({'path': self.path, 'key': self.headers.get('x-node-key'), 'fields': fields})
        data = json.dumps(FakeBackend.reply).encode()
        self.send_response(FakeBackend.status); self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data))); self.end_headers(); self.wfile.write(data)


class NodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.backend = HTTPServer(('127.0.0.1', 0), FakeBackend)
        threading.Thread(target=cls.backend.serve_forever, daemon=True).start()
        uploader.BACKEND_URL = f'http://127.0.0.1:{cls.backend.server_port}'
        cls.local = ThreadingHTTPServer(('127.0.0.1', 0), uploader.Handler)
        threading.Thread(target=cls.local.serve_forever, daemon=True).start()
        cls.local_url = f'http://127.0.0.1:{cls.local.server_port}'

    def setUp(self):
        del uploader.incidents[:]; del uploader.queue[:]
        FakeBackend.seen.clear(); FakeBackend.reply = {'stored': False, 'reason': 'not safety-relevant'}; FakeBackend.status = 200
        shutil.rmtree(uploader.RECORDINGS, ignore_errors=True); uploader.RECORDINGS.mkdir(parents=True)
        for f in (uploader.PUBLIC / 'audio').glob('*'): f.unlink()
        uploader.transcribe = lambda path: None

    def audio_files(self):
        return sorted(p.name for p in (uploader.PUBLIC / 'audio').iterdir())

    # ---- configuration -------------------------------------------------

    def test_env_file_strips_inline_comments_and_quotes_and_yields_to_real_environment(self):
        self.assertEqual(uploader.NODE_NAME, 'Test receiver')
        self.assertEqual(uploader.KEEP_HOURS, 48)
        self.assertEqual(uploader.WHISPER_MODEL, 'tiny.en')
        self.assertEqual(uploader.FESTIVAL_ID, 'hulaween-2026')          # from os.environ, not the file
        parsed = uploader._parse_env(HERE / 'node.env.example')
        self.assertEqual(parsed['NODE_NAME'], 'Fieldwatch receiver')
        self.assertEqual(parsed['FESTIVAL_ID'], 'hulaween-2026')
        self.assertEqual(parsed['NODE_KEY'], 'change-me-too')

    def test_classify_agrees_with_the_backend_on_the_shared_samples(self):
        for s in SAMPLES:
            got = uploader.classify(s['text'])
            expected = None if s['category'] is None else (s['category'], s['level'])
            self.assertEqual(got, expected, s['text'])

    def test_redact_and_summarize(self):
        t = uploader.redact('Caller at 352-555-0142 says the tunnel is under water, plate ABC 1234, last name Johnson')
        self.assertNotIn('352-555-0142', t); self.assertNotIn('ABC 1234', t); self.assertNotIn('Johnson', t)
        self.assertIn('under water', t)
        self.assertEqual(uploader.summarize('Flooding on the camp road. Units responding.'), 'Flooding on the camp road.')
        self.assertEqual(len(uploader.summarize('x' * 400)), 160)

    # ---- one call through the pipeline ----------------------------------

    def test_hazard_call_is_kept_served_and_queued(self):
        uploader.transcribe = lambda path: 'Weather hold on the main stage, lightning within eight miles. Call 352-555-0142.'
        meta = write_call()
        uploader.process_call(meta)
        self.assertEqual(len(uploader.incidents), 1)
        i = uploader.incidents[0]
        self.assertEqual((i['category'], i['level'], i['source'], i['festivalId']), ('weather', 'warning', 'scanner', 'hulaween-2026'))
        self.assertTrue(i['id'].startswith('inc-'))
        self.assertNotIn('352-555-0142', i['transcript'])
        self.assertEqual(i['talkgroup'], 'SO Dispatch')
        self.assertTrue(i['occurredAt'].endswith('Z'))
        self.assertEqual(self.audio_files(), [i['audioFile']])
        self.assertEqual(i['audioURL'], f"/audio/{i['audioFile']}")
        self.assertFalse(meta.exists()); self.assertFalse(meta.with_suffix('.wav').exists(), 'the recording folder is left clean')
        self.assertEqual(len(uploader.queue), 1)
        self.assertEqual(uploader.queue[0]['id'], i['id'])
        # what phones on the node's Wi-Fi see
        health = json.loads(urlopen(f'{self.local_url}/health').read())
        self.assertEqual((health['festivalId'], health['name'], health['incidents']), ('hulaween-2026', 'Test receiver', 1))
        served = json.loads(urlopen(f'{self.local_url}/incidents').read())
        self.assertEqual(served[0]['id'], i['id'])
        self.assertNotIn('audioFile', served[0], 'internal file name is not exposed')
        self.assertEqual(urlopen(f"{self.local_url}{i['audioURL']}").read()[:4], b'RIFF')
        with self.assertRaises(HTTPError) as ctx:
            urlopen(f'{self.local_url}/audio/../incidents.json')
        self.assertEqual(ctx.exception.code, 404)

    def test_gossip_is_deleted_audio_included(self):
        uploader.transcribe = lambda path: 'Engine 4 clear, returning to quarters'
        meta = write_call()
        uploader.process_call(meta)
        self.assertEqual(uploader.incidents, []); self.assertEqual(uploader.queue, [])
        self.assertEqual(self.audio_files(), [])
        self.assertFalse(meta.exists()); self.assertFalse(meta.with_suffix('.wav').exists())

    def test_too_short_call_is_dropped_before_transcription(self):
        calls = []
        uploader.transcribe = lambda path: calls.append(path)
        meta = write_call(length=0.4)
        uploader.process_call(meta)
        self.assertEqual(calls, []); self.assertEqual(self.audio_files(), []); self.assertFalse(meta.exists())

    def test_without_whisper_the_call_is_queued_for_the_backend_but_not_shown_locally(self):
        meta = write_call()
        uploader.process_call(meta)
        self.assertEqual(uploader.incidents, [])
        self.assertEqual(len(uploader.queue), 1)
        self.assertEqual(uploader.queue[0]['id'], ''); self.assertEqual(uploader.queue[0]['transcript'], '')
        self.assertEqual(len(self.audio_files()), 1)

    # ---- upload ----------------------------------------------------------

    def test_upload_sends_multipart_with_key_and_drops_audio_the_backend_did_not_keep(self):
        uploader.process_call(write_call())            # unclassified locally
        self.assertTrue(uploader.upload_once())
        self.assertEqual(len(FakeBackend.seen), 1)
        req = FakeBackend.seen[0]
        self.assertEqual(req['path'], '/festivals/hulaween-2026/incidents')
        self.assertEqual(req['key'], 'test-node')
        self.assertEqual(req['fields']['id'], '')
        self.assertEqual(req['fields']['talkgroup'], 'SO Dispatch')
        self.assertTrue(req['fields']['occurredAt'].endswith('Z'))
        self.assertEqual(req['fields']['audio'][:4], b'RIFF')
        self.assertTrue(req['fields']['audio.filename'].endswith('.wav'))
        self.assertEqual(uploader.queue, [])
        self.assertEqual(self.audio_files(), [], 'nothing local points at this clip any more')
        self.assertFalse(uploader.upload_once(), 'empty queue')

    def test_upload_keeps_audio_for_an_incident_phones_can_still_fetch_locally(self):
        uploader.transcribe = lambda path: 'Shots fired near the north gate'
        uploader.process_call(write_call())
        iid = uploader.incidents[0]['id']
        FakeBackend.reply = {'stored': True, 'id': iid, 'category': 'threat', 'level': 'warning', 'published': True}
        self.assertTrue(uploader.upload_once())
        self.assertEqual(FakeBackend.seen[0]['fields']['id'], iid)
        self.assertEqual(FakeBackend.seen[0]['fields']['transcript'], uploader.incidents[0]['transcript'])
        self.assertEqual(uploader.queue, [])
        self.assertEqual(self.audio_files(), [uploader.incidents[0]['audioFile']])

    def test_failed_upload_stays_queued(self):
        uploader.process_call(write_call())
        FakeBackend.status = 500; FakeBackend.reply = {'error': 'server error'}
        with self.assertRaises(Exception):
            uploader.upload_once()
        self.assertEqual(len(uploader.queue), 1)
        self.assertEqual(len(self.audio_files()), 1)

    # ---- housekeeping ----------------------------------------------------

    def test_prune_drops_old_incidents_and_their_audio_and_saves_only_when_needed(self):
        uploader.transcribe = lambda path: 'Crowd surge at the barricade'
        uploader.process_call(write_call(start=time.time() - 60 * 3600))     # 60 h ago, older than KEEP_HOURS
        uploader.process_call(write_call(name='recent'))
        self.assertEqual(len(uploader.incidents), 2)
        before = uploader.STATE_FILE.stat().st_mtime_ns
        time.sleep(0.01)
        uploader.prune()
        self.assertEqual(len(uploader.incidents), 1)
        self.assertEqual(self.audio_files(), [uploader.incidents[0]['audioFile']])
        self.assertGreater(uploader.STATE_FILE.stat().st_mtime_ns, before)
        unchanged = uploader.STATE_FILE.stat().st_mtime_ns
        time.sleep(0.01)
        uploader.prune()
        self.assertEqual(uploader.STATE_FILE.stat().st_mtime_ns, unchanged, 'no rewrite when nothing expired (SD card wear)')

    def test_remove_tolerates_files_it_cannot_delete(self):
        uploader._perm_warned = False
        uploader.remove(WORK / 'does-not-exist.wav')      # missing is fine
        if os.geteuid() == 0:
            self.skipTest('root can delete anything; permission path not testable')
        locked = WORK / 'locked'; locked.mkdir(exist_ok=True)
        f = locked / 'call.wav'; f.write_bytes(b'x'); locked.chmod(0o555)
        try:
            uploader.remove(f)                             # must not raise
            self.assertTrue(f.exists()); self.assertTrue(uploader._perm_warned)
        finally:
            locked.chmod(0o755)


if __name__ == '__main__':
    unittest.main(verbosity=2)
