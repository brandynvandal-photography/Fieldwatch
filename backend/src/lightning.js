// Lightning near each festival that is on, from the GOES-R Geostationary Lightning Mapper. NOAA publishes every
// 20-second flash file (GLM-L2-LCFA) on public S3 buckets a minute or two after the fact; each is NetCDF-4, which is
// HDF5, which h5wasm reads in Node with no native build. Every minute: list the current hour on each satellite, fetch
// the files not seen yet, keep the flashes within reach of a live festival for thirty minutes, and grade each festival
// on the festival safety protocol (the wording in PROTOCOL is the staff's own):
//   red      a flash within 8 miles in the last 30 minutes: rapid evacuation, full work stoppage; all clear 30 minutes after the last one
//   orange   nearest flash in the last 15 minutes 8 to 12 miles out: evacuation procedures, staff hold posts to assist attendees
//   yellow   12 to 20 miles: pay attention, prepare for orange and a work stoppage
//   green    nothing within 20 miles in the last 15 minutes
//   none     no data in the last 10 minutes (off, nothing is on, or the buckets are unreachable). Files 5 to 10 minutes late
//            hold the last code, marked held with the age of the data, rather than flipping to no data and back; a red at
//            its all-clear with late files holds up to 10 more minutes while the all-clear waits for data
//   indoor   the event is indoors (ground.js effectiveGround): the building is the shelter, so no code and no alert
// A change to orange or red is stored and pushed like a warning (channel 'lightning'); red ends with the all-clear,
// orange fifteen minutes after the last flash within 12 miles or when the code changes. The web build shows the code
// on the festival page and explains it. The festival's own lightning vendor is the authority; the mapper sees cloud
// tops at about 8 km resolution and misses some flashes under a thick anvil.
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { q } from './db.js';
import { clock } from './incoming.js';
import { point } from './nws.js';
import { festivalsInWindow } from './poller.js';
import { pushAlert, pushEnded } from './push.js';
import { pushEnded as pushEndedWeb, pushWeb } from './webpush.js';
import { iso } from './util.js';
import { changed } from './live.js';
import { effectiveGround } from './ground.js';

const MIN = 60_000, MI = 1609.344, J2000 = Date.UTC(2000, 0, 1, 12);   // GOES-R clocks count seconds from noon on 1 January 2000
export const RINGS = { red: 8, orange: 12, yellow: 20 };
export const RECENT_MS = 15 * MIN, ALL_CLEAR_MS = 30 * MIN, STALE_MS = 5 * MIN, LOST_MS = 10 * MIN, HOLD_MS = 10 * MIN, REACH_MI = 40;
export const lightningOn = () => !/^(false|0|no|off)$/i.test(process.env.LIGHTNING || 'true');
// GOES-East is GOES-19 since April 2025 (GOES-16 is in storage orbit and its bucket stops), GOES-West is GOES-18. Together they see all of the US.
const buckets = () => (process.env.GLM_BUCKETS || 'noaa-goes19,noaa-goes18').split(',').map(s => s.trim()).filter(Boolean);

export function milesBetween(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(a)) / MI;
}
/** OR_GLM-L2-LCFA_G19_s20262731405000_e..._c....nc: the start time is year, day of year, hour, minute, second, tenth. */
export const keyTime = key => { const m = /_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d/.exec(key); return m ? Date.UTC(+m[1], 0, 1) + (+m[2] - 1) * 86_400_000 + (+m[3] * 3600 + +m[4] * 60 + +m[5]) * 1000 : NaN; };
/** The bucket prefix for the hour: GLM-L2-LCFA/YYYY/DDD/HH/. */
export function hourPrefix(t) {
  const d = new Date(t), doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  return `GLM-L2-LCFA/${d.getUTCFullYear()}/${String(doy).padStart(3, '0')}/${String(d.getUTCHours()).padStart(2, '0')}/`;
}
export const parseListing = xml => Array.from(String(xml).matchAll(/<Key>([^<]+)<\/Key>/g), m => m[1]);

// h5wasm is loaded on first use: the wasm takes a moment, and a process that never grades lightning should not pay for it.
let h5;
async function h5wasm() { if (!h5) { const m = await import('h5wasm/node'); await m.default.ready; h5 = m.default; } return h5; }
const num = v => (Array.isArray(v) || ArrayBuffer.isView(v)) ? Number(v[0]) : Number(v);
/** A dataset's values with its NetCDF packing undone (scale_factor and add_offset, when it has them). */
function unpack(ds) {
  if (!ds || (ds.shape && ds.shape[0] === 0)) return [];
  const raw = ds.value, arr = ArrayBuffer.isView(raw) ? Array.from(raw) : Array.isArray(raw) ? raw : [raw];
  const sf = ds.attrs?.scale_factor?.value, ao = ds.attrs?.add_offset?.value, s = sf == null ? 1 : num(sf), o = ao == null ? 0 : num(ao);
  return s === 1 && o === 0 ? arr : arr.map(x => x * s + o);
}
/** The flashes in one LCFA file as { t, lat, lon }: product_time (seconds since J2000) plus each flash's packed offset. */
export async function readFlashes(bytes) {
  const H5 = await h5wasm();
  const dir = join(tmpdir(), 'fieldwatch-glm'); mkdirSync(dir, { recursive: true });
  const path = join(dir, `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.nc`);
  writeFileSync(path, bytes);
  try {
    const f = new H5.File(path, 'r');
    try {
      const pt = num(unpack(f.get('product_time'))), lat = unpack(f.get('flash_lat')), lon = unpack(f.get('flash_lon')), off = unpack(f.get('flash_time_offset_of_first_event'));
      const out = [];
      for (let i = 0; i < lat.length; i++) if (Number.isFinite(lat[i]) && Number.isFinite(lon[i])) out.push({ t: Math.round(J2000 + (pt + (off[i] ?? 0)) * 1000), lat: lat[i], lon: lon[i] });
      return out;
    } finally { f.close(); }
  } finally { try { unlinkSync(path); } catch {} }
}

/**
 * One festival's grade from the flashes in the buffer. `lastFileAt` says whether the data is fresh enough to call anything green.
 * `carry` is a red or orange alert already standing (issued before a restart, while the files are read again, newest first): the
 * flash it was issued on keeps its say until the alert's own end, so the grade never falls below an alert that is still out.
 */
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
/**
 * Where the lightning is going: the flashes of the last ten minutes against the ten before, as two centers, within forty miles.
 * Heading is where they are moving to, speed how fast, closing whether the center is nearer than it was, and the minutes until
 * it would be here at that rate. Null until there are three flashes in each half: a single cell is not a motion.
 */
export function motionOf(f, flashes, now = Date.now()) {
  const near = flashes.filter(x => now - x.t <= 2 * RECENT_MS / 1.5 && milesBetween(f.latitude, f.longitude, x.lat, x.lon) <= REACH_MI);   // the last twenty minutes
  const fresh = near.filter(x => now - x.t <= 10 * MIN), older = near.filter(x => now - x.t > 10 * MIN);
  if (fresh.length < 3 || older.length < 3) return null;
  const kx = 69.172 * Math.cos(f.latitude * Math.PI / 180), ky = 69.172;   // miles per degree here
  const center = g => ({ x: g.reduce((s, x) => s + (x.lon - f.longitude) * kx, 0) / g.length, y: g.reduce((s, x) => s + (x.lat - f.latitude) * ky, 0) / g.length, t: g.reduce((s, x) => s + x.t, 0) / g.length });
  const a = center(older), b = center(fresh), dx = b.x - a.x, dy = b.y - a.y, hours = Math.max(MIN, b.t - a.t) / 3_600_000;
  const moved = Math.hypot(dx, dy), speedMph = Math.round(moved / hours), distA = Math.hypot(a.x, a.y), distB = Math.hypot(b.x, b.y);
  const heading = moved < 0.5 ? null : COMPASS[Math.round((((Math.atan2(dx, dy) * 180 / Math.PI) % 360) + 360) % 360 / 45) % 8];
  const closing = distB < distA - 0.5, rate = (distA - distB) / hours;
  const arrivalMinutes = closing && rate > 3 ? Math.min(180, Math.max(1, Math.round(distB / rate * 60))) : null;
  return { heading, speedMph, closing, awayMph: closing ? null : Math.round(-rate), arrivalMinutes, distanceMi: Math.round(distB * 10) / 10, flashes: near.length };
}
export function assess(f, flashes, now = Date.now(), lastFileAt = null, carry = null, prev = null) {
  const near = flashes.map(x => ({ ...x, mi: milesBetween(f.latitude, f.longitude, x.lat, x.lon) })).filter(x => x.mi <= RINGS.yellow);
  const recent = near.filter(x => now - x.t <= RECENT_MS);
  let nearest = recent.reduce((b, x) => (!b || x.mi < b.mi ? x : b), null);
  let lastNear = near.filter(x => x.mi <= RINGS.red).reduce((b, x) => (!b || x.t > b.t ? x : b), null);
  let lastMid = recent.filter(x => x.mi <= RINGS.orange).reduce((b, x) => (!b || x.t > b.t ? x : b), null);
  if (carry && Number.isFinite(carry.t) && Number.isFinite(carry.mi)) {
    const c = { t: carry.t, mi: carry.mi };
    if (carry.code === 'red' && c.mi <= RINGS.red && (!lastNear || c.t > lastNear.t)) lastNear = c;
    if (carry.code === 'orange' && now - c.t <= RECENT_MS && c.mi <= RINGS.orange) { if (!nearest || c.mi < nearest.mi) nearest = c; if (!lastMid || c.t > lastMid.t) lastMid = c; }
  }
  const age = lastFileAt == null ? Infinity : now - lastFileAt, stale = age > STALE_MS, lost = age > LOST_MS;
  // Thirty minutes after the last close flash is the all-clear, when the mapper is current. With its files late the red holds
  // up to HOLD_MS more while the all-clear waits for data: an all-clear nobody can confirm is not one.
  const sinceNear = lastNear ? now - lastNear.t : Infinity;
  const red = Boolean(lastNear) && (sinceNear < ALL_CLEAR_MS || (stale && sinceNear < ALL_CLEAR_MS + HOLD_MS)), held = red && sinceNear >= ALL_CLEAR_MS;
  // Files late but not lost: the last code stands, marked held with the age of the data, rather than no data and back every time the bucket runs minutes behind.
  const hold = !red && stale && !lost && prev && ['green', 'yellow', 'orange'].includes(prev.code) ? prev : null;
  const code = red ? 'red' : hold ? hold.code : stale ? 'none' : !nearest ? 'green' : nearest.mi <= RINGS.orange ? 'orange' : 'yellow';
  const within = r => recent.filter(x => x.mi <= r).length, mi = x => Math.round(x.mi * 10) / 10;
  return { code, nearestMi: nearest ? mi(nearest) : null, nearestAt: nearest ? iso(nearest.t) : null, within: { [RINGS.red]: within(RINGS.red), [RINGS.orange]: within(RINGS.orange), [RINGS.yellow]: within(RINGS.yellow) },
    lastNearMi: lastNear ? mi(lastNear) : null, lastNearAt: lastNear ? iso(lastNear.t) : null, allClearAt: red ? iso(lastNear.t + ALL_CLEAR_MS + (held ? HOLD_MS : 0)) : null, allClearHeld: held,
    orangeUntil: code === 'orange' && lastMid ? iso(lastMid.t + RECENT_MS) : hold && hold.code === 'orange' ? hold.orangeUntil || null : null,
    held: Boolean(hold), stale, dataAgeSeconds: Number.isFinite(age) ? Math.round(age / 1000) : null, motion: motionOf(f, flashes, now), at: iso(now), dataAt: lastFileAt ? iso(lastFileAt) : null, source: 'GOES GLM' };
}

// A spot someone is standing on, festival or not: asked about, it is kept in reach of the reader for a day, and graded on demand.
// The first fifteen minutes after it is first asked about are a warm-up: the buffer has nothing for it yet, and a green nobody
// could see would be a lie. No alert and no push for a spot; the grade is for the phone that asked.
const interest = new Map();
const pointKey = (lat, lon) => `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`;
export function notePoint(lat, lon, now = Date.now()) { const k = pointKey(lat, lon), had = interest.get(k); if (!had) interest.set(k, { latitude: Number(lat), longitude: Number(lon), since: now, at: now }); else had.at = now; return interest.get(k); }
export function pointsOfInterest(now = Date.now()) { for (const [k, p] of interest) if (now - p.at > 24 * 3_600_000) interest.delete(k); return [...interest.values()]; }
export function lightningAt(p, now = Date.now()) {
  const seen = notePoint(p.latitude, p.longitude, now);
  if (!lightningOn()) return { code: 'none', on: false, at: iso(now), source: 'GOES GLM', point: true };
  if (now - seen.since < RECENT_MS) return { code: 'none', warming: true, readyAt: iso(seen.since + RECENT_MS), at: iso(now), dataAt: state.lastFileAt ? iso(state.lastFileAt) : null, source: 'GOES GLM', point: true };
  return { ...assess({ latitude: p.latitude, longitude: p.longitude }, state.flashes, now, state.lastFileAt), point: true };
}

const state = { flashes: [], seen: new Map(), per: new Map(), buckets: {}, episodes: new Map(), files: 0, duplicates: 0, lastFileAt: null, lastTickAt: null };
/** A red or orange alert still standing for this festival, as the flash it stands on: its end, less the window that end was set from. */
function carried(f, now) {
  const ep = state.episodes.get(f.id);
  const al = ep ? q.alert(f.id, ep.id) : q.activeAlerts(f.id, now).find(x => x.channel === 'lightning' && (x.code === 'red' || x.code === 'orange'));
  if (!al || (al.code !== 'red' && al.code !== 'orange') || !al.expiresAt || Date.parse(al.expiresAt) <= now || !Number.isFinite(Number(al.nearestMi))) return null;
  return { code: al.code, t: Date.parse(al.expiresAt) - (al.code === 'red' ? ALL_CLEAR_MS : RECENT_MS), mi: Number(al.nearestMi) };
}
// Staff confirm or raise a code with the festival's key: it stands over the live grade until its end, never under it (the
// mapper's red is not theirs to lower), and the phones hear the change on the stream.
const RANK = { red: 4, orange: 3, yellow: 2, green: 1, none: 0, indoor: 0 };
export function staffCode(id, now = Date.now()) { const s = JSON.parse(q.setting(`lightning-staff:${id}`) || 'null'); return s && Date.parse(s.until) > now ? s : null; }
export function setStaffCode(id, { code, minutes = 60, note = '' }, now = Date.now()) {
  const s = { code, until: iso(now + Math.min(180, Math.max(5, Number(minutes) || 60)) * MIN), note: String(note || '').slice(0, 200), at: iso(now) };
  q.setSetting(`lightning-staff:${id}`, JSON.stringify(s)); changed(id, 'lightning'); return s;
}
export function clearStaffCode(id) { const had = Boolean(q.setting(`lightning-staff:${id}`)); q.deleteSetting(`lightning-staff:${id}`); if (had) changed(id, 'lightning'); return had; }
export function lightningFor(id, now = Date.now()) {
  const live = state.per.get(id) || null, s = staffCode(id, now);
  if (!s) return live;
  const base = live || { code: 'none', at: iso(now), source: 'GOES GLM' };
  return { ...base, code: (RANK[s.code] || 0) > (RANK[base.code] || 0) ? s.code : base.code, staff: s };
}
/** The flashes of the last half hour within twenty miles of a festival, newest first, for a map: where, how far, how old. */
export const flashesFor = (f, now = Date.now(), limit = 300) => state.flashes
  .map(x => ({ latitude: x.lat, longitude: x.lon, at: iso(x.t), ageSeconds: Math.max(0, Math.round((now - x.t) / 1000)), mi: Math.round(milesBetween(f.latitude, f.longitude, x.lat, x.lon) * 10) / 10, sat: x.sat || null }))
  .filter(x => x.mi <= RINGS.yellow).sort((a, b) => a.ageSeconds - b.ageSeconds).slice(0, limit);
export const lightningStatus = () => ({ on: lightningOn(), lastTickAt: state.lastTickAt ? iso(state.lastTickAt) : null, lastFileAt: state.lastFileAt ? iso(state.lastFileAt) : null,
  files: state.files, flashes: state.flashes.length, duplicates: state.duplicates, buckets: buckets().map(b => ({ bucket: b, files: 0, lastFileAt: null, lastError: null, ...state.buckets[b] })) });
/** Tests start from nothing. */
export function resetLightning() { state.flashes = []; state.seen.clear(); state.per.clear(); state.buckets = {}; state.episodes.clear(); state.files = 0; state.duplicates = 0; state.lastFileAt = state.lastTickAt = null; interest.clear(); }
const errorText = e => `${e?.message || e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`;

/** One pass: list, fetch what is new, trim the buffer, grade every festival that is on, announce a turn to red. */
export async function lightningTick({ now = Date.now(), fetchImpl = globalThis.fetch, festivals = festivalsInWindow(now), maxFiles = 30 } = {}) {
  state.lastTickAt = now;
  const points = pointsOfInterest(now);   // spots phones asked about: read for them too, with no festival on
  if (!festivals.length && !points.length) { state.flashes = []; state.per.clear(); state.episodes.clear(); return { skipped: 'nothing is on' }; }
  const prefixes = [...new Set([hourPrefix(now - ALL_CLEAR_MS), hourPrefix(now)])];
  const wanted = [];
  for (const bucket of buckets()) {
    const b = state.buckets[bucket] ||= { files: 0, lastFileAt: null, lastError: null };
    for (const prefix of prefixes) {
      try {
        const res = await fetchImpl(`https://${bucket}.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(prefix)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} listing ${prefix}`);
        for (const key of parseListing(await res.text())) { const t = keyTime(key); if (t >= now - ALL_CLEAR_MS && t <= now + MIN && !state.seen.has(key)) wanted.push({ bucket, key, t }); }
        b.lastError = null;
      } catch (e) { b.lastError = errorText(e); b.errorAt = iso(now); }
    }
  }
  wanted.sort((a, b) => b.t - a.t);   // newest first, so a catch-up after an outage grades on fresh data first
  let got = 0;
  for (const w of wanted.slice(0, maxFiles)) {
    const b = state.buckets[w.bucket];
    try {
      const res = await fetchImpl(`https://${w.bucket}.s3.amazonaws.com/${w.key}`);
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${w.key}`);
      const flashes = await readFlashes(Buffer.from(await res.arrayBuffer()));
      state.seen.set(w.key, w.t);
      // Where both satellites see a festival, a flash both saw is one flash: the second copy, within two seconds and the
      // mapper's footprint of one already held from the other satellite, is dropped. Each kept flash names its satellite.
      for (const x of flashes) {
        if (!festivals.some(f => milesBetween(f.latitude, f.longitude, x.lat, x.lon) <= REACH_MI) && !points.some(p => milesBetween(p.latitude, p.longitude, x.lat, x.lon) <= REACH_MI)) continue;
        if (state.flashes.some(y => y.sat !== w.bucket && Math.abs(y.t - x.t) <= 2000 && milesBetween(y.lat, y.lon, x.lat, x.lon) <= 6.2)) { state.duplicates++; continue; }
        state.flashes.push({ ...x, sat: w.bucket });
      }
      b.files++; state.files++; got++;
      if (!b.lastFileAt || w.t > b.lastFileAt) b.lastFileAt = w.t;
      if (!state.lastFileAt || w.t > state.lastFileAt) state.lastFileAt = w.t;
    } catch (e) { b.lastError = errorText(e); b.errorAt = iso(now); }
  }
  state.flashes = state.flashes.filter(x => now - x.t <= ALL_CLEAR_MS);
  for (const [k, t] of state.seen) if (t < now - 2 * 3_600_000) state.seen.delete(k);
  for (const f of festivals) {
    const prev = state.per.get(f.id);
    // Indoors (a club, a hall, an arena) the building is the shelter: the protocol is for outdoor grounds, so no code and no alert.
    if (effectiveGround(f).indoor === true) {
      state.per.set(f.id, { code: 'indoor', indoor: true, at: iso(now), dataAt: state.lastFileAt ? iso(state.lastFileAt) : null, source: 'GOES GLM' });
      if (!prev || prev.code !== 'indoor') { for (const al of q.activeAlerts(f.id, now).filter(x => x.channel === 'lightning')) q.updateAlert(f.id, { ...al, expiresAt: iso(now) }); state.episodes.delete(f.id); changed(f.id, 'lightning'); }
      continue;
    }
    const a = assess(f, state.flashes, now, state.lastFileAt, carried(f, now), prev);
    state.per.set(f.id, a);
    if (!prev || prev.code !== a.code || prev.nearestMi !== a.nearestMi || Boolean(prev.allClearHeld) !== a.allClearHeld || Boolean(prev.held) !== a.held) changed(f.id, 'lightning');
    try { await announce(f, prev, a, now); } catch (e) { console.error(`[${f.id}] lightning alert failed:`, errorText(e)); }
  }
  for (const id of state.per.keys()) if (!festivals.some(f => f.id === id)) state.per.delete(id);
  return { files: got, wanted: wanted.length, flashes: state.flashes.length };
}

// The festival safety protocol, in its own words. The web build's CODE table carries the same text; change both.
const SHELTER = 'Shelter is a hard-topped vehicle or a building with wiring and plumbing. Tents, canopies and stages are not shelter.';
export const PROTOCOL = {
  red: { event: 'Code Red: lightning within 8 miles', severity: 'severe', line: 'Rapid evacuation required. Full work stoppage.',
    text: 'Lightning has been detected in less than an 8 mile radius. Rapid evacuation required. Non-essential personnel should prioritize exit and do not need to maintain posts. Full work stoppage.',
    instruction: 'Get to shelter now. Non-essential personnel exit first. Stay until the all-clear thirty minutes after the last flash within 8 miles.',
    ends: 'This alert ends with the all-clear thirty minutes after the last flash within 8 miles.' },
  orange: { event: 'Code Orange: lightning within 12 miles', severity: 'moderate', line: 'Execute evacuation procedures. Staff hold posts to assist attendees.',
    text: 'Lightning within 8 to 12 miles. Execute evacuation procedures while maintaining assigned posts to assist attendees.',
    instruction: 'Head for shelter or the exits as staff direct. Staff run evacuation procedures and hold their posts.',
    ends: 'This alert ends fifteen minutes after the last flash within 12 miles or when the code changes.' },
  yellow: { text: 'Weather 12 to 20 miles from site. Pay attention and get things prepared for orange and a potential work stoppage.' },
  green: { text: 'No lightning within 20 miles in the last 15 minutes.' },
};
const until = a => a.code === 'red' ? a.allClearAt : a.code === 'orange' ? a.orangeUntil : null;
const CODE_NAME = { red: 'Code Red', orange: 'Code Orange', yellow: 'Code Yellow', green: 'Code Green' };
/** The lift, in the protocol's words: what has passed, and what the code is now, or that the mapper could not confirm it. */
export function liftWords(prevCode, a) {
  const since = prevCode === 'red' ? 'Thirty minutes since the last flash within 8 miles' : 'Fifteen minutes since the last flash within 12 miles';
  const now = a.code === 'none' ? `No lightning data for ${Math.max(1, Math.round((a.dataAgeSeconds || 0) / 60))} minutes, so the mapper could not confirm it.` : `Now ${CODE_NAME[a.code]}: ${PROTOCOL[a.code].text}`;
  return { title: `All clear: ${CODE_NAME[prevCode]} lifted`, why: `${since}. ${now}` };
}
function codeAlert(f, a, tz, now) {
  const p = PROTOCOL[a.code], mi = a.code === 'red' ? a.lastNearMi : a.nearestMi, at = a.code === 'red' ? a.lastNearAt : a.nearestAt;
  return { id: `lightning-${f.id}-${a.code}-${Math.floor(now / MIN)}`, event: p.event, headline: `Lightning ${mi} mi away at ${clock(at, tz)}. ${p.line}`,
    body: `${p.text} ${SHELTER} ${p.ends}`, instruction: p.instruction, severity: p.severity, area: f.location, source: 'GOES lightning mapper via Fieldwatch',
    issuedAt: iso(now), onset: at, expiresAt: until(a), channel: 'lightning', relayCount: 0, code: a.code, nearestMi: mi };
}
/** Orange and red are alerts: pushed when the code changes to them, ended when it changes away, their end kept in step with the flashes. */
async function announce(f, prev, a, now) {
  const ep = state.episodes.get(f.id);
  if (prev && a.code === prev.code) {
    const old = ep && q.alert(f.id, ep.id), end = until(a);
    if (old && end && old.expiresAt !== end) q.updateAlert(f.id, { ...old, expiresAt: end, nearestMi: a.nearestMi ?? old.nearestMi });
    return;
  }
  let was = null;
  if (ep) { const old = q.alert(f.id, ep.id); if (old) { if (!old.expiresAt || Date.parse(old.expiresAt) > now) q.updateAlert(f.id, { ...old, expiresAt: iso(now) }); was = old; } state.episodes.delete(f.id); }   // an alert that ran out on its own is still the one lifted
  if (a.code !== 'red' && a.code !== 'orange') {
    // The code came down past orange: the alert that stood is lifted, and the phones that heard it hear that too, quietly.
    if (prev && (prev.code === 'red' || prev.code === 'orange')) {
      console.log(`[${f.id}] lightning: ${a.code}`);
      if (was) { const lift = liftWords(prev.code, a); q.log(f.id, 'lightning-lift', { from: prev.code, to: a.code, event: lift.title }); const r = await pushEnded(q.tokensFor(f.id), f, was, lift), w = await pushEndedWeb(f, was, lift); console.log(`[${f.id}] lightning lifted: ${lift.title} push=${JSON.stringify(r)} web=${JSON.stringify(w)}`); }
    }
    return;
  }
  // After a restart the alert may already be there from before; adopt it rather than push it twice.
  const had = q.activeAlerts(f.id, now).find(x => x.channel === 'lightning' && x.code === a.code);
  if (had) { state.episodes.set(f.id, { code: a.code, id: had.id }); if (until(a) && had.expiresAt !== until(a)) q.updateAlert(f.id, { ...had, expiresAt: until(a) }); return; }
  const tz = await point(f.latitude, f.longitude).then(p => p.timeZone).catch(() => null);
  const alert = codeAlert(f, a, tz, now);
  if (q.alert(f.id, alert.id)) q.updateAlert(f.id, alert); else q.insertAlert(f.id, alert);
  q.count(f.id, 'lightning.alert');
  q.log(f.id, 'lightning', { code: a.code, event: alert.event, nearestMi: alert.nearestMi, expiresAt: alert.expiresAt });
  state.episodes.set(f.id, { code: a.code, id: alert.id });
  const r = await pushAlert(q.tokensFor(f.id), f, alert), w = await pushWeb(f, alert);
  console.log(`[${f.id}] lightning: ${a.code}, ${alert.nearestMi} mi push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
}

export function startLightning(seconds = Number(process.env.LIGHTNING_SECONDS || 20)) {
  if (!lightningOn()) return false;
  const run = () => lightningTick().catch(e => console.error('lightning failed:', errorText(e)));
  run(); setInterval(run, seconds * 1000);
  return true;
}
