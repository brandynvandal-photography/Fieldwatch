import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.RADAR_FETCH_PAUSE_MS = '0';
process.env.RADAR_DIR = mkdtempSync(join(tmpdir(), 'fieldwatch-radar-'));
process.env.RADAR_HOURS = '12';
process.env.RADAR_STEP_MINUTES = '10';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@fieldwatch.test)';

// A real 1x1 transparent PNG, which is all the archive needs to have answered with.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const requests = [];
let failFor = () => false;   // (url) => true to make the archive answer with an error page
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  requests.push(url);
  assert.equal(opts.headers?.['User-Agent'], process.env.NWS_USER_AGENT, 'the archive sees who we are');
  if (failFor(url)) return new Response('<ServiceExceptionReport>no data</ServiceExceptionReport>', { status: 200, headers: { 'content-type': 'application/vnd.ogc.se_xml' } });
  return new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });
};

const radar = await import('../src/radar.js');
const { q } = await import('../src/db.js');
const festival = { id: 'hulaween-2026', name: 'Suwannee Hulaween', latitude: 30.404, longitude: -82.9395, startDate: '2026-10-22T14:00:00Z', endDate: '2026-10-26T04:00:00Z' };
q.upsertFestival({ ...festival, location: 'x', county: 'Suwannee County', isPartner: false, feeds: [], site: [] });

const NOW = Date.UTC(2026, 9, 24, 21, 17, 30);   // 2026-10-24T21:17:30Z

test('mercator round-trips and the coverage is a 320 km square centered on the grounds', () => {
  const m = radar.mercator(festival.latitude, festival.longitude);
  const back = radar.inverseMercator(m.x, m.y);
  assert.ok(Math.abs(back.lat - festival.latitude) < 1e-9 && Math.abs(back.lon - festival.longitude) < 1e-9);
  const origin = radar.mercator(0, 0);
  assert.ok(Math.abs(origin.x) < 1e-6 && Math.abs(origin.y) < 1e-6);
  const { bbox, bounds } = radar.coverage(festival);
  assert.equal(bbox[2] - bbox[0], 320_000); assert.equal(bbox[3] - bbox[1], 320_000);
  assert.ok(bounds.north > festival.latitude && bounds.south < festival.latitude);
  assert.ok(bounds.east > festival.longitude && bounds.west < festival.longitude);
  assert.ok(Math.abs((bounds.north + bounds.south) / 2 - festival.latitude) < 0.05, 'Mercator squares are not quite symmetric in degrees, but close');
  assert.ok(Math.abs((bounds.east + bounds.west) / 2 - festival.longitude) < 1e-9);
});

test('frame times are 72 ten-minute steps ending at least ten minutes ago', () => {
  const times = radar.frameTimes(NOW);
  assert.equal(times.length, 72);
  assert.equal(new Date(times.at(-1)).toISOString(), '2026-10-24T21:00:00.000Z', 'newest is the last boundary that is 10+ minutes old');
  assert.equal(new Date(times[0]).toISOString(), '2026-10-24T09:10:00.000Z');
  for (let i = 1; i < times.length; i++) assert.equal(times[i] - times[i - 1], 600_000);
  assert.equal(radar.frameName(times.at(-1)), '20261024T2100Z.png');
});

test('the WMS request asks the archive for exactly our square at exactly that time', () => {
  const u = new URL(radar.frameURL(festival, Date.UTC(2026, 9, 24, 21, 0)));
  assert.equal(u.origin + u.pathname, 'https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi');
  assert.equal(u.searchParams.get('LAYERS'), 'nexrad-n0q-wmst');
  assert.equal(u.searchParams.get('SRS'), 'EPSG:3857');
  assert.equal(u.searchParams.get('TIME'), '2026-10-24T21:00:00Z');
  assert.equal(u.searchParams.get('WIDTH'), '512');
  assert.equal(u.searchParams.get('TRANSPARENT'), 'true');
  assert.equal(u.searchParams.get('BBOX').split(',').length, 4);
});

test('refresh fills the window newest first, refetches nothing that exists, and rolls the window forward', async () => {
  requests.length = 0;
  const { live } = await import('../src/live.js'), heard = [];
  live.on('change', e => heard.push(e));
  await radar.refreshRadar(festival, { now: NOW });
  assert.equal(requests.length, 72);
  assert.equal(heard.length, 1); assert.equal(heard[0].festivalId, festival.id); assert.equal(heard[0].kind, 'radar', 'a page on the radar screen hears that frames landed');
  assert.match(requests[0], /TIME=2026-10-24T21%3A00%3A00Z/, 'newest frame first');
  assert.equal(readdirSync(join(process.env.RADAR_DIR, festival.id)).length, 72);

  requests.length = 0;
  await radar.refreshRadar(festival, { now: NOW });
  assert.equal(requests.length, 0, 'frames are immutable; nothing to do'); assert.equal(heard.length, 1, 'and nothing to announce');

  await radar.refreshRadar(festival, { now: NOW + 10 * 60_000 });
  assert.equal(requests.length, 1, 'one new frame');
  const files = readdirSync(join(process.env.RADAR_DIR, festival.id)).sort();
  assert.equal(files.length, 72, 'the oldest frame was pruned');
  assert.equal(files[0], '20261024T0920Z.png');
  assert.equal(files.at(-1), '20261024T2110Z.png');
});

test('an error page from the archive is not cached and is retried, but not forever', async () => {
  const later = NOW + 20 * 60_000;                       // wants 21:20 now
  failFor = url => url.includes('TIME=2026-10-24T21%3A20');
  requests.length = 0;
  await radar.refreshRadar(festival, { now: later });
  assert.equal(requests.length, 1);
  assert.ok(!readdirSync(join(process.env.RADAR_DIR, festival.id)).includes('20261024T2120Z.png'), 'no XML saved as a frame');
  await radar.refreshRadar(festival, { now: later });
  await radar.refreshRadar(festival, { now: later });
  assert.equal(requests.length, 3, 'retried on each refresh');
  await radar.refreshRadar(festival, { now: later });
  assert.equal(requests.length, 3, 'given up after three failures');
  failFor = () => false;
});

test('the manifest lists what is on disk, oldest first, as the phone expects', () => {
  const loop = radar.radarLoop(festival, NOW + 20 * 60_000);
  assert.equal(loop.newestAt, '2026-10-24T21:10:00Z');
  assert.equal(loop.festivalId, festival.id);
  assert.equal(loop.hours, 12); assert.equal(loop.stepMinutes, 10); assert.equal(loop.size, 512);
  assert.equal(loop.attribution, 'NOAA NEXRAD via Iowa Environmental Mesonet');
  assert.deepEqual(Object.keys(loop.bounds).sort(), ['east', 'north', 'south', 'west']);
  assert.equal(loop.frames.length, 71, '72 minus the 21:20 frame the archive never produced');
  assert.equal(loop.frames[0].time, '2026-10-24T09:30:00Z');
  assert.equal(loop.frames[0].url, '/radar/hulaween-2026/20261024T0930Z.png');
  assert.equal(loop.frames.at(-1).time, '2026-10-24T21:10:00Z');
  assert.match(loop.generatedAt, /Z$/);
  // stray files in the folder are ignored
  mkdirSync(join(process.env.RADAR_DIR, 'nowhere-2026'), { recursive: true });
  writeFileSync(join(process.env.RADAR_DIR, 'nowhere-2026', 'notes.txt'), 'x');
  assert.deepEqual(radar.storedFrames('nowhere-2026'), []);
  assert.deepEqual(radar.storedFrames('never-heard-of-it'), []);
  // A cache that stopped filling: last evening's frames are on disk, but the manifest as of this afternoon leaves them out.
  const stale = { ...festival, id: 'stale-2026' };
  mkdirSync(join(process.env.RADAR_DIR, stale.id), { recursive: true });
  for (const name of ['20261024T1800Z.png', '20261024T1810Z.png', '20261025T0900Z.png']) writeFileSync(join(process.env.RADAR_DIR, stale.id, name), 'png');
  const afternoon = radar.radarLoop(stale, Date.UTC(2026, 9, 25, 16, 0));
  assert.deepEqual(afternoon.frames.map(x => x.time), ['2026-10-25T09:00:00Z'], 'only what falls inside the last twelve hours as of now');
  assert.equal(afternoon.newestAt, '2026-10-25T09:00:00Z');
});
