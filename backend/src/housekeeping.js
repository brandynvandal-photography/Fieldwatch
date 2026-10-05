// What a long-running backend sheds, once a day: incidents and their audio past INCIDENT_KEEP_DAYS, posts past POST_KEEP_DAYS,
// radar frames of festivals that have been over for days, rate-limit bookkeeping with nothing recent. The counts and the last
// error are on /health; an admin can run it now. Alerts and counters are pruned by the poller as they always were.
import { existsSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { q } from './db.js';
import { iso } from './util.js';
import { festivalsInWindow } from './poller.js';
import { RADAR_DIR } from './radar.js';
import { pruneLimits } from './limits.js';

const DAY = 86_400_000;
export const housekeeping = { lastRunAt: null, lastError: null, removed: null };
export function runHousekeeping({ now = Date.now(), audioDir = resolve(process.env.AUDIO_DIR || 'audio'), radarDir = RADAR_DIR,
  incidentDays = Number(process.env.INCIDENT_KEEP_DAYS || 30), postDays = Number(process.env.POST_KEEP_DAYS || 90), radarDays = 2 } = {}) {
  const removed = { incidents: 0, audio: 0, posts: 0, radarDirs: 0, limits: 0 };
  try {
    for (const name of q.incidentAudioOlderThan(iso(now - incidentDays * DAY))) { try { unlinkSync(join(audioDir, name)); removed.audio++; } catch {} }
    removed.incidents = q.purgeIncidents(iso(now - incidentDays * DAY));
    removed.posts = q.purgePosts(iso(now - postDays * DAY));
    const on = new Set(festivalsInWindow(now).map(f => f.id));
    if (existsSync(radarDir)) for (const dir of readdirSync(radarDir)) {
      const p = join(radarDir, dir); let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory() && !on.has(dir) && now - st.mtimeMs > radarDays * DAY) { rmSync(p, { recursive: true, force: true }); removed.radarDirs++; }
    }
    removed.limits = pruneLimits(now);
    housekeeping.lastError = null;
  } catch (e) { housekeeping.lastError = e.message; }
  housekeeping.lastRunAt = iso(now); housekeeping.removed = removed;
  return removed;
}
export const housekeepingStatus = () => ({ ...housekeeping });
export function startHousekeeping(hours = Number(process.env.HOUSEKEEPING_HOURS || 24)) {
  const run = () => { const r = runHousekeeping(); console.log(`housekeeping: ${Object.entries(r).filter(([, n]) => n).map(([k, n]) => `${n} ${k}`).join(', ') || 'nothing to shed'}${housekeeping.lastError ? ` (${housekeeping.lastError})` : ''}`); };
  setTimeout(run, 90_000);
  setInterval(run, hours * 3_600_000);
}
