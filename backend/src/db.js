import Database from 'better-sqlite3';
import { iso } from './util.js';

export const db = new Database(process.env.DB_PATH || 'fieldwatch.db');
db.pragma('journal_mode = WAL');

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
`);

const s = {
  upsertFestival: db.prepare(`INSERT INTO festivals (id, json, start_date, end_date) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, start_date = excluded.start_date, end_date = excluded.end_date`),
  allFestivals: db.prepare(`SELECT json FROM festivals ORDER BY start_date`),
  festival: db.prepare(`SELECT json FROM festivals WHERE id = ?`),

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
};

export const q = {
  upsertFestival: f => s.upsertFestival.run(f.id, JSON.stringify(f), f.startDate, f.endDate),
  allFestivals: () => s.allFestivals.all().map(r => JSON.parse(r.json)),
  festival: id => { const r = s.festival.get(id); return r ? JSON.parse(r.json) : null; },

  alert: id => { const r = s.alert.get(id); return r ? JSON.parse(r.json) : null; },
  insertAlert: (festivalId, a) => s.insertAlert.run(a.id, festivalId, JSON.stringify(a), iso(), a.expiresAt),
  updateAlert: a => s.updateAlert.run(JSON.stringify(a), a.expiresAt, a.id),
  activeAlerts: festivalId => s.activeAlerts.all(festivalId, iso()).map(r => JSON.parse(r.json)),
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
