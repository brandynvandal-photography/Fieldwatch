// A copy of the database once a day, on the volume beside it, the last seven kept. SQLite's online backup API copies a
// consistent snapshot while the server keeps writing. GET /admin/backup hands the newest one down; moving the service
// (or losing the volume) then costs a day at most.
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { db } from './db.js';
import { iso } from './util.js';

const KEEP = Number(process.env.BACKUP_KEEP || 7);
export const backupDir = () => process.env.BACKUP_DIR || join(dirname(resolve(process.env.DB_PATH || 'fieldwatch.db')), 'backups');
const state = { lastAt: null, lastError: null };
const name = at => `fieldwatch-${at.slice(0, 10)}.db`;

/** The backups on disk, newest first. */
export function backups(dir = backupDir()) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => /^fieldwatch-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort().reverse()
    .map(f => ({ name: f, path: join(dir, f), bytes: statSync(join(dir, f)).size }));
}

/** Copy the database now (today's file is replaced) and drop everything past the last KEEP. */
export async function backupNow({ dir = backupDir(), now = Date.now() } = {}) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name(iso(now)));
  try {
    await db.backup(path);
    state.lastAt = iso(now); state.lastError = null;
    for (const b of backups(dir).slice(KEEP)) unlinkSync(b.path);
    return { path, bytes: statSync(path).size };
  } catch (e) { state.lastError = e.message; throw e; }
}

export const backupStatus = (dir = backupDir()) => { const list = backups(dir); return { dir, count: list.length, newest: list[0]?.name || null, lastAt: state.lastAt, lastError: state.lastError }; };

export function startBackups(hours = Number(process.env.BACKUP_HOURS || 24)) {
  const run = () => backupNow().catch(e => console.error('backup failed:', e.message));
  run();
  setInterval(run, hours * 3_600_000);
}
