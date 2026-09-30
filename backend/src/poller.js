import './env.js';
import { q } from './db.js';
import { activeAlerts } from './nws.js';
import { pushAlert } from './push.js';
import { pushWeb } from './webpush.js';
import { isLive } from './festivals.js';
import { iso, daysFromNow } from './util.js';

/** The festivals whose sky is worth watching: grounds open (see festivals.js) through the day after the end. */
export function festivalsInWindow(now = Date.now()) {
  return q.publishedFestivals().filter(f => isLive(f, now));
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
      const w = await pushWeb(f, a);
      console.log(`[${f.id}] new: ${a.event} (${a.severity}) push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
    }
  }
  return brandNew;
}

export function polledRecently(id, ms = 5 * 60_000) {
  return Date.now() - (lastPolled.get(id) || 0) < ms;
}

/** A point some phone follows, dressed as a festival so the same poll and push path serves it. */
export const pointFestival = p => ({ id: 'here', name: 'Where you are', latitude: p.latitude, longitude: p.longitude, county: '', pointId: `pt:${p.latitude.toFixed(2)},${p.longitude.toFixed(2)}` });

/** Like pollFestival, for a point: alerts are stored under the point's id, pushes go to the phones at that point. */
export async function pollPoint(p) {
  const f = pointFestival(p);
  const fresh = await activeAlerts(f.latitude, f.longitude);
  const seenNow = new Set(fresh.map(a => a.id));
  const brandNew = [];
  for (const a of fresh) {
    if (q.alert(a.id)) q.updateAlert(a);
    else { q.insertAlert(f.pointId, a); brandNew.push(a); }
  }
  for (const id of q.activeAlertIds(f.pointId)) {
    if (!seenNow.has(id)) { const a = q.alert(id); if (a) q.updateAlert({ ...a, expiresAt: iso() }); }
  }
  for (const a of brandNew) {
    const w = await pushWeb(f, a);
    console.log(`[${f.pointId}] new: ${a.event} (${a.severity}) web=${JSON.stringify(w)}`);
  }
  return brandNew;
}

export async function pollOnce() {
  for (const f of festivalsInWindow()) {
    try { await pollFestival(f); } catch (e) { console.error(`[${f.id}] poll failed:`, e.message); }
  }
  for (const p of q.webSubscriptionPoints()) {
    try { await pollPoint(p); } catch (e) { console.error(`[pt:${p.latitude},${p.longitude}] poll failed:`, e.message); }
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
