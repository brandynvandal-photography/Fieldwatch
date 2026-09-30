// The radar nowcast against frames drawn by hand: a colored blob moving toward the grounds, away from them, or sitting on them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';

process.env.DB_PATH = ':memory:';
process.env.RADAR_DIR = mkdtempSync(join(tmpdir(), 'fieldwatch-nowcast-'));
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
const { SIZE, frameName } = await import('../src/radar.js');
const { N, arrival, echoMask, motion, nowcastFor, resetNowcast } = await import('../src/nowcast.js');

const T0 = Date.UTC(2026, 9, 24, 21, 0), STEP = 600_000;
/** A frame: transparent, with a colored disc (the archive's green for light rain) at (cx, cy), radius r, plus a gray border like the archive draws. */
function frame(blobs) {
  const png = new PNG({ width: SIZE, height: SIZE });
  for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
    const i = (y * SIZE + x) * 4;
    const inBlob = blobs.some(([cx, cy, r]) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r);
    if (inBlob) { png.data[i] = 0; png.data[i + 1] = 200; png.data[i + 2] = 0; png.data[i + 3] = 255; }
    else if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) { png.data[i] = 120; png.data[i + 1] = 120; png.data[i + 2] = 120; png.data[i + 3] = 255; }
    else png.data[i + 3] = 0;
  }
  return PNG.sync.write(png);
}
function write(id, frames) {
  mkdirSync(join(process.env.RADAR_DIR, id), { recursive: true });
  frames.forEach((blobs, i) => writeFileSync(join(process.env.RADAR_DIR, id, frameName(T0 + i * STEP)), frame(blobs)));
  resetNowcast();
}

test('an echo mask sees color, not the gray border or the transparent dry', () => {
  const m = echoMask(PNG.sync.read(frame([[256, 256, 20]])));
  let cells = 0; for (const v of m) cells += v;
  assert.ok(cells >= 60 && cells <= 90, `a 20 px disc is about 78 cells: ${cells}`);
  assert.equal(m[0], 0, 'the border is not echo'); assert.equal(m[(N / 2) * N + N / 2], 1);
  assert.equal(echoMask(new PNG({ width: 1, height: 1 })), null, 'a placeholder pixel is not a frame');
});

test('motion is the shift that lines the masks up; arrival walks upstream from the grounds', () => {
  const a = echoMask(PNG.sync.read(frame([[100, 256, 24]]))), b = echoMask(PNG.sync.read(frame([[124, 256, 24]])));
  const v = motion(a, b);
  assert.deepEqual({ dx: v.dx, dy: v.dy }, { dx: 6, dy: 0 }, '24 px east in a step is 6 cells'); assert.ok(v.score > 0.8);
  assert.equal(arrival(b, v), 26, 'the disc\'s leading edge (124 + 24 px) is 108 px, 27 cells, west of the center, and the corridor sees it a cell early');
  assert.equal(arrival(b, { dx: -6, dy: 0 }), null, 'moving west, away: nothing arrives');
  assert.equal(arrival(echoMask(PNG.sync.read(frame([[256, 256, 20]]))), v), 0, 'over the grounds: raining now');
  assert.equal(motion(echoMask(PNG.sync.read(frame([]))), b), null, 'nothing in the older frame to track');
});

test('the nowcast: a blob 38 cells out moving east at 6 cells a step arrives in about 45 minutes, less the age of the frame', () => {
  write('nc-east', [[[56, 256, 24]], [[80, 256, 24]], [[104, 256, 24]]]);
  const f = { id: 'nc-east', latitude: 30.404, longitude: -82.9395 };
  const r = nowcastFor(f, { now: T0 + 2 * STEP + 10 * 60_000 });
  assert.equal(r.tracked, true); assert.equal(r.raining, false); assert.equal(r.heading, 'E'); assert.equal(r.headingDeg, 90);
  assert.equal(r.speedKmh, 90, 'six cells of 2.5 km in ten minutes'); assert.equal(r.cellsAway, 31, 'leading edge at 128 px, 32 cells from the center, seen a cell early'); assert.equal(r.distanceKm, 78);
  assert.equal(r.stepMinutes, 52); assert.equal(r.ageMinutes, 10); assert.equal(r.minutes, 42, 'ten minutes of that have already passed');
  assert.equal(r.at, '2026-10-24T21:20:00Z');
  assert.equal(nowcastFor(f, { now: T0 + 2 * STEP + 30 * 60_000 }).minutes, 22, 'the same frames later: less time left');
  write('nc-away', [[[400, 256, 24]], [[424, 256, 24]], [[448, 256, 24]]]);
  const away = nowcastFor({ id: 'nc-away' }, { now: T0 + 2 * STEP });
  assert.equal(away.tracked, true); assert.equal(away.minutes, null, 'moving away: nothing on the way'); assert.equal(away.heading, 'E');
  write('nc-here', [[[240, 256, 30]], [[248, 256, 30]], [[256, 256, 30]]]);
  const here = nowcastFor({ id: 'nc-here' }, { now: T0 + 2 * STEP });
  assert.equal(here.raining, true); assert.equal(here.minutes, 0);
  write('nc-dry', [[], [], []]);
  const dry = nowcastFor({ id: 'nc-dry' }, { now: T0 + 2 * STEP });
  assert.equal(dry.tracked, false); assert.equal(dry.minutes, null);
  assert.equal(nowcastFor({ id: 'nc-none' }), null, 'no frames on disk');
  write('nc-one', [[[56, 256, 24]]]);
  assert.equal(nowcastFor({ id: 'nc-one' }), null, 'one frame cannot show motion');
});
