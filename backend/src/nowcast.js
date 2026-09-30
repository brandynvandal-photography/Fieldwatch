// Where the rain on the radar is going, and when it gets here. The newest frames already on disk for a festival (radar.js:
// a 512 px square every ten minutes, 625 m per pixel, the grounds at the center) give an echo mask each; the shift that lines
// two masks up best is the storm motion over a step; the first echo upstream of the grounds along that motion, over the
// speed, is the arrival. Rough, honest and only for the next two hours; the forecast carries the rest.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { RADAR_DIR, frameName, storedFrames } from './radar.js';   // used inside functions only: radar.js reaches this module through the poller, so nothing here may run at import
import { iso } from './util.js';

export const N = 128, CELL_KM = 320 / N;           // the square is 320 km across; masks at 128 cells, 2.5 km each
const SEARCH = 8;                                  // cells per step: 20 km in ten minutes, 120 km/h, as fast as rain moves
const STEP_MS = 10 * 60_000, CORRIDOR = 2;         // cells either side of the line the rain is on

/** An echo mask from a frame: a cell is echo when a quarter of its pixels are colored. The archive's palette is color on transparent; gray is a border or a label. */
export function echoMask(png) {
  const { width, height, data } = png;
  if (width < 64 || height < 64) return null;
  const counts = new Uint16Array(N * N), sx = width / N, sy = height / N;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    if (data[i + 3] < 96) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (Math.max(r, g, b) - Math.min(r, g, b) < 40) continue;
    counts[Math.min(N - 1, Math.floor(y / sy)) * N + Math.min(N - 1, Math.floor(x / sx))]++;
  }
  const per = (sx * sy) / 4, mask = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) mask[i] = counts[i] >= per ? 1 : 0;
  return mask;
}
/** The shift (cells) that lines the older mask up with the newer one best, and how well (0 to 1). Null when there is too little echo to track. */
export function motion(older, newer) {
  let total = 0; for (let i = 0; i < N * N; i++) total += newer[i];
  let olderTotal = 0; for (let i = 0; i < N * N; i++) olderTotal += older[i];
  if (total < 8 || olderTotal < 8) return null;
  let best = { dx: 0, dy: 0, score: -1 };
  for (let dy = -SEARCH; dy <= SEARCH; dy++) for (let dx = -SEARCH; dx <= SEARCH; dx++) {
    let hit = 0;
    for (let y = Math.max(0, dy); y < Math.min(N, N + dy); y++) { const row = y * N, srow = (y - dy) * N;
      for (let x = Math.max(0, dx); x < Math.min(N, N + dx); x++) if (older[srow + x - dx] && newer[row + x]) hit++; }
    const score = hit / Math.max(total, olderTotal);
    if (score > best.score + 1e-9) best = { dx, dy, score };
  }
  return best.score >= 0.3 ? best : null;
}
const near = (mask, x, y) => { for (let j = -CORRIDOR; j <= CORRIDOR; j++) for (let i = -CORRIDOR; i <= CORRIDOR; i++) { const xx = x + i, yy = y + j; if (xx >= 0 && yy >= 0 && xx < N && yy < N && mask[yy * N + xx]) return true; } return false; };
/** Upstream from the center along the motion: how many cells to the first echo. Zero when it is raining on the grounds; null when nothing is coming this way. */
export function arrival(mask, v) {
  const c = N / 2;
  if (near(mask, c, c)) return 0;
  const speed = Math.hypot(v.dx, v.dy);
  if (speed < 1) return null;
  const ux = -v.dx / speed, uy = -v.dy / speed;
  for (let d = 1; d < N; d++) {
    const x = Math.round(c + ux * d), y = Math.round(c + uy * d);
    if (x < 0 || y < 0 || x >= N || y >= N) break;
    if (near(mask, x, y)) return d;
  }
  return null;
}
const compass = deg => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8];

const cache = new Map();
/**
 * The nowcast for a festival from its newest three frames: { at, tracked, minutes, distanceKm, speedKmh, headingDeg, heading, raining }
 * with minutes null when nothing is coming this way, or null when there are not two frames to compare.
 */
export function nowcastFor(f, { now = Date.now() } = {}) {
  const times = storedFrames(f.id).filter(t => existsSync(join(RADAR_DIR, f.id, frameName(t)))).slice(-3);
  if (times.length < 2) return null;
  const newest = times[times.length - 1], hit = cache.get(f.id);
  let r = hit && hit.newest === newest ? hit.result : null;
  if (!r) {
    const masks = times.map(t => { try { return echoMask(PNG.sync.read(readFileSync(join(RADAR_DIR, f.id, frameName(t))))); } catch { return null; } });
    const pairs = [];
    for (let i = 1; i < masks.length; i++) { if (!masks[i - 1] || !masks[i]) continue; const m = motion(masks[i - 1], masks[i]); const steps = (times[i] - times[i - 1]) / STEP_MS; if (m && steps >= 1) pairs.push({ dx: m.dx / steps, dy: m.dy / steps, score: m.score }); }
    const last = masks[masks.length - 1];
    if (!last || !pairs.length) r = { at: iso(newest), tracked: false, minutes: null, raining: last ? near(last, N / 2, N / 2) : false };
    else {
      // The newest pair says where it is going; the older one steadies the speed when the two agree.
      const v = pairs.length > 1 && Math.hypot(pairs[0].dx - pairs[1].dx, pairs[0].dy - pairs[1].dy) <= 2 ? { dx: (pairs[0].dx + pairs[1].dx) / 2, dy: (pairs[0].dy + pairs[1].dy) / 2 } : pairs[pairs.length - 1];
      const speed = Math.hypot(v.dx, v.dy), cells = arrival(last, v);
      const headingDeg = speed >= 1 ? Math.round((Math.atan2(v.dx, -v.dy) * 180 / Math.PI + 360) % 360) : null;
      r = { at: iso(newest), tracked: true, score: Math.round(pairs[pairs.length - 1].score * 100) / 100, speedKmh: Math.round(speed * CELL_KM * 6), headingDeg, heading: headingDeg == null ? null : compass(headingDeg),
        raining: cells === 0, cellsAway: cells, distanceKm: cells == null ? null : Math.round(cells * CELL_KM), stepMinutes: cells == null || cells === 0 ? null : Math.round(cells / speed * 10) };
    }
    cache.set(f.id, { newest, result: r });
  }
  // The newest frame is already some minutes old; the clock has moved on since it.
  const age = Math.max(0, Math.round((now - Date.parse(r.at)) / 60_000));
  const minutes = r.raining ? 0 : r.stepMinutes == null ? null : Math.max(0, r.stepMinutes - age);
  return { ...r, minutes, ageMinutes: age };
}
export const resetNowcast = () => cache.clear();
