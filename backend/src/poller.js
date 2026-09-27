import './env.js';
import { q } from './db.js';
import { activeAlerts } from './nws.js';
import { pushAlert } from './push.js';
import { iso, daysFromNow } from './util.js';

const BEFORE_DAYS = 3;  // start watching a festival's sky a few days out
const AFTER_DAYS = 1;

export function festivalsInWindow(now = Date.now()) {
  return q.allFestivals().filter(f =>
    now >= Date.parse(f.startDate) - BEFORE_DAYS * 86_400_000 &&
    now <= Date.parse(f.endDate) + AFTER_DAYS * 86_400_000);
}

const lastPolled = new Map();

/** Fetch NWS alerts for one festival, store new ones, push them, and end the ones that vanished. */
export async function pollFestival(f) {
  const fresh = await activeAlerts(f.latitude, f.longitude);
  lastPolled.set(f.id, Date.now());
  const seenNow = new Set(fresh.map(a => a.id));
  const brandNew = [];

  for (const a of fresh) {
    if (q.alert(a.id)) q.updateAlert(a);
    else { q.insertAlert(f.id, a); brandNew.push(a); }
  }
  // Anything we had as active that NWS no longer lists has ended.
  for (const id of q.activeAlertIds(f.id)) {
    if (!seenNow.has(id)) { const a = q.alert(id); if (a) q.updateAlert({ ...a, expiresAt: iso() }); }
  }

  if (brandNew.length) {
    const tokens = q.tokensFor(f.id);
    for (const a of brandNew) {
      const r = await pushAlert(tokens, f, a);
      console.log(`[${f.id}] new: ${a.event} (${a.severity}) push=${JSON.stringify(r)}`);
    }
  }
  return brandNew;
}

export function polledRecently(id, ms = 5 * 60_000) {
  return Date.now() - (lastPolled.get(id) || 0) < ms;
}

export async function pollOnce() {
  for (const f of festivalsInWindow()) {
    try { await pollFestival(f); } catch (e) { console.error(`[${f.id}] poll failed:`, e.message); }
  }
  q.purgeAlerts(daysFromNow(-7));
}

export function startPolling(seconds = Number(process.env.POLL_SECONDS || 120)) {
  pollOnce();
  setInterval(pollOnce, seconds * 1000);
}

if (process.argv.includes('--once')) {
  await pollOnce();
  process.exit(0);
}
