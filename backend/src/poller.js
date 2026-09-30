import './env.js';
import { q } from './db.js';
import { activeAlerts, alertsFor, gridpoint, hourly, point } from './nws.js';
import { changed } from './live.js';
import { headsUpAlert, incoming, spreadGrid } from './incoming.js';
import { ensureGround, groundFor } from './ground.js';
import { nowcastFor } from './nowcast.js';
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
  const fresh = await alertsFor(f.latitude, f.longitude);
  lastPolled.set(f.id, Date.now());
  const seenNow = new Set(fresh.map(a => a.id));
  const brandNew = [];

  for (const a of fresh) {
    if (q.alert(a.id)) q.updateAlert(a);
    else { q.insertAlert(f.id, a); brandNew.push(a); }
  }
  // Anything we had as active that NWS no longer lists has ended. A staff post or a forecast heads-up is not NWS's to end.
  let ended = 0;
  for (const id of q.activeAlertIds(f.id)) {
    if (!seenNow.has(id)) { const a = q.alert(id); if (a && (a.channel || 'weather') === 'weather') { q.updateAlert({ ...a, expiresAt: iso() }); ended++; } }
  }
  if (brandNew.length || ended) changed(f.id, 'alerts');

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

// A heads-up a few hours before the forecast turns stormy, windy, wet or dangerously hot: pushed once per window, listed
// with the alerts, and never for what a watch or warning already announced. The forecast is read every twenty minutes.
const HEADS_UP_HOURS = Number(process.env.HEADS_UP_HOURS || 3), HEADS_UP_EVERY_MS = 20 * 60_000;
const headsUpAt = new Map();
export async function headsUp(f, { now = Date.now(), every = HEADS_UP_EVERY_MS } = {}) {
  if ((headsUpAt.get(f.id) || 0) > now - every) return null;
  headsUpAt.set(f.id, now);
  const [periods, g, p] = await Promise.all([hourly(f.latitude, f.longitude), gridpoint(f.latitude, f.longitude), point(f.latitude, f.longitude)]);
  const ground = await groundFor(f, { now });
  let nowcast = null; try { nowcast = nowcastFor(f, { now }); } catch (e) { console.error(`[${f.id}] nowcast failed:`, e.message); }
  const inc = incoming({ hourly: periods, grid: spreadGrid(g, periods), alerts: q.activeAlerts(f.id), ground, nowcast, now });
  if (!inc || inc.source === 'alert' || inc.minutes > HEADS_UP_HOURS * 60 || inc.minutes < 10) return null;
  const key = `headsup:${f.id}`, prev = JSON.parse(q.setting(key) || 'null');
  if (prev && prev.hazard === inc.hazard && Math.abs(Date.parse(prev.startsAt) - Date.parse(inc.startsAt)) < 90 * 60_000 && now - Date.parse(prev.at) < 6 * 3_600_000) return null;
  const a = headsUpAlert(f, inc, p.timeZone, now, ground);
  q.setSetting(key, JSON.stringify({ hazard: inc.hazard, startsAt: inc.startsAt, at: new Date(now).toISOString() }));
  if (q.alert(a.id)) q.updateAlert(a); else q.insertAlert(f.id, a);
  changed(f.id, 'headsup');
  const r = await pushAlert(q.tokensFor(f.id), f, a);
  const w = await pushWeb(f, a);
  console.log(`[${f.id}] heads-up: ${a.event} in ${inc.minutes} min push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
  return a;
}

export async function pollOnce() {
  const on = festivalsInWindow();
  try { await ensureGround(on, { save: f => q.upsertFestival(f) }); } catch (e) { console.error('ground lookup failed:', e.message); }
  for (const f of on) {
    try { await pollFestival(f); } catch (e) { console.error(`[${f.id}] poll failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
    try { await headsUp(f); } catch (e) { console.error(`[${f.id}] heads-up failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
  }
  for (const p of q.webSubscriptionPoints()) {
    try { await pollPoint(p); } catch (e) { console.error(`[pt:${p.latitude},${p.longitude}] poll failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
  }
  q.purgeAlerts(daysFromNow(-7));
}

export function startPolling(seconds = Number(process.env.POLL_SECONDS || 30)) {
  pollOnce();
  setInterval(pollOnce, seconds * 1000);
}

if (process.argv.includes('--once')) {
  await pollOnce();
  process.exit(0);
}
