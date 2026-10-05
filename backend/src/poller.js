import './env.js';
import { q } from './db.js';
import { activeAlerts, alertsFor, gridpoint, hourly, nwsStats, point } from './nws.js';
import { changed } from './live.js';
import { headsUpAlert, incoming, spreadGrid } from './incoming.js';
import { ensureGround, groundFor } from './ground.js';
import { nowcastFor } from './nowcast.js';
import { pushAlert, pushEnded } from './push.js';
import { pushEnded as pushEndedWeb, pushWeb } from './webpush.js';
import { isLive } from './festivals.js';
import { iso, daysFromNow } from './util.js';

/** The festivals whose sky is worth watching: grounds open (see festivals.js) through the day after the end. */
export function festivalsInWindow(now = Date.now()) {
  return q.publishedFestivals().filter(f => isLive(f, now));
}

const lastPolled = new Map();
// Liveness for /health: when a poll last ran, when one last succeeded, and the last error, so a stale feed shows as a problem.
const polling = { lastRunAt: null, lastOkAt: null, lastError: null, errorAt: null, festivals: 0, overruns: 0 };
export const pollingStatus = () => ({ lastRunAt: polling.lastRunAt ? iso(polling.lastRunAt) : null, lastOkAt: polling.lastOkAt ? iso(polling.lastOkAt) : null, lastError: polling.lastError, errorAt: polling.errorAt, festivals: polling.festivals , overruns: polling.overruns, nws: { calls: nwsStats.calls, retries: nwsStats.retries } })

// An end must stand for two polls: the weather service answers an empty list for seconds at a time, and one empty answer
// must not end every warning on the sky card and buzz them as new when the next poll brings them back.
const missing = new Map();
const goneTwice = (place, id, seen) => { const k = `${place}|${id}`; if (seen) { missing.delete(k); return false; } const n = (missing.get(k) || 0) + 1; missing.set(k, n); if (n >= 2) { missing.delete(k); return true; } return false; };

/** Fetch NWS alerts for one festival, store new ones, push them, and end the ones that vanished. */
export async function pollFestival(f) {
  const fresh = await alertsFor(f.latitude, f.longitude);
  lastPolled.set(f.id, Date.now());
  const seenNow = new Set(fresh.map(a => a.id)), replaced = new Set(fresh.flatMap(a => a.replaces || []));   // a message an update supersedes ends at once
  const brandNew = [];

  for (const a of fresh) {
    if (q.alert(f.id, a.id)) q.updateAlert(f.id, a);
    else { q.insertAlert(f.id, a); if (!(a.replaces || []).some(id => q.alert(f.id, id))) brandNew.push(a); }   // an update of a message we have is the same warning: stored, not pushed again
  }
  // Anything we had as active that NWS no longer lists, twice running, has ended. A staff post or a forecast heads-up is not NWS's to end.
  let ended = 0; const over = [];
  for (const id of q.activeAlertIds(f.id)) {
    if (replaced.has(id) || goneTwice(f.id, id, seenNow.has(id))) { const a = q.alert(f.id, id); if (a && (a.channel || 'weather') === 'weather') { q.updateAlert(f.id, { ...a, expiresAt: iso() }); ended++; if (!replaced.has(id)) over.push(a); } }
  }
  if (brandNew.length || ended) changed(f.id, 'alerts');
  // A warning that went out loud is said to be over, once, when nothing of its kind still stands; a message an update replaced is the same warning, not an end.
  for (const a of over) {
    if (!(a.severity === 'extreme' || a.severity === 'severe') || q.activeAlerts(f.id).some(x => x.event === a.event && (x.channel || 'weather') === 'weather')) continue;
    const r = await pushEnded(q.tokensFor(f.id), f, a), w = await pushEndedWeb(f, a);
    console.log(`[${f.id}] ended: ${a.event} push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
  }

  if (brandNew.length) {
    const tokens = q.tokensFor(f.id);
    for (const a of brandNew) {
      q.count(f.id, 'alert.new');
      const latency = Math.round((Date.now() - Date.parse(a.issuedAt || '')) / 1000);
      if (Number.isFinite(latency) && latency >= 0) { q.count(f.id, 'alert.latency_s', latency); q.count(f.id, 'alert.latency_n'); }
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
  const seenNow = new Set(fresh.map(a => a.id)), replaced = new Set(fresh.flatMap(a => a.replaces || []));
  const brandNew = [];
  for (const a of fresh) {
    if (q.alert(f.pointId, a.id)) q.updateAlert(f.pointId, a);
    else { q.insertAlert(f.pointId, a); if (!(a.replaces || []).some(id => q.alert(f.pointId, id))) brandNew.push(a); }
  }
  const over = [];
  for (const id of q.activeAlertIds(f.pointId)) {
    if (replaced.has(id) || goneTwice(f.pointId, id, seenNow.has(id))) { const a = q.alert(f.pointId, id); if (a) { q.updateAlert(f.pointId, { ...a, expiresAt: iso() }); if (!replaced.has(id)) over.push(a); } }
  }
  for (const a of over) {
    if (!(a.severity === 'extreme' || a.severity === 'severe') || q.activeAlerts(f.pointId).some(x => x.event === a.event)) continue;
    const w = await pushEndedWeb(f, a);
    console.log(`[${f.pointId}] ended: ${a.event} web=${JSON.stringify(w)}`);
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
  if (q.alert(f.id, a.id)) q.updateAlert(f.id, a); else q.insertAlert(f.id, a);
  q.count(f.id, 'headsup');
  changed(f.id, 'headsup');
  const r = await pushAlert(q.tokensFor(f.id), f, a);
  const w = await pushWeb(f, a);
  console.log(`[${f.id}] heads-up: ${a.event} in ${inc.minutes} min push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
  return a;
}

/** A few at a time: one slow answer from the weather service must not push the whole pass past POLL_SECONDS. */
async function pool(items, n, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(n, queue.length) }, async () => { while (queue.length) await fn(queue.shift()); }));
}
const POOL = Number(process.env.POLL_CONCURRENCY || 3);
let inFlight = null;
/** One pass over everything that is on. A pass that is still running when the next is due is not overlapped: the next tick joins it and the overrun is counted. */
export function pollOnce() {
  if (inFlight) { polling.overruns++; return inFlight; }
  inFlight = pollPass().finally(() => { inFlight = null; });
  return inFlight;
}
async function pollPass() {
  const on = festivalsInWindow();
  polling.lastRunAt = Date.now(); polling.festivals = on.length;
  if (!on.length) polling.lastOkAt = polling.lastRunAt;   // nothing to poll is not a failure
  try { await ensureGround(on, { save: f => q.upsertFestival(f) }); } catch (e) { console.error('ground lookup failed:', e.message); }
  await pool(on, POOL, async f => {
    try { await pollFestival(f); polling.lastOkAt = Date.now(); }
    catch (e) { polling.lastError = `${f.id}: ${e.message}`; polling.errorAt = iso(); console.error(`[${f.id}] poll failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
    try { await headsUp(f); } catch (e) { console.error(`[${f.id}] heads-up failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
  });
  await pool(q.webSubscriptionPoints(), POOL, async p => {
    try { await pollPoint(p); } catch (e) { console.error(`[pt:${p.latitude},${p.longitude}] poll failed:`, e.message, e.cause?.code || e.cause?.message || ''); }
  });
  q.purgeAlerts(daysFromNow(-7));
  q.purgeStats(90);
}

export function startPolling(seconds = Number(process.env.POLL_SECONDS || 30)) {
  pollOnce();
  setInterval(pollOnce, seconds * 1000);
}

if (process.argv.includes('--once')) {
  await pollOnce();
  process.exit(0);
}
