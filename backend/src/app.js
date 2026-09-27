import express from 'express';
import multer from 'multer';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { q } from './db.js';
import { buildPack } from './pack.js';
import { pollFestival, polledRecently } from './poller.js';
import { pushAlert } from './push.js';
import { INCIDENT_WINDOW_MS, classify, redact, summarize, transcribe } from './incidents.js';
import { iso } from './util.js';

export const app = express();
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

const loadFestival = (req, res, next) => {
  const f = q.festival(req.params.id);
  if (!f) return res.status(404).json({ error: 'no such festival' });
  req.festival = f;
  next();
};

const SEVERITIES = ['unknown', 'minor', 'moderate', 'severe', 'extreme'];
const AUTO_PUBLISH = process.env.INCIDENT_AUTO_PUBLISH !== 'false';
const validIso = s => (s && !Number.isNaN(Date.parse(s)) ? iso(new Date(s)) : null);

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
  console.log(`[${festival.id}] incident ${incident.category}/${incident.level}: ${incident.summary} push=${JSON.stringify(result)}`);
  return result;
}

app.get('/health', (req, res) => res.json({ ok: true, at: iso() }));

app.get('/festivals', (req, res) => res.json(q.allFestivals()));
app.get('/festivals/:id', loadFestival, (req, res) => res.json(req.festival));

app.get('/festivals/:id/pack', loadFestival, wrap(async (req, res) => {
  if (!polledRecently(req.festival.id)) { try { await pollFestival(req.festival); } catch {} }
  res.json(await buildPack(req.festival));
}));

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
  res.status(201).json({ id: String(info.lastInsertRowid), push });
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
  const f = { ...req.body, id: req.params.id };
  for (const k of ['name', 'location', 'county']) {
    if (typeof f[k] !== 'string' || !f[k].trim()) return res.status(400).json({ error: `${k} required` });
  }
  for (const k of ['latitude', 'longitude']) {
    if (!Number.isFinite(f[k]) || Math.abs(f[k]) > (k === 'latitude' ? 90 : 180)) return res.status(400).json({ error: `${k} must be a number in range` });
  }
  for (const k of ['startDate', 'endDate']) {
    if (!validIso(f[k])) return res.status(400).json({ error: `${k} must be ISO 8601` });
  }
  if (Date.parse(f.endDate) < Date.parse(f.startDate)) return res.status(400).json({ error: 'endDate is before startDate' });
  f.isPartner = Boolean(f.isPartner); f.feeds = Array.isArray(f.feeds) ? f.feeds : []; f.site = Array.isArray(f.site) ? f.site : [];
  q.upsertFestival(f);
  res.json(f);
});

app.post('/devices', (req, res) => {
  const { token, festivalId } = req.body || {};
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return res.status(400).json({ error: 'valid APNs token required' });
  q.upsertDevice(token, festivalId || null);
  res.json({ ok: true });
});
app.delete('/devices/:token', (req, res) => { q.deleteDevice(req.params.token); res.json({ ok: true }); });

// ---- Errors, always as JSON ----------------------------------------------

app.use((req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'too large' });
  console.error(err);
  res.status(500).json({ error: 'server error' });
});
