import express from 'express';
import multer from 'multer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { q } from './db.js';
import { buildPack } from './pack.js';
import { festivalsInWindow, pollFestival, polledRecently } from './poller.js';
import { pushAlert } from './push.js';
import { pushWeb, pushWelcome, validSubscription, vapidPublicKey, webPushEnabled } from './webpush.js';
import QRCode from 'qrcode';
import { RADAR_DIR, noteInterest, radarLoop, refreshRadarSoon } from './radar.js';
import { INCIDENT_WINDOW_MS, classify, redact, summarize, transcribe } from './incidents.js';
import { isLive, normalizeFestival, slug, validIso } from './festivals.js';
import { imports, runImports } from './importers/index.js';
import { skipReason as wikidataSkipped } from './importers/wikidata.js';
import { lightningFor, lightningOn, lightningStatus } from './lightning.js';
import { groundFor, groundStatus } from './ground.js';
import { iso } from './util.js';

export const app = express();
// The web build calls this API from another origin (GitHub Pages, a phone's home screen).
// Keyed routes stay keyed; CORS only decides which pages a browser lets talk to us at all.
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-admin-key, x-node-key');
  res.set('Access-Control-Max-Age', '86400');
  if (CORS_ORIGIN !== '*') res.set('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.json({ limit: '64kb' }));
// Behind Fly/Railway/nginx, set TRUST_PROXY to the number of proxy hops so req.ip
// (used for the report rate limit) is the phone, not the load balancer.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

const AUDIO_DIR = resolve(process.env.AUDIO_DIR || 'audio');
mkdirSync(AUDIO_DIR, { recursive: true });
const upload = multer({
  storage: multer.diskStorage({
    destination: AUDIO_DIR,
    filename: (req, file, cb) => cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}.${(file.originalname.split('.').pop() || 'wav').toLowerCase()}`),
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
});
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1d', immutable: true }));
mkdirSync(RADAR_DIR, { recursive: true });
app.use('/radar', express.static(RADAR_DIR, { maxAge: '7d', immutable: true }));   // frames never change

// Express 4 doesn't catch rejected promises from async handlers; this does.
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const sameKey = (given, expected) => {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};
const keyed = (header, envName) => (req, res, next) =>
  sameKey(req.get(header), process.env[envName]) ? next() : res.status(401).json({ error: `${header} required` });
const requireAdmin = keyed('x-admin-key', 'ADMIN_KEY');
const requireNode = keyed('x-node-key', 'NODE_KEY');

const isAdmin = req => sameKey(req.get('x-admin-key'), process.env.ADMIN_KEY);
const loadFestival = (req, res, next) => {
  const f = q.festival(req.params.id);
  if (!f || ((f.status || 'published') !== 'published' && !isAdmin(req))) return res.status(404).json({ error: 'no such festival' });
  req.festival = f;
  next();
};

const SEVERITIES = ['unknown', 'minor', 'moderate', 'severe', 'extreme'];
const AUTO_PUBLISH = process.env.INCIDENT_AUTO_PUBLISH !== 'false';

/** The shape phones already understand, so an incident can ride the same banner and push path. */
export function incidentToAlert(festival, i) {
  const titles = {
    threat: 'Security incident', evacuation: 'Evacuation notice', weather: 'Weather hazard', flood: 'Flooding reported',
    fire: 'Fire reported', missing: 'Missing person', medical: 'Medical emergency', crowd: 'Crowd hazard', traffic: 'Road or gate closure',
  };
  const sources = { scanner: 'County dispatch, via on-site receiver', attendee: 'Attendee report', official: `${festival.name} staff` };
  return {
    id: i.id, event: titles[i.category] || 'Incident', headline: i.location ? `${i.location}` : null, body: i.summary, instruction: null,
    severity: i.level === 'warning' ? 'severe' : 'moderate', area: i.location || festival.name, source: sources[i.source] || i.source,
    issuedAt: i.occurredAt, expiresAt: iso(new Date(Date.parse(i.occurredAt) + 6 * 3600_000)), channel: 'incident', relayCount: 0,
  };
}

async function publishAndPush(festival, incident) {
  q.publishIncident(incident.id);
  const alert = incidentToAlert(festival, incident);
  const result = await pushAlert(q.tokensFor(festival.id), festival, alert);
  result.web = await pushWeb(festival, alert);
  console.log(`[${festival.id}] incident ${incident.category}/${incident.level}: ${incident.summary} push=${JSON.stringify(result)}`);
  return result;
}

// A page to open in a browser when the app says it cannot reach the backend: which build this is, where its data
// lives, which sources have keys and whether an import has run. No secrets: a key is reported as set or not.
app.get('/health', (req, res) => res.set('Cache-Control', 'no-store').json({
  ok: true, at: iso(),
  build: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
  uptimeSeconds: Math.round(process.uptime()),
  database: { path: process.env.DB_PATH || 'fieldwatch.db', onVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH) },
  festivals: q.publishedFestivals().length,
  push: { web: webPushEnabled() },
  adminKey: Boolean(process.env.ADMIN_KEY),
  nwsUserAgent: !process.env.NWS_USER_AGENT || /example\.com/.test(process.env.NWS_USER_AGENT) ? 'placeholder' : 'set',
  sources: { ticketmaster: Boolean(process.env.TICKETMASTER_KEY), seatgeek: Boolean(process.env.SEATGEEK_CLIENT_ID), edmtrain: Boolean(process.env.EDMTRAIN_KEY), wikidata: wikidataSkipped() || 'on', feeds: Boolean(process.env.FESTIVAL_FEEDS) },
  lightning: lightningStatus(),
  ground: groundStatus(),
  imports: { running: imports.running, lastStartedAt: imports.last?.startedAt || null, lastFinishedAt: imports.last?.finishedAt || null,
    // Per source, what the last run managed and the last error it hit, so a failing key or a blocked host shows here.
    sources: Object.fromEntries(Object.entries(imports.last || {}).filter(([, v]) => v && typeof v === 'object')
      .map(([k, v]) => [k, v.skipped ? { skipped: v.skipped } : { calls: v.calls ?? 0, errors: v.errors ?? 0, festivals: v.festivals ?? 0, added: v.added ?? 0, ...(v.lastError && { lastError: v.lastError }), ...(v.error && { error: v.error }) }])) },
}));

// ---- Festivals: the list itself ------------------------------------------
// What is on: grounds open through the day after the end (festivals.js). ?all=1 for everything published.
app.get('/festivals', (req, res) => {
  // ?all=1 is the whole published list; with the admin key, ?hidden=1 adds what staff hid, so it can be unhidden.
  if (req.query.all && req.query.hidden && isAdmin(req)) return res.json(q.allFestivals().filter(f => ['published', 'hidden'].includes(f.status || 'published')));
  const all = q.publishedFestivals(); res.json(req.query.all ? all : all.filter(f => isLive(f)));
});
// The home page: every current alert at every festival that is on, grouped by festival, the worst first. Lightning within
// 15 miles (code red or orange) puts a festival on the page too; red is an alert already, orange is its own row.
const RANK = { extreme: 4, severe: 3, moderate: 2, minor: 1 };
app.get('/alerts', (req, res) => {
  const on = festivalsInWindow(), rank = a => RANK[String(a.severity || '').toLowerCase()] || 0;
  const items = on.map(f => ({ festival: f, alerts: q.activeAlerts(f.id).sort((a, b) => rank(b) - rank(a)), lightning: lightningFor(f.id) })).filter(i => i.alerts.length || ['red', 'orange'].includes(i.lightning?.code));
  const top = i => Math.max(i.alerts[0] ? rank(i.alerts[0]) : 0, i.lightning?.code === 'red' ? 3 : i.lightning?.code === 'orange' ? 2 : 0);
  items.sort((a, b) => top(b) - top(a) || Date.parse(a.festival.startDate) - Date.parse(b.festival.startDate));
  res.set('Cache-Control', 'no-store').json({ at: iso(), on: on.length, items });
});
// A listing the importers got wrong (a concert, a tour, a car show) goes out of sight; an import keeps it hidden.
const setStatus = status => (req, res) => {
  const f = q.festival(req.params.id);
  if (!f) return res.status(404).json({ error: 'no such festival' });
  q.upsertFestival({ ...f, status });
  res.json({ ok: true, id: f.id, status });
};
app.post('/festivals/:id/hide', requireAdmin, setStatus('hidden'));
app.post('/festivals/:id/unhide', requireAdmin, setStatus('published'));
app.get('/festivals/pending', requireAdmin, (req, res) => res.json(q.pendingFestivals()));
app.get('/festivals/:id', loadFestival, (req, res) => res.json(req.festival));

// A QR code that opens the web build straight on this festival: print it at the gate, put it on the screens.
const SITE_URL = (process.env.SITE_URL || 'https://brandynvandal-photography.github.io/Fieldwatch/').replace(/\/?$/, '/');
export const festivalLink = id => `${SITE_URL}?f=${encodeURIComponent(id)}`;
app.get('/festivals/:id/qr.svg', loadFestival, wrap(async (req, res) => {
  const svg = await QRCode.toString(festivalLink(req.festival.id), { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1A1533ff', light: '#00000000' } });
  res.set('Cache-Control', 'public, max-age=86400').type('image/svg+xml').send(svg);
}));

// Anyone can add a festival; it waits for an admin, and nothing a stranger sends becomes a partner feed or a site map.
const suggestTimes = new Map();
app.post('/festivals', (req, res) => {
  const ip = req.ip, now = Date.now();
  const recent = (suggestTimes.get(ip) || []).filter(t => now - t < 3_600_000);
  if (recent.length >= 3) return res.status(429).json({ error: 'too many suggestions, try again later' });
  suggestTimes.set(ip, [...recent, now]);
  const body = req.body || {};
  const { festival, error } = normalizeFestival(body, { origin: 'community', status: 'pending', id: `sub-${slug(body.name || 'festival') || 'festival'}-${randomUUID().slice(0, 6)}` });
  if (error) return res.status(400).json({ error });
  Object.assign(festival, { isPartner: false, feeds: [], site: [], featured: false, submittedAt: iso() });
  q.upsertFestival(festival);
  console.log(`[festivals] suggested: ${festival.name} (${festival.location}) ${festival.startDate.slice(0, 10)}`);
  res.status(202).json({ id: festival.id, pending: true });
});
app.post('/festivals/:id/approve', requireAdmin, (req, res) => {
  const f = q.festival(req.params.id);
  if (!f) return res.status(404).json({ error: 'no such festival' });
  const { festival, error } = normalizeFestival(req.body || {}, { base: f });
  if (error) return res.status(400).json({ error });
  festival.status = 'published';
  q.upsertFestival(festival);
  res.json(festival);
});
app.delete('/festivals/:id', requireAdmin, (req, res) => { q.deleteFestival(req.params.id); res.json({ ok: true }); });
// Starts a run and answers at once; a run can take minutes (the Wikidata pass reads festival sites), longer than a phone waits.
app.post('/admin/import', requireAdmin, (req, res) => {
  const already = imports.running;
  runImports().catch(() => {});
  res.status(202).json({ started: !already, running: true, last: imports.last });
});

app.get('/festivals/:id/pack', loadFestival, wrap(async (req, res) => {
  if (!polledRecently(req.festival.id)) { try { await pollFestival(req.festival); } catch {} }
  noteInterest(req.festival.id); refreshRadarSoon(req.festival);
  res.json(await buildPack(req.festival));
}));

/** The ground under the festival: what the record says about it, and the rain of the last two days (ground.js). */
app.get('/festivals/:id/ground', loadFestival, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json(await groundFor(req.festival))));

/** Lightning near the festival right now (lightning.js): the code, the nearest flash, counts by ring, the all-clear time. */
app.get('/festivals/:id/lightning', loadFestival, (req, res) => res.set('Cache-Control', 'no-store').json(lightningFor(req.festival.id) || { code: 'none', at: iso(), on: lightningOn(), source: 'GOES GLM' }));

/** The radar loop: what's on disk right now, with a refresh kicked off in the background if it's due. */
app.get('/festivals/:id/radar', loadFestival, (req, res) => {
  noteInterest(req.festival.id); refreshRadarSoon(req.festival);
  res.json(radarLoop(req.festival));
});

app.get('/festivals/:id/alerts', loadFestival, wrap(async (req, res) => {
  if (!polledRecently(req.festival.id)) { try { await pollFestival(req.festival); } catch {} }
  res.json(q.activeAlerts(req.festival.id));
}));

app.get('/festivals/:id/posts', loadFestival, (req, res) => res.json(q.posts(req.festival.id)));

app.post('/festivals/:id/posts', requireAdmin, loadFestival, wrap(async (req, res) => {
  const { title, body, severity = 'minor' } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'title and body required' });
  if (!SEVERITIES.includes(severity)) return res.status(400).json({ error: `severity must be one of ${SEVERITIES.join(', ')}` });
  const info = q.insertPost(req.festival.id, title, body);
  const alert = {
    id: `official-${req.festival.id}-${info.lastInsertRowid}`,
    event: title, headline: null, body, instruction: null, severity,
    area: req.festival.name, source: `${req.festival.name} staff`,
    issuedAt: iso(), expiresAt: null, channel: 'official', relayCount: 0,
  };
  const push = await pushAlert(q.tokensFor(req.festival.id), req.festival, alert);
  const web = await pushWeb(req.festival, alert);
  res.status(201).json({ id: String(info.lastInsertRowid), push, web });
}));

// ---- Incidents -----------------------------------------------------------

app.get('/festivals/:id/incidents', loadFestival, (req, res) =>
  res.json(q.publishedIncidents(req.festival.id, Date.now() - INCIDENT_WINDOW_MS)));

/**
 * A receiver node uploads one radio call. multipart/form-data:
 *   audio       the clip (wav/m4a/mp3), optional
 *   transcript  text, optional; transcribed here if missing and OPENAI_API_KEY is set
 *   talkgroup   label from the scanner, e.g. "Licking SO Dispatch"
 *   id          the node's incident id (inc-<uuid>), optional
 *   occurredAt  ISO 8601 (defaults to now)
 * Non-safety traffic is dropped, audio included. Nothing is kept that isn't a hazard.
 */
app.post('/festivals/:id/incidents', requireNode, loadFestival, upload.single('audio'), wrap(async (req, res) => {
  const f = req.festival;
  const drop = () => (req.file ? unlink(req.file.path).catch(() => {}) : Promise.resolve());
  // Keep the node's id when it sent one, so a phone that saw the incident locally doesn't get a duplicate.
  const nodeID = /^inc-[0-9a-f-]{36}$/.test(req.body.id || '') ? req.body.id : null;
  if (nodeID && q.incident(nodeID)) { await drop(); return res.json({ stored: true, id: nodeID, duplicate: true }); }

  let transcript = (req.body.transcript || '').trim();
  if (!transcript && req.file) {
    try { transcript = (await transcribe(await readFile(req.file.path), req.file.filename)) || ''; }
    catch (e) { console.error('transcribe failed:', e.message); }
  }
  const hit = classify(transcript);
  if (!hit) { await drop(); return res.json({ stored: false, reason: 'not safety-relevant' }); }

  const incident = {
    id: nodeID || `inc-${randomUUID()}`, festivalId: f.id, category: hit.category, level: hit.level,
    summary: summarize(transcript), transcript: redact(transcript), source: 'scanner',
    talkgroup: req.body.talkgroup || null, location: req.body.location || null,
    audioFile: req.file?.filename || null, occurredAt: validIso(req.body.occurredAt) || iso(), published: 0,
  };
  q.insertIncident(incident);
  const push = AUTO_PUBLISH ? await publishAndPush(f, incident) : { queued: true };
  res.status(201).json({ stored: true, id: incident.id, category: hit.category, level: hit.level, published: AUTO_PUBLISH, push });
}));

// Attendee reports always go to the moderation queue.
const reportTimes = new Map();
app.post('/festivals/:id/reports', loadFestival, (req, res) => {
  const ip = req.ip; const now = Date.now();
  const recent = (reportTimes.get(ip) || []).filter(t => now - t < 600_000);
  if (recent.length >= 5) return res.status(429).json({ error: 'too many reports, try again later' });
  reportTimes.set(ip, [...recent, now]);

  const { summary, category, location, latitude, longitude } = req.body || {};
  if (!summary || String(summary).length < 8) return res.status(400).json({ error: 'summary required' });
  const hit = classify(summary) || { category: category || 'other', level: 'advisory' };
  const incident = {
    id: `rep-${randomUUID()}`, festivalId: req.festival.id, category: hit.category, level: hit.level,
    summary: summarize(summary), transcript: redact(summary), source: 'attendee',
    location: location || null, latitude: Number(latitude) || null, longitude: Number(longitude) || null,
    occurredAt: iso(), published: 0,
  };
  q.insertIncident(incident);
  res.status(202).json({ id: incident.id, queued: true });
});

app.get('/festivals/:id/incidents/pending', requireAdmin, loadFestival, (req, res) => res.json(q.pendingIncidents(req.festival.id)));
app.post('/festivals/:id/incidents/:iid/publish', requireAdmin, loadFestival, wrap(async (req, res) => {
  const i = q.incident(req.params.iid);
  if (!i || i.festivalId !== req.festival.id) return res.status(404).json({ error: 'no such incident' });
  if (req.body?.summary) {
    q.updateIncidentText(i.id, req.body.summary, i.transcript, req.body.category || i.category, req.body.level || i.level);
    Object.assign(i, { summary: req.body.summary, category: req.body.category || i.category, level: req.body.level || i.level });
  }
  res.json({ id: i.id, push: await publishAndPush(req.festival, i) });
}));
app.delete('/festivals/:id/incidents/:iid', requireAdmin, loadFestival, (req, res) => { q.deleteIncident(req.params.iid); res.json({ ok: true }); });

// ---- Admin and devices ---------------------------------------------------

app.put('/festivals/:id', requireAdmin, (req, res) => {
  const { festival, error } = normalizeFestival(req.body || {}, { base: q.festival(req.params.id), id: req.params.id });
  if (error) return res.status(400).json({ error });
  festival.id = req.params.id; festival.status = 'published';
  q.upsertFestival(festival);
  res.json(festival);
});

app.post('/devices', (req, res) => {
  const { token, festivalId } = req.body || {};
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return res.status(400).json({ error: 'valid APNs token required' });
  q.upsertDevice(token, festivalId || null);
  res.json({ ok: true });
});
app.delete('/devices/:token', (req, res) => { q.deleteDevice(req.params.token); res.json({ ok: true }); });

// ---- Web push: the web build's warnings, same alerts as APNs -------------

app.get('/push/vapid', (req, res) => (webPushEnabled() ? res.json({ key: vapidPublicKey() }) : res.status(404).json({ error: 'web push not configured' })));
app.post('/push/subscribe', wrap(async (req, res) => {
  if (!webPushEnabled()) return res.status(404).json({ error: 'web push not configured' });
  // quiet: a phone registering again on open (after a redeploy, say) wants no welcome notification.
  const { subscription, festivalId, point, quiet } = req.body || {};
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'a push subscription with endpoint and keys is required' });
  if (festivalId && !q.festival(festivalId)) return res.status(404).json({ error: 'no such festival' });
  // A phone with no festival follows a point: wherever it is, rounded to about a kilometre, so a warning for that spot reaches it.
  const lat = Number(point?.latitude), lon = Number(point?.longitude);
  const at = !festivalId && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100 } : null;
  if (!festivalId && !at) return res.status(400).json({ error: 'festivalId or point required' });
  const clean = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
  q.upsertWebSubscription(subscription.endpoint, festivalId || null, clean, at);
  const target = festivalId ? q.festival(festivalId) : { id: 'here', name: 'Where you are', ...at };
  res.json({ ok: true, welcome: quiet ? false : await pushWelcome(clean, target) });
}));
app.get('/admin/import', requireAdmin, (req, res) => res.json({ ...(imports.last || { never: true }), running: imports.running }));
app.delete('/push/subscribe', (req, res) => {
  const endpoint = req.body?.endpoint || req.query.endpoint;
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  q.deleteWebSubscription(String(endpoint));
  res.json({ ok: true });
});

// ---- Errors, always as JSON ----------------------------------------------

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too large' });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});
