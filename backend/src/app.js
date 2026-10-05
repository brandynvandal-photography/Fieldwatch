import express from 'express';
import multer from 'multer';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { q } from './db.js';
import { buildPack } from './pack.js';
import { festivalsInWindow, pollFestival, polledRecently, pollingStatus } from './poller.js';
import { pushAlert, pushEnded } from './push.js';
import { limit, limitStatus, resetLimits } from './limits.js';
import { expect } from './expect.js';
import { housekeepingStatus, runHousekeeping } from './housekeeping.js';
import { pushWeb, pushWelcome, validSubscription, vapidPublicKey, webPushEnabled, pushEnded as pushEndedWeb } from './webpush.js';
import { SITE, USER_AGENT, placeholderAgent } from './site.js';
import { adminKeyStatus, ensureAdminKey, hashKey, isAdminKey, sameKey } from './adminkey.js';
import QRCode from 'qrcode';
import { RADAR_DIR, noteInterest, radarLoop, radarStatus, refreshRadarSoon } from './radar.js';
import { backupNow, backupStatus, backups } from './backup.js';
import { INCIDENT_WINDOW_MS, classify, redact, summarize, transcribe } from './incidents.js';
import { isLive, normalizeFestival, slug, validIso } from './festivals.js';
import { imports, runImports } from './importers/index.js';
import { skipReason as wikidataSkipped } from './importers/wikidata.js';
import { flashesFor, lightningAt, lightningFor, lightningOn, lightningStatus } from './lightning.js';
import { GROUND_STATES, groundFor, groundStatus, lookupGround, reportGround, reportSummary, validOverride } from './ground.js';
import { nowcastFor } from './nowcast.js';
import { snapToGrounds } from './grounds.js';
import { changed, liveCount, sse } from './live.js';
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

// The admin key: ADMIN_KEY if set, else one the server made on first boot and keeps hashed (adminkey.js); server.js prints a new one once.
export const adminKeyBoot = ensureAdminKey();
const isAdmin = req => isAdminKey(req.get('x-admin-key'));
const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: 'x-admin-key required' }));
// Receiver nodes share NODE_KEY. Without one there is no node, and the upload routes answer 401.
const requireNode = (req, res, next) => (sameKey(req.get('x-node-key'), process.env.NODE_KEY) ? next() : res.status(401).json({ error: 'x-node-key required' }));

// A festival's own staff key: issued by the admin, held by the festival's safety team, good for that festival's posts,
// moderation, ground and record, nothing else. Kept hashed; shown once when issued. Not an account: nothing names a person.
const partnerOf = req => { const given = req.get('x-admin-key'); if (!given) return null; const h = hashKey(given); return q.partnerKeys().find(p => sameKey(h, p.hash))?.festivalId || null; };
const requireStaff = (req, res, next) => isAdmin(req) || partnerOf(req) === req.params.id ? next() : res.status(401).json({ error: 'x-admin-key required' });
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
// lives, which sources have keys and whether an import has run. No secrets: a key is reported by where it comes from, never itself.
/** What a monitor should alert on: no successful alert poll in ten minutes, no lightning file in five, while a festival is on. The rest is a warning. */
export function healthProblems({ on = festivalsInWindow().length } = {}) {
  const ageMin = t => t ? (Date.now() - Date.parse(t)) / 60_000 : null;
  const problems = [], warnings = [], p = pollingStatus(), l = lightningStatus(), r = radarStatus(), b = backupStatus();
  if (on && p.lastRunAt && (!p.lastOkAt || ageMin(p.lastOkAt) > 10)) problems.push(p.lastOkAt ? `alerts: no successful poll in ${Math.round(ageMin(p.lastOkAt))} min${p.lastError ? ` (${p.lastError})` : ''}` : `alerts: no successful poll yet${p.lastError ? ` (${p.lastError})` : ''}`);
  if (on && l.on && l.lastTickAt && (!l.lastFileAt || ageMin(l.lastFileAt) > 5)) problems.push(l.lastFileAt ? `lightning: last file ${Math.round(ageMin(l.lastFileAt))} min ago` : 'lightning: no file read yet');
  if (r.lastError && (!r.lastOkAt || Date.parse(r.errorAt) > Date.parse(r.lastOkAt))) warnings.push(`radar: ${r.lastError}`);
  if (process.env.NWS_USER_AGENT && placeholderAgent(process.env.NWS_USER_AGENT)) warnings.push('NWS_USER_AGENT names example.com and is ignored; the default names the site');
  if (process.env.RAILWAY_ENVIRONMENT && !process.env.RAILWAY_VOLUME_MOUNT_PATH) warnings.push('no volume: the database, the admin key and the push keys are lost on every deploy');
  if (!webPushEnabled()) warnings.push('web push off: no VAPID keys');
  if (b.lastError) warnings.push(`backup: ${b.lastError}`);
  const g = groundStatus().lookups; if (g.streak >= 3) warnings.push(`ground: ${g.streak} lookups failed in a row (${g.lastError})`);
  const h = housekeepingStatus(); if (h.lastError) warnings.push(`housekeeping: ${h.lastError}`);
  return { problems, warnings };
}
// ?strict=1 answers 503 while there is a problem, for a monitor that only reads status codes. Without it the body says.
app.get('/health', (req, res) => { const { problems, warnings } = healthProblems(); res.status(req.query.strict && problems.length ? 503 : 200).set('Cache-Control', 'no-store').json({
  ok: !problems.length, problems, warnings, at: iso(),
  build: (process.env.RAILWAY_GIT_COMMIT_SHA || '').slice(0, 7) || null,
  uptimeSeconds: Math.round(process.uptime()),
  database: { path: process.env.DB_PATH || 'fieldwatch.db', onVolume: Boolean(process.env.RAILWAY_VOLUME_MOUNT_PATH) },
  festivals: q.publishedFestivals().length,
  push: { web: webPushEnabled() },
  adminKey: adminKeyStatus().source,
  nwsUserAgent: placeholderAgent(process.env.NWS_USER_AGENT) ? 'default' : 'set', userAgent: USER_AGENT,
  sources: { ticketmaster: Boolean(process.env.TICKETMASTER_KEY), seatgeek: Boolean(process.env.SEATGEEK_CLIENT_ID), edmtrain: Boolean(process.env.EDMTRAIN_KEY), wikidata: wikidataSkipped() || 'on', feeds: Boolean(process.env.FESTIVAL_FEEDS) },
  lightning: lightningStatus(),
  ground: groundStatus(),
  housekeeping: housekeepingStatus(),
  limits: limitStatus(),
  live: liveCount(),
  imports: { running: imports.running, lastStartedAt: imports.last?.startedAt || null, lastFinishedAt: imports.last?.finishedAt || null,
    // Per source, what the last run managed and the last error it hit, so a failing key or a blocked host shows here.
    sources: Object.fromEntries(Object.entries(imports.last || {}).filter(([, v]) => v && typeof v === 'object')
      .map(([k, v]) => [k, v.skipped ? { skipped: v.skipped } : { calls: v.calls ?? 0, errors: v.errors ?? 0, festivals: v.festivals ?? 0, added: v.added ?? 0, ...(v.lastError && { lastError: v.lastError }), ...(v.error && { error: v.error }) }])) },
  polling: pollingStatus(), radar: radarStatus(), backups: backupStatus(),
}); });

// ---- Festivals: the list itself ------------------------------------------
// What is on: grounds open through the day after the end (festivals.js). ?all=1 for everything published.
app.get('/festivals', (req, res) => {
  // ?all=1 is the whole published list; with the admin key, ?hidden=1 adds what staff hid, so it can be unhidden.
  if (req.query.all && req.query.hidden && isAdmin(req)) return res.json(q.allFestivals().filter(f => ['published', 'hidden'].includes(f.status || 'published')));
  const all = q.publishedFestivals(); res.json(req.query.all ? all : all.filter(f => isLive(f)));
});
/** The live stream (live.js): `?f=<id>` for one festival, nothing for all of them. */
app.get('/events', sse);

// The home page: every current alert at every festival that is on, grouped by festival, the worst first. Lightning within
// 15 miles (code red or orange) puts a festival on the page too; red is an alert already, orange is its own row.
const RANK = { extreme: 4, severe: 3, moderate: 2, minor: 1 };
app.get('/alerts', (req, res) => {
  q.count('*', 'feed');
  const on = festivalsInWindow(), rank = a => RANK[String(a.severity || '').toLowerCase()] || 0;
  const items = on.map(f => ({ festival: f, alerts: q.activeAlerts(f.id).sort((a, b) => rank(b) - rank(a)), lightning: lightningFor(f.id) })).filter(i => i.alerts.length || ['red', 'orange'].includes(i.lightning?.code));
  const top = i => Math.max(i.alerts[0] ? rank(i.alerts[0]) : 0, i.lightning?.code === 'red' ? 3 : i.lightning?.code === 'orange' ? 2 : 0);
  items.sort((a, b) => top(b) - top(a) || Date.parse(a.festival.startDate) - Date.parse(b.festival.startDate));
  // The lightning code of every festival that is on, alerts or not, so the home page can show it beside each name.
  const codes = Object.fromEntries(on.map(f => [f.id, lightningFor(f.id)]).filter(([, l]) => l));
  res.set('Cache-Control', 'no-store').json({ at: iso(), on: on.length, items, codes });
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
app.post('/festivals', limit('suggest', 3, 3_600_000, 'suggestions'), (req, res) => {
  const body = req.body || {};
  const { festival: raw, error } = normalizeFestival(body, { origin: 'community', status: 'pending', id: `sub-${slug(body.name || 'festival') || 'festival'}-${randomUUID().slice(0, 6)}` });
  if (error) return res.status(400).json({ error });
  const festival = snapToGrounds(raw);
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
  q.count(req.festival.id, 'pack');
  res.json(await buildPack(req.festival));
}));

/** The ground under the festival: what the record says about it, and the rain of the last two days (ground.js). */
app.get('/festivals/:id/ground', loadFestival, wrap(async (req, res) => res.set('Cache-Control', 'no-store').json({ ...(await groundFor(req.festival)), reports: reportSummary(q, req.festival.id) })));
/** One tap from the field: fine, soft, mud or water. Stored with the rain the model counts right now, so the venue learns what it takes. */
app.post('/festivals/:id/ground/report', loadFestival, wrap(async (req, res) => {
  if (!GROUND_STATES.includes(String(req.body?.state || ''))) return res.status(400).json({ error: `state must be one of ${GROUND_STATES.join(', ')}` });
  if ((await import('./limits.js')).limited('ground-report', req.ip, 5, 600_000)) return res.status(429).json({ error: 'too many reports, try again later' });
  const now = Date.now();
  const r = await reportGround(req.festival, String(req.body?.state || ''), { now, q, save: f => q.upsertFestival(f) });
  if (r.error) return res.status(400).json({ error: r.error });
  changed(req.festival.id, 'ground'); q.count(req.festival.id, 'ground.report');
  res.json({ ...r, reports: reportSummary(q, req.festival.id, now) });
}));

/** Staff set what the lookups cannot see: the surface, how it drains, low ground, and what is standing (canopies, inflatables, a stage). */
app.put('/festivals/:id/ground', requireStaff, loadFestival, wrap(async (req, res) => {
  const { override, error } = validOverride(req.body || {});
  if (error) return res.status(400).json({ error });
  const f = { ...req.festival, ground: { ...(req.festival.ground || {}), override } };
  q.upsertFestival(f);
  res.json(await groundFor(f));
}));
app.delete('/festivals/:id/ground', requireStaff, loadFestival, wrap(async (req, res) => {
  const { override, ...rest } = req.festival.ground || {};
  const f = { ...req.festival, ground: rest };
  q.upsertFestival(f);
  res.json(await groundFor(f));
}));
/** Run the surface and soil lookups again now (they otherwise run once, for a festival that is on). */
app.post('/festivals/:id/ground/lookup', requireStaff, loadFestival, wrap(async (req, res) => {
  const ground = await lookupGround(req.festival, { save: f => q.upsertFestival(f) });
  res.json(await groundFor({ ...req.festival, ground }));
}));

/** Lightning near the festival right now (lightning.js): the code, the nearest flash, counts by ring, the all-clear time. */
/** The flashes behind the code, for the radar map: within twenty miles, the last half hour, newest first. */
app.get('/festivals/:id/lightning/flashes', loadFestival, (req, res) => res.set('Cache-Control', 'no-store').json({ festivalId: req.festival.id, at: iso(), on: lightningOn(), flashes: flashesFor(req.festival) }));
app.get('/festivals/:id/lightning', loadFestival, (req, res) => res.set('Cache-Control', 'no-store').json(lightningFor(req.festival.id) || { code: 'none', at: iso(), on: lightningOn(), source: 'GOES GLM' }));

// A spot, festival or not: the lightning grade and the flashes for wherever a phone is standing. Asking keeps the spot in the reader's reach for a day.
const pointParam = (req, res, next) => {
  const m = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(String(req.params.at || ''));
  const lat = m ? Number(m[1]) : NaN, lon = m ? Number(m[2]) : NaN;
  if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return res.status(400).json({ error: 'lat,lon' });
  req.point = { latitude: lat, longitude: lon }; next();
};
app.get('/point/:at/lightning', pointParam, (req, res) => res.set('Cache-Control', 'no-store').json(lightningAt(req.point)));
app.get('/point/:at/lightning/flashes', pointParam, (req, res) => res.set('Cache-Control', 'no-store').json({ at: iso(), on: lightningOn(), flashes: flashesFor(req.point) }));

/** Where the rain on the radar is going and when it gets here, from the frames on disk (nowcast.js). */
app.get('/festivals/:id/nowcast', loadFestival, (req, res) => res.set('Cache-Control', 'no-store').json(nowcastFor(req.festival) || { at: null, tracked: false, minutes: null, reason: 'no radar frames yet' }));

/** The radar loop: what's on disk right now, with a refresh kicked off in the background if it's due. */
app.get('/festivals/:id/radar', loadFestival, (req, res) => {
  noteInterest(req.festival.id); refreshRadarSoon(req.festival);
  res.json(radarLoop(req.festival));
});

app.get('/festivals/:id/alerts', loadFestival, wrap(async (req, res) => {
  if (!polledRecently(req.festival.id)) { try { await pollFestival(req.festival); } catch {} }
  q.count(req.festival.id, 'alerts');
  res.json(q.activeAlerts(req.festival.id));
}));

app.get('/festivals/:id/posts', loadFestival, (req, res) => res.json(q.posts(req.festival.id)));

// A staff post is a notice, or a hold the safety team calls: shelter, evacuate or pause, which stands on the festival page as a
// warning until its end (an hour unless said), and the all-clear, which ends every hold standing and is said once. Holds are kept
// with the alerts so the page carries them; a notice is a post and a push, as before. The reach of every post is kept on it.
const KINDS = ['notice', 'shelter', 'evacuate', 'pause', 'allclear'], HOLDS = ['shelter', 'evacuate', 'pause'];
app.post('/festivals/:id/posts', requireStaff, loadFestival, wrap(async (req, res) => {
  const checked = expect(req.body, { title: 'string:120', body: 'string:2000', severity: [...SEVERITIES, null], kind: [...KINDS, null], minutes: 'number?' });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { title, body, kind = 'notice' } = checked.value;
  let { severity = 'minor', minutes } = checked.value;
  const hold = HOLDS.includes(kind), now = Date.now();
  if (kind === 'shelter' || kind === 'evacuate') severity = 'severe'; else if (kind === 'pause' && severity === 'minor') severity = 'moderate';
  minutes = hold ? Math.min(720, Math.max(5, Number(minutes) || 60)) : null;
  const expiresAt = hold ? iso(now + minutes * 60_000) : kind === 'allclear' ? iso(now + 15 * 60_000) : null;
  const ended = [];
  if (kind === 'allclear') for (const a of q.activeAlerts(req.festival.id)) if (a.channel === 'official' && HOLDS.includes(a.kind)) { q.updateAlert(req.festival.id, { ...a, expiresAt: iso(now) }); ended.push(a.id); }
  const info = q.insertPost(req.festival.id, title, body, { kind, severity, expiresAt });
  q.count(req.festival.id, 'post');
  const alert = {
    id: `official-${req.festival.id}-${info.lastInsertRowid}`,
    event: title, headline: null, body, instruction: req.festival.shelter && hold ? `Shelter: ${req.festival.shelter}` : null, severity,
    area: req.festival.name, source: `${req.festival.name} staff`,
    issuedAt: iso(now), expiresAt, channel: 'official', kind, minutes, relayCount: 0,
  };
  if (hold || kind === 'allclear') q.insertAlert(req.festival.id, alert);
  const push = await pushAlert(q.tokensFor(req.festival.id), req.festival, alert);
  const web = await pushWeb(req.festival, alert);
  q.setPostReach(info.lastInsertRowid, (push.sent || 0) + (web.sent || 0));
  changed(req.festival.id, 'posts');
  if (hold || ended.length) changed(req.festival.id, 'alerts');
  res.status(201).json({ id: String(info.lastInsertRowid), kind, expiresAt, ended, push, web, reach: (push.sent || 0) + (web.sent || 0) });
}));
/** Staff take a post back: off the list, its hold ended, and the phones that heard it hear that, quietly, under the same tag. */
app.delete('/festivals/:id/posts/:pid', requireStaff, loadFestival, wrap(async (req, res) => {
  const post = q.post(req.params.pid);
  if (!post || post.festivalId !== req.festival.id) return res.status(404).json({ error: 'no such post' });
  if (!q.retractPost(post.id)) return res.status(409).json({ error: 'already retracted' });
  const id = `official-${req.festival.id}-${post.id}`, a = q.alert(req.festival.id, id), now = Date.now();
  if (a && (!a.expiresAt || Date.parse(a.expiresAt) > now)) q.updateAlert(req.festival.id, { ...a, expiresAt: iso(now), retracted: true });
  const retracted = { id, event: post.title, severity: post.severity, channel: 'official', kind: post.kind };
  const words = { title: `Retracted: ${post.title}`, why: 'Festival staff took this back.' };
  const push = await pushEnded(q.tokensFor(req.festival.id), req.festival, retracted, words), web = await pushEndedWeb(req.festival, retracted, words);
  changed(req.festival.id, 'posts'); if (a) changed(req.festival.id, 'alerts');
  res.json({ ok: true, id: String(post.id), ended: Boolean(a), push, web });
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
  changed(f.id, 'reports');   // the staff's queue hears it land
  const push = AUTO_PUBLISH ? await publishAndPush(f, incident) : { queued: true };
  res.status(201).json({ stored: true, id: incident.id, category: hit.category, level: hit.level, published: AUTO_PUBLISH, push });
}));

// Attendee reports always go to the moderation queue.
/** Tests send reports from one address all day. */
export const resetReportLimit = resetLimits;
app.post('/festivals/:id/reports', limit('report', 5, 600_000, 'reports'), loadFestival, (req, res) => {
  const checked = expect(req.body, { summary: 'string:1000', category: 'string?:40', location: 'string?:200', latitude: 'number?', longitude: 'number?' });
  if (checked.error) return res.status(400).json({ error: checked.error });
  const { summary, category, location, latitude, longitude } = checked.value;
  if (summary.length < 8) return res.status(400).json({ error: 'summary required' });
  q.count(req.festival.id, 'report');
  const hit = classify(summary) || { category: category || 'other', level: 'advisory' };
  const incident = {
    id: `rep-${randomUUID()}`, festivalId: req.festival.id, category: hit.category, level: hit.level,
    summary: summarize(summary), transcript: redact(summary), source: 'attendee',
    location: location || null, latitude: Number(latitude) || null, longitude: Number(longitude) || null,
    occurredAt: iso(), published: 0,
  };
  q.insertIncident(incident);
  changed(req.festival.id, 'reports');   // the staff's queue hears it land
  res.status(202).json({ id: incident.id, queued: true });
});

app.get('/festivals/:id/incidents/pending', requireStaff, loadFestival, (req, res) => res.json(q.pendingIncidents(req.festival.id)));
app.post('/festivals/:id/incidents/:iid/publish', requireStaff, loadFestival, wrap(async (req, res) => {
  const i = q.incident(req.params.iid);
  if (!i || i.festivalId !== req.festival.id) return res.status(404).json({ error: 'no such incident' });
  if (req.body?.summary) {
    q.updateIncidentText(i.id, req.body.summary, i.transcript, req.body.category || i.category, req.body.level || i.level);
    Object.assign(i, { summary: req.body.summary, category: req.body.category || i.category, level: req.body.level || i.level });
  }
  res.json({ id: i.id, push: await publishAndPush(req.festival, i) });
}));
app.delete('/festivals/:id/incidents/:iid', requireStaff, loadFestival, (req, res) => { q.deleteIncident(req.params.iid); res.json({ ok: true }); });

// ---- Admin and devices ---------------------------------------------------

app.put('/festivals/:id', requireStaff, (req, res) => {
  const { festival, error } = normalizeFestival(req.body || {}, { base: q.festival(req.params.id), id: req.params.id });
  if (error) return res.status(400).json({ error });
  festival.id = req.params.id; festival.status = 'published';
  q.upsertFestival(festival);
  res.json(festival);
});

app.post('/devices', limit('devices', 30, 600_000, 'registrations'), (req, res) => {
  const { token, festivalId } = req.body || {};
  if (!token || !/^[0-9a-f]{64}$/i.test(token)) return res.status(400).json({ error: 'valid APNs token required' });
  q.upsertDevice(token, festivalId || null);
  res.json({ ok: true });
});
app.delete('/devices/:token', (req, res) => { q.deleteDevice(req.params.token); res.json({ ok: true }); });

// ---- Web push: the web build's warnings, same alerts as APNs -------------

app.get('/push/vapid', (req, res) => (webPushEnabled() ? res.json({ key: vapidPublicKey() }) : res.status(404).json({ error: 'web push not configured' })));
app.post('/push/subscribe', limit('subscribe', 30, 600_000, 'subscriptions'), wrap(async (req, res) => {
  if (!webPushEnabled()) return res.status(404).json({ error: 'web push not configured' });
  // quiet: a phone registering again on open (after a redeploy, say) wants no welcome notification.
  const { subscription, festivalId, point, quiet, digest } = req.body || {};
  if (!validSubscription(subscription)) return res.status(400).json({ error: 'a push subscription with endpoint and keys from a known push service is required' });
  if (festivalId && !q.festival(festivalId)) return res.status(404).json({ error: 'no such festival' });
  q.count(festivalId || 'here', 'follow');
  // A phone with no festival follows a point: wherever it is, rounded to about a kilometer, so a warning for that spot reaches it.
  const lat = Number(point?.latitude), lon = Number(point?.longitude);
  const at = !festivalId && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { latitude: Math.round(lat * 100) / 100, longitude: Math.round(lon * 100) / 100 } : null;
  if (!festivalId && !at) return res.status(400).json({ error: 'festivalId or point required' });
  const clean = { endpoint: subscription.endpoint, keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth } };
  q.upsertWebSubscription(subscription.endpoint, festivalId || null, clean, at, digest !== false);
  const target = festivalId ? q.festival(festivalId) : { id: 'here', name: 'Where you are', ...at };
  res.json({ ok: true, welcome: quiet ? false : await pushWelcome(clean, target) });
}));
app.get('/admin/import', requireAdmin, (req, res) => res.json({ ...(imports.last || { never: true }), running: imports.running }));
/** Who a key is: the admin, or one festival's staff. The web build hides what a key cannot do. */
app.get('/staff/me', (req, res) => {
  if (isAdmin(req)) return res.json({ scope: 'admin' });
  const id = partnerOf(req); if (!id) return res.status(401).json({ error: 'x-admin-key required' });
  res.json({ scope: 'partner', festivalId: id, name: q.festival(id)?.name || id });
});
/** Issue a festival its staff key (replacing any before), shown once; the festival becomes a partner. The admin can read whether one stands, and take it back. */
app.post('/festivals/:id/partner-key', requireAdmin, loadFestival, wrap(async (req, res) => {
  const key = randomBytes(18).toString('base64url');
  q.setSetting(`partner:${req.festival.id}`, hashKey(key));
  if (!req.festival.isPartner) q.upsertFestival({ ...req.festival, isPartner: true });
  // The handoff: a link with the key in it, and that link as a QR, so the safety team scans it once and every phone is staff. Shown once, like the key.
  const handoff = `${SITE}?f=${encodeURIComponent(req.festival.id)}&staff=1&key=${encodeURIComponent(key)}`;
  const qr = await QRCode.toString(handoff, { type: 'svg', errorCorrectionLevel: 'M', margin: 1, color: { dark: '#1A1533ff', light: '#00000000' } });
  res.json({ festivalId: req.festival.id, key, link: `${SITE}?f=${encodeURIComponent(req.festival.id)}&staff=1`, handoff, qr });
}));
app.get('/festivals/:id/partner-key', requireAdmin, loadFestival, (req, res) => res.json({ festivalId: req.festival.id, issued: Boolean(q.setting(`partner:${req.festival.id}`)) }));
app.delete('/festivals/:id/partner-key', requireAdmin, loadFestival, (req, res) => { q.deleteSetting(`partner:${req.festival.id}`); res.json({ festivalId: req.festival.id, issued: false }); });
/** Use, with nobody in it: packs opened, alerts listed and stored, pushes sent, heads-ups, posts, reports, follows, per festival, for the last `days` (7, up to 90). */
app.get('/admin/stats', requireAdmin, (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
  const totals = {}, per = {};
  for (const { festivalId, key, n } of q.stats(days)) { totals[key] = (totals[key] || 0) + n; (per[festivalId] ||= {})[key] = n; }
  const latency = totals['alert.latency_n'] ? Math.round(totals['alert.latency_s'] / totals['alert.latency_n']) : null;
  const festivals = Object.entries(per).filter(([id]) => id !== '*').map(([id, counts]) => ({ id, name: q.festival(id)?.name || id, counts })).sort((a, b) => (b.counts.pack || 0) - (a.counts.pack || 0));
  res.set('Cache-Control', 'no-store').json({ days, totals, alertLatencySeconds: latency, festivals });
});
/** The newest backup as a file, and a way to take one now. */
app.get('/admin/backup', requireAdmin, (req, res) => { const [b] = backups(); if (!b) return res.status(404).json({ error: 'no backup yet' }); res.download(b.path, b.name); });
app.post('/admin/housekeeping', requireAdmin, (req, res) => res.json({ removed: runHousekeeping(), ...housekeepingStatus() }));
app.post('/admin/backup', requireAdmin, wrap(async (req, res) => { const r = await backupNow(); res.json({ ...backupStatus(), bytes: r.bytes }); }));
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
