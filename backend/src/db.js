import Database from 'better-sqlite3';
import { iso } from './util.js';

export const db = new Database(process.env.DB_PATH || 'fieldwatch.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS festivals (
    id TEXT PRIMARY KEY,
    json TEXT NOT NULL,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY,
    festival_id TEXT NOT NULL,
    json TEXT NOT NULL,
    first_seen TEXT NOT NULL,
    expires_at TEXT
  );
  CREATE INDEX IF NOT EXISTS alerts_festival ON alerts(festival_id);
  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    posted_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS incidents (
    id TEXT PRIMARY KEY,
    festival_id TEXT NOT NULL,
    category TEXT NOT NULL,
    level TEXT NOT NULL,
    summary TEXT NOT NULL,
    transcript TEXT,
    source TEXT NOT NULL,
    talkgroup TEXT,
    location TEXT,
    latitude REAL,
    longitude REAL,
    audio_file TEXT,
    occurred_at TEXT NOT NULL,
    published INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS incidents_festival ON incidents(festival_id, published, occurred_at);
  CREATE TABLE IF NOT EXISTS devices (
    token TEXT PRIMARY KEY,
    festival_id TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS web_subscriptions (
    endpoint TEXT PRIMARY KEY,
    festival_id TEXT,
    json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS ground_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    festival_id TEXT NOT NULL,
    state TEXT NOT NULL,
    effective REAL,
    tier TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ground_reports_festival ON ground_reports(festival_id, created_at);
  CREATE TABLE IF NOT EXISTS stats (
    day TEXT NOT NULL,
    festival_id TEXT NOT NULL,
    key TEXT NOT NULL,
    n INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, festival_id, key)
  );
`);
// Added later: a festival someone suggested waits as 'pending' until an admin approves it.
if (!db.prepare(`PRAGMA table_info(festivals)`).all().some(c => c.name === 'status')) {
  db.exec(`ALTER TABLE festivals ADD COLUMN status TEXT NOT NULL DEFAULT 'published'`);
}
// Added later: a browser may follow a point on the map (wherever the phone is) instead of a festival.
if (!db.prepare(`PRAGMA table_info(web_subscriptions)`).all().some(c => c.name === 'latitude')) {
  db.exec(`ALTER TABLE web_subscriptions ADD COLUMN latitude REAL; ALTER TABLE web_subscriptions ADD COLUMN longitude REAL`);
}

const s = {
  upsertFestival: db.prepare(`INSERT INTO festivals (id, json, start_date, end_date, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, start_date = excluded.start_date, end_date = excluded.end_date, status = excluded.status`),
  allFestivals: db.prepare(`SELECT json FROM festivals ORDER BY start_date`),
  publishedFestivals: db.prepare(`SELECT json FROM festivals WHERE status = 'published' ORDER BY start_date`),
  pendingFestivals: db.prepare(`SELECT json FROM festivals WHERE status = 'pending' ORDER BY start_date`),
  festival: db.prepare(`SELECT json FROM festivals WHERE id = ?`),
  deleteFestival: db.prepare(`DELETE FROM festivals WHERE id = ?`),

  alert: db.prepare(`SELECT json FROM alerts WHERE id = ?`),
  insertAlert: db.prepare(`INSERT INTO alerts (id, festival_id, json, first_seen, expires_at) VALUES (?, ?, ?, ?, ?)`),
  updateAlert: db.prepare(`UPDATE alerts SET json = ?, expires_at = ? WHERE id = ?`),
  activeAlerts: db.prepare(`SELECT json FROM alerts WHERE festival_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY first_seen DESC`),
  activeAlertIds: db.prepare(`SELECT id FROM alerts WHERE festival_id = ? AND (expires_at IS NULL OR expires_at > ?)`),
  purgeAlerts: db.prepare(`DELETE FROM alerts WHERE expires_at IS NOT NULL AND expires_at < ?`),

  insertPost: db.prepare(`INSERT INTO posts (festival_id, title, body, posted_at) VALUES (?, ?, ?, ?)`),
  posts: db.prepare(`SELECT id, title, body, posted_at FROM posts WHERE festival_id = ? ORDER BY posted_at DESC LIMIT 50`),

  insertIncident: db.prepare(`INSERT INTO incidents (id, festival_id, category, level, summary, transcript, source, talkgroup, location, latitude, longitude, audio_file, occurred_at, published, created_at)
    VALUES (@id, @festivalId, @category, @level, @summary, @transcript, @source, @talkgroup, @location, @latitude, @longitude, @audioFile, @occurredAt, @published, @createdAt)`),
  incident: db.prepare(`SELECT * FROM incidents WHERE id = ?`),
  publishedIncidents: db.prepare(`SELECT * FROM incidents WHERE festival_id = ? AND published = 1 AND occurred_at > ? ORDER BY occurred_at DESC LIMIT 100`),
  pendingIncidents: db.prepare(`SELECT * FROM incidents WHERE festival_id = ? AND published = 0 ORDER BY occurred_at DESC LIMIT 100`),
  publishIncident: db.prepare(`UPDATE incidents SET published = 1 WHERE id = ?`),
  updateIncidentText: db.prepare(`UPDATE incidents SET summary = ?, transcript = ?, category = ?, level = ? WHERE id = ?`),
  deleteIncident: db.prepare(`DELETE FROM incidents WHERE id = ?`),

  upsertDevice: db.prepare(`INSERT INTO devices (token, festival_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(token) DO UPDATE SET festival_id = excluded.festival_id, updated_at = excluded.updated_at`),
  deleteDevice: db.prepare(`DELETE FROM devices WHERE token = ?`),
  tokensFor: db.prepare(`SELECT token FROM devices WHERE festival_id = ?`),

  upsertWebSubscription: db.prepare(`INSERT INTO web_subscriptions (endpoint, festival_id, json, updated_at, latitude, longitude) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET festival_id = excluded.festival_id, json = excluded.json, updated_at = excluded.updated_at, latitude = excluded.latitude, longitude = excluded.longitude`),
  deleteWebSubscription: db.prepare(`DELETE FROM web_subscriptions WHERE endpoint = ?`),
  webSubscriptionsFor: db.prepare(`SELECT endpoint, json FROM web_subscriptions WHERE festival_id = ?`),
  webSubscriptionsAt: db.prepare(`SELECT endpoint, json FROM web_subscriptions WHERE festival_id IS NULL AND round(latitude, 2) = ? AND round(longitude, 2) = ?`),
  webSubscriptionPoints: db.prepare(`SELECT DISTINCT round(latitude, 2) AS latitude, round(longitude, 2) AS longitude FROM web_subscriptions WHERE festival_id IS NULL AND latitude IS NOT NULL AND longitude IS NOT NULL`),

  setting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`),
  deleteSetting: db.prepare(`DELETE FROM settings WHERE key = ?`),
  partnerKeys: db.prepare(`SELECT key, value FROM settings WHERE key LIKE 'partner:%'`),
  insertGroundReport: db.prepare(`INSERT INTO ground_reports (festival_id, state, effective, tier, created_at) VALUES (?, ?, ?, ?, ?)`),
  groundReports: db.prepare(`SELECT state, effective, tier, created_at FROM ground_reports WHERE festival_id = ? AND created_at >= ? ORDER BY created_at DESC`),
  count: db.prepare(`INSERT INTO stats (day, festival_id, key, n) VALUES (?, ?, ?, ?) ON CONFLICT(day, festival_id, key) DO UPDATE SET n = n + excluded.n`),
  stats: db.prepare(`SELECT festival_id, key, SUM(n) AS n FROM stats WHERE day >= ? GROUP BY festival_id, key`),
  purgeStats: db.prepare(`DELETE FROM stats WHERE day < ?`),
};

export const q = {
  upsertFestival: f => { const status = f.status || 'published'; return s.upsertFestival.run(f.id, JSON.stringify({ ...f, status }), f.startDate, f.endDate, status); },
  allFestivals: () => s.allFestivals.all().map(r => JSON.parse(r.json)),
  publishedFestivals: () => s.publishedFestivals.all().map(r => JSON.parse(r.json)),
  pendingFestivals: () => s.pendingFestivals.all().map(r => JSON.parse(r.json)),
  festival: id => { const r = s.festival.get(id); return r ? JSON.parse(r.json) : null; },
  deleteFestival: id => s.deleteFestival.run(id),

  alert: id => { const r = s.alert.get(id); return r ? JSON.parse(r.json) : null; },
  insertAlert: (festivalId, a) => s.insertAlert.run(a.id, festivalId, JSON.stringify(a), iso(), a.expiresAt),
  updateAlert: a => s.updateAlert.run(JSON.stringify(a), a.expiresAt, a.id),
  activeAlerts: (festivalId, at) => s.activeAlerts.all(festivalId, iso(at)).map(r => JSON.parse(r.json)),   // `at`: the clock to judge "active" by (tests run on a simulated one)
  activeAlertIds: festivalId => s.activeAlertIds.all(festivalId, iso()).map(r => r.id),
  purgeAlerts: olderThan => s.purgeAlerts.run(iso(olderThan)),

  insertPost: (festivalId, title, body) => s.insertPost.run(festivalId, title, body, iso()),
  posts: festivalId => s.posts.all(festivalId).map(r => ({ id: String(r.id), title: r.title, body: r.body, postedAt: r.posted_at })),

  insertIncident: i => s.insertIncident.run({ transcript: null, talkgroup: null, location: null, latitude: null, longitude: null, audioFile: null, published: 0, createdAt: iso(), ...i }),
  incident: id => rowToIncident(s.incident.get(id)),
  publishedIncidents: (festivalId, since) => s.publishedIncidents.all(festivalId, iso(since)).map(rowToIncident),
  pendingIncidents: festivalId => s.pendingIncidents.all(festivalId).map(rowToIncident),
  publishIncident: id => s.publishIncident.run(id),
  updateIncidentText: (id, summary, transcript, category, level) => s.updateIncidentText.run(summary, transcript, category, level, id),
  deleteIncident: id => s.deleteIncident.run(id),

  upsertDevice: (token, festivalId) => s.upsertDevice.run(token, festivalId || null, iso()),
  deleteDevice: token => s.deleteDevice.run(token),
  tokensFor: festivalId => s.tokensFor.all(festivalId).map(r => r.token),

  upsertWebSubscription: (endpoint, festivalId, subscription, point) => s.upsertWebSubscription.run(endpoint, festivalId || null, JSON.stringify(subscription), iso(), point?.latitude ?? null, point?.longitude ?? null),
  deleteWebSubscription: endpoint => s.deleteWebSubscription.run(endpoint),
  webSubscriptionsFor: festivalId => s.webSubscriptionsFor.all(festivalId).map(r => ({ endpoint: r.endpoint, subscription: JSON.parse(r.json) })),
  webSubscriptionsAt: (latitude, longitude) => s.webSubscriptionsAt.all(Math.round(latitude * 100) / 100, Math.round(longitude * 100) / 100).map(r => ({ endpoint: r.endpoint, subscription: JSON.parse(r.json) })),
  webSubscriptionPoints: () => s.webSubscriptionPoints.all(),

  setting: key => s.setting.get(key)?.value ?? null,
  setSetting: (key, value) => s.setSetting.run(key, value),
  deleteSetting: key => s.deleteSetting.run(key),
  // A festival's own staff key, kept as a hash: the festival id and the hash of the key its staff hold.
  partnerKeys: () => s.partnerKeys.all().map(r => ({ festivalId: r.key.slice('partner:'.length), hash: r.value })),
  insertGroundReport: (festivalId, state, effective, tier) => s.insertGroundReport.run(festivalId, state, effective, tier, iso()),
  groundReports: (festivalId, since) => s.groundReports.all(festivalId, iso(since)).map(r => ({ state: r.state, effective: r.effective, tier: r.tier, at: r.created_at })),
  // Counters with no one in them: how much each festival's pack, alerts and pushes are used, by day. Nothing names a phone.
  count: (festivalId, key, n = 1) => { if (n) s.count.run(iso().slice(0, 10), festivalId || '*', key, n); },
  stats: days => s.stats.all(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)).map(r => ({ festivalId: r.festival_id, key: r.key, n: r.n })),
  purgeStats: days => s.purgeStats.run(new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)),
};

function rowToIncident(r) {
  if (!r) return null;
  return {
    id: r.id, festivalId: r.festival_id, category: r.category, level: r.level, summary: r.summary,
    transcript: r.transcript, source: r.source, talkgroup: r.talkgroup, location: r.location,
    latitude: r.latitude, longitude: r.longitude,
    audioURL: r.audio_file ? `/audio/${r.audio_file}` : null,
    occurredAt: r.occurred_at, published: r.published === 1,
  };
}
