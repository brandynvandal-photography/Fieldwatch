// Radar loop per festival. NEXRAD base reflectivity composites from the Iowa Environmental
// Mesonet's WMS-T archive (NWS data, free, no key, any 5-minute timestamp back to 1995), one
// image per RADAR_STEP_MINUTES over the last RADAR_HOURS, for a fixed 320 km square around
// the grounds. A frame never changes once it exists, so only the newest is ever new, and every
// phone gets the same files from us instead of each hitting the archive on its own.
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { festivalsInWindow } from './poller.js';
import { iso } from './util.js';

export const RADAR_DIR = resolve(process.env.RADAR_DIR || 'radar');
export const ATTRIBUTION = 'NOAA NEXRAD via Iowa Environmental Mesonet';
const WMS = process.env.RADAR_WMS || 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi';
const LAYER = process.env.RADAR_LAYER || 'nexrad-n0q-wmst';
const HOURS = Number(process.env.RADAR_HOURS || 12);
const STEP_MS = Number(process.env.RADAR_STEP_MINUTES || 10) * 60_000;
const LAG_MS = 10 * 60_000;     // a composite is available a few minutes after its timestamp
const HALF_M = 160_000;         // metres from the grounds to the edge of the image
export const SIZE = 512;
const UA = process.env.NWS_USER_AGENT || 'Fieldwatch/0.1 (you@example.com)';

// EPSG:3857, which MapKit and the WMS share, so the image drops straight onto the map.
const R = 6378137;
export const mercator = (lat, lon) => ({ x: R * lon * Math.PI / 180, y: R * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) });
export const inverseMercator = (x, y) => ({ lon: x / R * 180 / Math.PI, lat: (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI });

/** The square every frame is rendered for: metres for the WMS, degrees for the phone. */
export function coverage(f) {
  const c = mercator(f.latitude, f.longitude);
  const bbox = [c.x - HALF_M, c.y - HALF_M, c.x + HALF_M, c.y + HALF_M];
  const sw = inverseMercator(bbox[0], bbox[1]), ne = inverseMercator(bbox[2], bbox[3]);
  return { bbox, bounds: { north: ne.lat, south: sw.lat, east: ne.lon, west: sw.lon } };
}

/** Timestamps (ms) a loop should hold right now, oldest first, on step boundaries. */
export function frameTimes(now = Date.now()) {
  const newest = Math.floor((now - LAG_MS) / STEP_MS) * STEP_MS;
  const times = [];
  for (let t = newest - HOURS * 3600_000 + STEP_MS; t <= newest; t += STEP_MS) times.push(t);
  return times;
}

export const frameName = t => `${iso(t).slice(0, 16).replace(/[-:]/g, '')}Z.png`;     // 20261024T2100Z.png
const FRAME = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})Z\.png$/;
const frameTime = name => { const m = FRAME.exec(name); return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]) : null; };

export function frameURL(f, t) {
  const { bbox } = coverage(f);
  const p = new URLSearchParams({
    SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: LAYER, STYLES: '', SRS: 'EPSG:3857',
    BBOX: bbox.map(n => n.toFixed(0)).join(','), WIDTH: SIZE, HEIGHT: SIZE, FORMAT: 'image/png', TRANSPARENT: 'true', TIME: iso(t),
  });
  return `${WMS}?${p}`;
}

const dirFor = id => join(RADAR_DIR, id);

/** Frame times on disk for a festival, oldest first. */
export function storedFrames(id) {
  if (!existsSync(dirFor(id))) return [];
  return readdirSync(dirFor(id)).map(frameTime).filter(t => t !== null).sort((a, b) => a - b);
}

async function fetchFrame(f, t) {
  const res = await fetch(frameURL(f, t), { headers: { 'User-Agent': UA } });
  const type = (res.headers.get('content-type') || '').split(';')[0];
  if (!res.ok || !type.startsWith('image/')) throw new Error(`radar ${res.status} ${type || 'no type'} for ${iso(t)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error(`radar empty for ${iso(t)}`);
  mkdirSync(dirFor(f.id), { recursive: true });
  const file = join(dirFor(f.id), frameName(t));
  writeFileSync(`${file}.tmp`, buf);
  renameSync(`${file}.tmp`, file);
}

function prune(id, oldestWanted) {
  if (!existsSync(dirFor(id))) return;
  for (const name of readdirSync(dirFor(id))) {
    const t = frameTime(name);
    const stale = t !== null ? t < oldestWanted : name.endsWith('.tmp') && Date.now() - statSync(join(dirFor(id), name)).mtimeMs > 60_000;
    if (stale) try { unlinkSync(join(dirFor(id), name)); } catch {}
  }
}

const inflight = new Map();     // festival id -> the refresh promise currently running for it
const lastRefresh = new Map();
const failures = new Map();     // `${id}/${t}` -> attempts; a frame the archive never produces stops being asked for
const MAX_ATTEMPTS = 3;
const PAUSE_MS = Number(process.env.RADAR_FETCH_PAUSE_MS ?? 100);   // between requests on a first fill; 0 in tests
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Fetch what this festival's window is missing, newest first (so a phone opening the loop sees
 * the present before the past fills in), then drop what fell out of the window. Only one refresh
 * runs per festival at a time; a second caller gets the running one. Callers usually fire it in
 * the background and serve whatever is on disk.
 */
export function refreshRadar(f, opts = {}) {
  if (inflight.has(f.id)) return inflight.get(f.id);
  const run = fill(f, opts).finally(() => inflight.delete(f.id));
  inflight.set(f.id, run);
  return run;
}

async function fill(f, { now = Date.now() } = {}) {
  const wanted = frameTimes(now);
  const have = new Set(storedFrames(f.id));
  const missing = wanted.filter(t => !have.has(t) && (failures.get(`${f.id}/${t}`) || 0) < MAX_ATTEMPTS).reverse();
  let fetched = 0, failed = 0, gaveUp = 0, firstError = null;
  for (const t of missing) {
    try { await fetchFrame(f, t); fetched++; }
    catch (e) {
      const key = `${f.id}/${t}`, n = (failures.get(key) || 0) + 1;
      failures.set(key, n);
      failed++; if (n >= MAX_ATTEMPTS) gaveUp++; firstError ??= e.message;
    }
    if (missing.length > 3 && PAUSE_MS) await sleep(PAUSE_MS);   // a first fill is dozens of requests; don't hammer the archive
  }
  // One line per refresh, not one per frame: an archive outage would otherwise flood the log.
  if (failed) console.error(`[${f.id}] radar: ${fetched} frames fetched, ${failed} failed${gaveUp ? ` (${gaveUp} given up)` : ''}: ${firstError}`);
  else if (fetched) console.log(`[${f.id}] radar: ${fetched} new frame${fetched === 1 ? '' : 's'}`);
  prune(f.id, wanted[0]);
  for (const key of failures.keys()) if (key.startsWith(`${f.id}/`) && Number(key.split('/')[1]) < wanted[0]) failures.delete(key);
  lastRefresh.set(f.id, now);
}

export const refreshedRecently = (id, ms = 5 * 60_000) => Date.now() - (lastRefresh.get(id) || 0) < ms;

/** Refresh in the background unless it just happened. Errors are logged per frame, never thrown. */
export function refreshRadarSoon(f) {
  if (refreshedRecently(f.id) || inflight.has(f.id)) return;
  refreshRadar(f).catch(e => console.error(`[${f.id}] radar refresh failed:`, e.message));
}

/** What the phone downloads: the square, and one immutable URL per frame, oldest first. Mirrors RadarLoop in Swift. */
export function radarLoop(f) {
  return {
    festivalId: f.id, generatedAt: iso(), hours: HOURS, stepMinutes: STEP_MS / 60_000, size: SIZE,
    bounds: coverage(f).bounds, attribution: ATTRIBUTION,
    frames: storedFrames(f.id).map(t => ({ time: iso(t), url: `/radar/${f.id}/${frameName(t)}` })),
  };
}

export function startRadarLoop(seconds = Number(process.env.RADAR_REFRESH_SECONDS || 300)) {
  const tick = () => { for (const f of festivalsInWindow()) refreshRadarSoon(f); };
  tick();
  setInterval(tick, seconds * 1000);
}
