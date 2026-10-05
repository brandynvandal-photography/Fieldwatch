// Lightning codes from GOES GLM files: the file reader against files written the way NOAA writes them, the grading,
// and a full pass against a fake bucket. Nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@fieldwatch.test)';
process.env.GLM_BUCKETS = 'noaa-goes19,noaa-goes18';
const { default: webpushLib } = await import('web-push');
const vapid = webpushLib.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey; process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

const { ALL_CLEAR_MS, assess, flashesFor, hourPrefix, keyTime, lightningAt, lightningFor, lightningStatus, lightningTick, milesBetween, motionOf, parseListing, pointsOfInterest, readFlashes, resetLightning } = await import('../src/lightning.js');
const { q } = await import('../src/db.js');
const { setWebPushTransport } = await import('../src/webpush.js');
const { default: h5wasm } = await import('h5wasm/node');
await h5wasm.ready;

const J2000 = Date.UTC(2000, 0, 1, 12), MIN = 60_000, MI = 1609.344;
const dir = mkdtempSync(join(tmpdir(), 'fieldwatch-glm-test-'));
let n = 0;
/** An LCFA file as NOAA lays it out: float32 flash_lat/flash_lon, the first-event offset packed to int16 with scale and offset, product_time in J2000 seconds. */
function lcfa(startMs, flashes) {
  const path = join(dir, `f${n++}.nc`), sf = 0.0003814756, ao = 12.5;
  const f = new h5wasm.File(path, 'w');
  f.create_dataset({ name: 'flash_lat', data: new Float32Array(flashes.map(x => x.lat)), shape: [flashes.length], dtype: '<f4' });
  f.create_dataset({ name: 'flash_lon', data: new Float32Array(flashes.map(x => x.lon)), shape: [flashes.length], dtype: '<f4' });
  f.create_dataset({ name: 'flash_time_offset_of_first_event', data: new Int16Array(flashes.map(x => Math.round(((x.offsetS ?? 0) - ao) / sf))), shape: [flashes.length], dtype: '<i2' });
  const ds = f.get('flash_time_offset_of_first_event'); ds.create_attribute('scale_factor', sf, [], '<f4'); ds.create_attribute('add_offset', ao, [], '<f4');
  f.create_dataset({ name: 'product_time', data: new Float64Array([(startMs - J2000) / 1000]), shape: [], dtype: '<d' });   // h5wasm's float64 is '<d'; '<f8' silently becomes float32
  f.close();
  return readFileSync(path);
}
const fest = { id: 'bolt-test', name: 'Bolt Test Fest', location: 'Live Oak, FL', latitude: 30.404, longitude: -82.9395, startDate: '2026-09-29T00:00:00Z', endDate: '2026-10-02T00:00:00Z' };
/** A point `mi` miles due north of the festival. */
const north = mi => ({ lat: fest.latitude + mi * MI / 111_195, lon: fest.longitude });
const key = (sat, t) => { const d = new Date(t), doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86_400_000) + 1;
  const p = (v, w) => String(v).padStart(w, '0'); const s = `${d.getUTCFullYear()}${p(doy, 3)}${p(d.getUTCHours(), 2)}${p(d.getUTCMinutes(), 2)}${p(d.getUTCSeconds(), 2)}0`;
  return `${hourPrefix(t)}OR_GLM-L2-LCFA_${sat}_s${s}_e${s}_c${s}.nc`; };

test('a file name carries its start time; an hour has a prefix; a listing is its keys', () => {
  assert.equal(keyTime('GLM-L2-LCFA/2026/273/14/OR_GLM-L2-LCFA_G19_s20262731405000_e20262731405200_c20262731405226.nc'), Date.UTC(2026, 8, 30, 14, 5));
  assert.ok(Number.isNaN(keyTime('nope')));
  assert.equal(hourPrefix(Date.UTC(2026, 8, 30, 14, 5)), 'GLM-L2-LCFA/2026/273/14/');
  assert.equal(hourPrefix(Date.UTC(2026, 0, 1, 0, 30)), 'GLM-L2-LCFA/2026/001/00/');
  assert.deepEqual(parseListing('<ListBucketResult><Contents><Key>a/b.nc</Key><Size>1</Size></Contents><Contents><Key>a/c.nc</Key></Contents></ListBucketResult>'), ['a/b.nc', 'a/c.nc']);
  assert.equal(Math.round(milesBetween(30.404, -82.9395, north(8).lat, north(8).lon) * 10) / 10, 8);
});

test('the reader undoes the packing: J2000 seconds plus a scaled int16 offset, float32 coordinates', async () => {
  const t0 = Date.UTC(2026, 8, 30, 14, 5);
  const flashes = await readFlashes(lcfa(t0, [{ ...north(3), offsetS: 2 }, { ...north(20), offsetS: 19.5 }]));
  assert.equal(flashes.length, 2);
  assert.ok(Math.abs(flashes[0].t - (t0 + 2000)) <= 100, `offset 2 s: ${flashes[0].t - t0}`);
  assert.ok(Math.abs(flashes[1].t - (t0 + 19500)) <= 100);
  assert.ok(Math.abs(flashes[0].lat - north(3).lat) < 1e-4 && Math.abs(flashes[0].lon - fest.longitude) < 1e-4);
  assert.deepEqual(await readFlashes(lcfa(t0, [])), [], 'a quiet 20 seconds is an empty file');
});

test('the grade: red within 8 miles for 30 minutes after the last flash, orange to 12, yellow to 20, green beyond, none without fresh data', () => {
  const now = Date.UTC(2026, 8, 30, 14, 10), fresh = now - MIN;
  const at = (mi, agoMin) => ({ ...north(mi), t: now - agoMin * MIN });
  assert.equal(assess(fest, [], now, null).code, 'none', 'no data yet');
  assert.equal(assess(fest, [], now, now - 6 * MIN).code, 'none', 'data older than five minutes cannot say green');
  assert.equal(assess(fest, [], now, fresh).code, 'green');
  assert.equal(assess(fest, [at(25, 2)], now, fresh).code, 'green', 'twenty-five miles out is not ours');
  assert.equal(assess(fest, [at(17, 2)], now, fresh).code, 'yellow');
  const orange = assess(fest, [at(10, 4)], now, fresh);
  assert.equal(orange.code, 'orange'); assert.equal(orange.orangeUntil, new Date(now - 4 * MIN + 15 * MIN).toISOString().replace('.000Z', 'Z'), 'orange runs fifteen minutes past the last flash within 12 miles');
  assert.equal(assess(fest, [at(10, 16)], now, fresh).code, 'green', 'sixteen minutes ago is no longer recent');
  const red = assess(fest, [at(3, 2), at(10, 1), at(17, 5)], now, fresh);
  assert.equal(red.code, 'red'); assert.equal(red.nearestMi, 3); assert.deepEqual(red.within, { 8: 1, 12: 2, 20: 3 }); assert.equal(red.orangeUntil, null);
  assert.equal(red.allClearAt, new Date(now - 2 * MIN + ALL_CLEAR_MS).toISOString().replace('.000Z', 'Z')); assert.equal(red.lastNearMi, 3);
  assert.equal(assess(fest, [at(3, 29)], now, fresh).code, 'red', 'still red 29 minutes after the last close flash');
  assert.equal(assess(fest, [at(3, 29)], now, now - 6 * MIN).code, 'red', 'and stale data does not clear a red');
  assert.equal(assess(fest, [at(3, 31)], now, fresh).code, 'green', 'clear 31 minutes after it');
  // Files five to ten minutes late hold the last code, marked held with the age of the data; ten minutes without one is no data.
  const green = assess(fest, [], now - 6 * MIN, now - 7 * MIN);
  assert.equal(green.code, 'green'); assert.equal(green.held, false); assert.equal(green.stale, false); assert.equal(green.dataAgeSeconds, 60);
  const heldGreen = assess(fest, [], now, now - 7 * MIN, null, green);
  assert.equal(heldGreen.code, 'green'); assert.equal(heldGreen.held, true); assert.equal(heldGreen.stale, true); assert.equal(heldGreen.dataAgeSeconds, 420);
  assert.equal(assess(fest, [], now, now - 11 * MIN, null, green).code, 'none', 'ten minutes without a file is no data, whatever stood');
  assert.equal(assess(fest, [], now, now - 7 * MIN, null, null).code, 'none', 'nothing stood before: nothing to hold');
  const orangeThen = assess(fest, [at(10, 8)], now - 6 * MIN, now - 7 * MIN), heldOrange = assess(fest, [at(10, 8)], now, now - 7 * MIN, null, orangeThen);
  assert.equal(orangeThen.code, 'orange'); assert.equal(heldOrange.code, 'orange'); assert.equal(heldOrange.held, true); assert.equal(heldOrange.orangeUntil, orangeThen.orangeUntil, 'a held orange keeps its end');
  // A red at its all-clear with late files holds, and says the all-clear is waiting for data; ten minutes more and it is no data.
  const waiting = assess(fest, [at(3, 31)], now, now - 6 * MIN);
  assert.equal(waiting.code, 'red'); assert.equal(waiting.allClearHeld, true); assert.equal(waiting.allClearAt, new Date(now - 31 * MIN + ALL_CLEAR_MS + 10 * MIN).toISOString().replace('.000Z', 'Z'));
  assert.equal(assess(fest, [at(3, 29)], now, now - 6 * MIN).allClearHeld, false, 'before the all-clear nothing waits');
  assert.equal(assess(fest, [at(3, 41)], now, now - 6 * MIN).code, 'none', 'held as long as it can be, then no data, never a green nobody confirmed');
});

test('a pass: list both satellites, read the new files, grade, push each change to orange or red once, move the ends out, clear, survive a restart', async () => {
  resetLightning();
  q.upsertFestival({ ...fest, county: '', isPartner: false, feeds: [], site: [], status: 'published' });
  const sub = { endpoint: 'https://push.example.test/bolt', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } };
  q.upsertWebSubscription(sub.endpoint, fest.id, sub, null);
  const sent = []; setWebPushTransport(async (s, payload, opts) => { sent.push({ endpoint: s.endpoint, payload: JSON.parse(payload), opts }); });
  const now = Date.UTC(2026, 8, 30, 14, 10);
  const files = new Map(); const calls = [];
  const listing = keys => `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
  const fetchImpl = async url => {
    url = String(url); calls.push(url);
    const u = new URL(url);
    if (u.hostname === 'noaa-goes18.s3.amazonaws.com' && u.searchParams.get('prefix')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 });
    if (u.searchParams.get('prefix')) { const p = u.searchParams.get('prefix'); return new Response(listing([...files.keys()].filter(k => k.startsWith(p)))); }
    const k = u.pathname.slice(1); return files.has(k) ? new Response(files.get(k)) : new Response('no', { status: 404 });
  };
  // Two minutes ago a flash 3 miles out and one 35 miles out (kept: in reach, past the rings), ten minutes ago one 18 miles out; an hour ago one that must not be fetched at all.
  files.set(key('G19', now - 2 * MIN), lcfa(now - 2 * MIN, [north(3), north(35)]));
  files.set(key('G19', now - 10 * MIN), lcfa(now - 10 * MIN, [north(18)]));
  files.set(key('G19', now - 60 * MIN), lcfa(now - 60 * MIN, [north(1)]));
  const r1 = await lightningTick({ now, fetchImpl, festivals: [fest] });
  assert.deepEqual(r1, { files: 2, wanted: 2, flashes: 3 });
  assert.ok(!calls.some(u => u.includes(key('G19', now - 60 * MIN))), 'an hour-old file is not fetched');
  const a = lightningFor(fest.id);
  assert.equal(a.code, 'red'); assert.equal(a.nearestMi, 3); assert.deepEqual(a.within, { 8: 1, 12: 1, 20: 2 }); assert.equal(a.dataAt, new Date(now - 2 * MIN).toISOString().replace('.000Z', 'Z'));
  const st = lightningStatus();
  assert.equal(st.files, 2); assert.equal(st.buckets[0].bucket, 'noaa-goes19'); assert.equal(st.buckets[0].lastError, null);
  assert.match(st.buckets[1].lastError, /HTTP 403/, 'one satellite failing is reported, and does not stop the other');
  const alerts = q.activeAlerts(fest.id, now).filter(x => x.channel === 'lightning');
  assert.equal(alerts.length, 1); assert.equal(alerts[0].event, 'Code Red: lightning within 8 miles'); assert.equal(alerts[0].severity, 'severe'); assert.equal(alerts[0].expiresAt, a.allClearAt); assert.equal(alerts[0].code, 'red');
  assert.match(alerts[0].headline, /^Lightning 3 mi away at \d+:\d\d [AP]M\. Rapid evacuation required\. Full work stoppage\.$/);
  assert.match(alerts[0].body, /^Lightning has been detected in less than an 8 mile radius\. Rapid evacuation required\. Non-essential personnel should prioritize exit and do not need to maintain posts\. Full work stoppage\. Shelter is a hard-topped vehicle/);
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.title, 'Code Red: lightning within 8 miles'); assert.equal(sent[0].opts.urgency, 'high');
  assert.match(sent[0].payload.body, /^Bolt Test Fest\. Lightning 3 mi away at .*Full work stoppage\.$/);
  // A minute on, nothing new: still red, no second push. A new flash within 8 miles moves the all-clear out on the same alert.
  await lightningTick({ now: now + MIN, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'red'); assert.equal(sent.length, 1);
  files.set(key('G19', now + 4 * MIN), lcfa(now + 4 * MIN, [north(6)]));
  await lightningTick({ now: now + 5 * MIN, fetchImpl, festivals: [fest] });
  const later = lightningFor(fest.id);
  assert.equal(later.allClearAt, new Date(now + 4 * MIN + ALL_CLEAR_MS).toISOString().replace('.000Z', 'Z'));
  assert.equal(q.alert(fest.id, alerts[0].id).expiresAt, later.allClearAt, 'the alert ends with the new all-clear'); assert.equal(sent.length, 1);
  // Thirty-one minutes after that flash, with a fresh quiet file: green, and the alert has run out on its own.
  const t2 = now + 4 * MIN + ALL_CLEAR_MS + MIN;
  files.set(key('G19', t2 - MIN), lcfa(t2 - MIN, []));
  await lightningTick({ now: t2, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'green');
  assert.ok(Date.parse(q.alert(fest.id, alerts[0].id).expiresAt) < t2);
  // The lift goes out quietly under the red's own tag, in the protocol's words, so the phone's loud notification becomes the all-clear.
  assert.equal(sent.length, 2); assert.equal(sent[1].payload.title, 'All clear: Code Red lifted'); assert.equal(sent[1].payload.tag, alerts[0].id); assert.equal(sent[1].payload.ended, true); assert.equal(sent[1].opts.urgency, 'normal');
  assert.equal(sent[1].payload.body, 'Bolt Test Fest. Thirty minutes since the last flash within 8 miles. Now Code Green: No lightning within 20 miles in the last 15 minutes.');
  // A flash 10 miles out: orange, pushed once (a normal push, not an urgent one), ending fifteen minutes after that flash.
  files.set(key('G19', t2 + 2 * MIN), lcfa(t2 + 2 * MIN, [north(10)]));
  await lightningTick({ now: t2 + 3 * MIN, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'orange'); assert.equal(sent.length, 3);
  assert.equal(sent[2].payload.title, 'Code Orange: lightning within 12 miles'); assert.equal(sent[2].opts.urgency, 'normal');
  assert.match(sent[2].payload.body, /^Bolt Test Fest\. Lightning 10 mi away at .*Execute evacuation procedures\. Staff hold posts to assist attendees\.$/);
  const orange = q.activeAlerts(fest.id, t2 + 3 * MIN).filter(x => x.channel === 'lightning');
  assert.equal(orange.length, 1); assert.equal(orange[0].code, 'orange'); assert.equal(orange[0].severity, 'moderate'); assert.equal(orange[0].expiresAt, new Date(t2 + 17 * MIN).toISOString().replace('.000Z', 'Z'));
  await lightningTick({ now: t2 + 4 * MIN, fetchImpl, festivals: [fest] });
  assert.equal(sent.length, 3, 'still orange: no second push');
  // Then one 5 miles out: red, pushed, and the orange alert ends now, superseded.
  files.set(key('G19', t2 + 5 * MIN), lcfa(t2 + 5 * MIN, [north(5)]));
  await lightningTick({ now: t2 + 6 * MIN, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'red'); assert.equal(sent.length, 4); assert.equal(sent[3].payload.title, 'Code Red: lightning within 8 miles', 'orange to red is the red push, not a lift');
  const live = q.activeAlerts(fest.id, t2 + 6 * MIN).filter(x => x.channel === 'lightning');
  assert.equal(live.length, 1); assert.equal(live[0].code, 'red'); assert.ok(Date.parse(q.alert(fest.id, orange[0].id).expiresAt) <= t2 + 6 * MIN, 'the orange alert is ended, not left beside the red');
  // A restart mid-red: before a single file is read again, the red alert already in the database keeps the grade red, with its own
  // all-clear, so the phone's tile and its sky card never disagree; then the files are read again, the alert is adopted, nobody is pushed twice.
  resetLightning();
  await lightningTick({ now: t2 + 7 * MIN, fetchImpl, festivals: [fest], maxFiles: 0 });
  assert.equal(lightningFor(fest.id).code, 'red', 'an empty buffer does not clear a red that is still out');
  assert.equal(lightningFor(fest.id).allClearAt, q.alert(fest.id, live[0].id).expiresAt, 'its all-clear is the alert\'s'); assert.equal(lightningFor(fest.id).lastNearMi, 5);
  await lightningTick({ now: t2 + 7 * MIN, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'red'); assert.equal(sent.length, 4);
  assert.equal(q.activeAlerts(fest.id, t2 + 7 * MIN).filter(x => x.channel === 'lightning').length, 1);
  // Past that all-clear with a quiet file: green, and the alert is over; a restart then carries nothing.
  const t3 = t2 + 5 * MIN + ALL_CLEAR_MS + MIN;
  files.set(key('G19', t3 - MIN), lcfa(t3 - MIN, []));
  await lightningTick({ now: t3, fetchImpl, festivals: [fest] });
  assert.equal(lightningFor(fest.id).code, 'green'); assert.ok(Date.parse(q.alert(fest.id, live[0].id).expiresAt) <= t3);
  assert.equal(sent.length, 5); assert.equal(sent[4].payload.title, 'All clear: Code Red lifted'); assert.equal(sent[4].payload.tag, live[0].id);
  resetLightning();
  await lightningTick({ now: t3 + MIN, fetchImpl, festivals: [fest], maxFiles: 0 });
  assert.equal(lightningFor(fest.id).code, 'none', 'nothing read yet and nothing standing: no data, not a guess');
  // Nothing on: nothing kept, nothing graded.
  assert.deepEqual(await lightningTick({ now: t2 + 8 * MIN, fetchImpl, festivals: [] }), { skipped: 'nothing is on' });
  assert.equal(lightningFor(fest.id), null);
  q.deleteFestival(fest.id);
});

test('the flashes behind a code are there for a map: within twenty miles, newest first, with distance and age', async () => {
  resetLightning();
  const now = Date.UTC(2026, 8, 30, 15, 10);
  const files = new Map([[key('G19', now - 2 * MIN), lcfa(now - 2 * MIN, [north(3), north(15), north(30)])]]);
  const listing = keys => `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
  const fetchImpl = async url => { const u = new URL(String(url)); if (u.hostname.startsWith('noaa-goes18')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }); if (u.searchParams.get('prefix')) return new Response(listing([...files.keys()].filter(k => k.startsWith(u.searchParams.get('prefix'))))); const k = u.pathname.slice(1); return files.has(k) ? new Response(files.get(k)) : new Response('no', { status: 404 }); };
  await lightningTick({ now, fetchImpl, festivals: [fest] });
  const fl = flashesFor(fest, now);
  assert.deepEqual(fl.map(x => x.mi), [3, 15], 'three and fifteen miles out; the one thirty miles out is past the yellow ring');
  assert.ok(fl.every(x => x.ageSeconds >= 110 && x.ageSeconds <= 130 && Number.isFinite(x.latitude) && Number.isFinite(x.longitude) && /^\d{4}-/.test(x.at)), JSON.stringify(fl));
});

test('an indoor event gets no code and no alert, whatever the sky does: the building is the shelter', async () => {
  resetLightning();
  const club = { ...fest, id: 'club-test', name: 'Club Test', location: 'Playa Azul Nightclub, Temple, TX' };
  q.upsertFestival({ ...club, county: '', isPartner: false, feeds: [], site: [], status: 'published' });
  const sent = []; setWebPushTransport(async (s, payload) => { sent.push(JSON.parse(payload)); });
  const now = Date.UTC(2026, 8, 30, 15, 10);
  const files = new Map([[key('G19', now - 2 * MIN), lcfa(now - 2 * MIN, [north(3)])]]);
  const listing = keys => `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
  const fetchImpl = async url => { const u = new URL(String(url)); if (u.searchParams.get('prefix')) return new Response(listing([...files.keys()].filter(k => k.startsWith(u.searchParams.get('prefix'))))); const k = u.pathname.slice(1); return files.has(k) ? new Response(files.get(k)) : new Response('no', { status: 404 }); };
  await lightningTick({ now, fetchImpl, festivals: [club] });
  const a = lightningFor(club.id);
  assert.equal(a.code, 'indoor'); assert.equal(a.indoor, true);
  assert.equal(q.activeAlerts(club.id, now).filter(x => x.channel === 'lightning').length, 0, 'a flash 3 miles out is no code red for a nightclub'); assert.equal(sent.length, 0);
  // Staff say it is outdoors after all: the same flash is a red, with its alert.
  q.upsertFestival({ ...q.festival(club.id), ground: { override: { indoor: false } } });
  await lightningTick({ now: now + MIN, fetchImpl, festivals: [q.festival(club.id)] });
  assert.equal(lightningFor(club.id).code, 'red'); assert.equal(q.activeAlerts(club.id, now + MIN).filter(x => x.channel === 'lightning').length, 1);
});

test('where the lightning is going: two centers ten minutes apart give a heading, a speed, closing or not, and the minutes to here', () => {
  const now = Date.UTC(2026, 8, 30, 14, 10), MI_LAT = 1 / 69.172;
  // A cell 30 miles northeast fifteen minutes ago, 20 miles northeast five minutes ago: moving southwest at about 60 mph, closing, here in twenty minutes.
  const cell = (mi, agoMin, n = 4) => Array.from({ length: n }, (_, i) => ({ lat: fest.latitude + (mi / Math.SQRT2) * MI_LAT + i * 0.002, lon: fest.longitude + (mi / Math.SQRT2) * MI_LAT / Math.cos(fest.latitude * Math.PI / 180), t: now - agoMin * MIN }));
  const m = motionOf(fest, [...cell(30, 15), ...cell(20, 5)], now);
  assert.equal(m.heading, 'SW'); assert.ok(m.speedMph >= 55 && m.speedMph <= 65, `${m.speedMph} mph`); assert.equal(m.closing, true);
  assert.ok(m.arrivalMinutes >= 18 && m.arrivalMinutes <= 22, `${m.arrivalMinutes} min`); assert.ok(Math.abs(m.distanceMi - 20) < 0.5, `${m.distanceMi} mi`); assert.equal(m.flashes, 8);
  const away = motionOf(fest, [...cell(20, 15), ...cell(30, 5)], now);
  assert.equal(away.heading, 'NE'); assert.equal(away.closing, false); assert.equal(away.arrivalMinutes, null); assert.ok(away.awayMph >= 55);
  assert.equal(motionOf(fest, [...cell(30, 15, 2), ...cell(20, 5, 4)], now), null, 'two flashes are not a center');
  assert.equal(motionOf(fest, cell(20, 5, 8), now), null, 'one half only: no motion yet');
  assert.ok(assess(fest, [...cell(30, 15), ...cell(20, 5)], now, now - MIN).motion.closing, 'the grade carries it');
  assert.equal(assess(fest, [], now, now - MIN).motion, null);
});

test('a spot, festival or not: asked about, it is in the reader\'s reach for a day and graded after a warm-up, with no alert and no push', async () => {
  resetLightning();
  const now = Date.UTC(2026, 8, 30, 15, 0), spot = { latitude: 35.2, longitude: -80.8 };   // Charlotte: no festival anywhere near
  const first = lightningAt(spot, now);
  assert.equal(first.code, 'none'); assert.equal(first.warming, true); assert.equal(first.readyAt, new Date(now + 15 * MIN).toISOString().replace('.000Z', 'Z')); assert.equal(first.point, true);
  assert.equal(pointsOfInterest(now).length, 1);
  const files = new Map(); const listing = keys => `<ListBucketResult>${keys.map(k => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`;
  const fetchImpl = async url => { const u = new URL(String(url)); if (u.hostname === 'noaa-goes18.s3.amazonaws.com' && u.searchParams.get('prefix')) return new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 }); if (u.searchParams.get('prefix')) { const p = u.searchParams.get('prefix'); return new Response(listing([...files.keys()].filter(k => k.startsWith(p)))); } const k = u.pathname.slice(1); return files.has(k) ? new Response(files.get(k)) : new Response('no', { status: 404 }); };
  const nearSpot = mi => ({ lat: spot.latitude + mi / 69.172, lon: spot.longitude });
  files.set(key('G19', now - 2 * MIN), lcfa(now - 2 * MIN, [nearSpot(10), north(3)]));   // one ten miles from the spot, one three miles from the festival nobody is at
  const r = await lightningTick({ now, fetchImpl, festivals: [] });
  assert.deepEqual(r, { files: 1, wanted: 1, flashes: 1 }, 'nothing on, but a spot asked: the reader runs and keeps the flash near the spot, not the other');
  assert.equal(lightningAt(spot, now + 5 * MIN).code, 'none', 'still warming up');
  files.set(key('G19', now + 14 * MIN), lcfa(now + 14 * MIN, [nearSpot(10)]));
  await lightningTick({ now: now + 15 * MIN, fetchImpl, festivals: [] });
  assert.equal(lightningAt(spot, now + 16 * MIN).code, 'orange', 'after the warm-up, the grade for the spot');
  assert.equal(lightningAt(spot, now + 16 * MIN).nearestMi, 10);
  assert.equal(q.activeAlerts('here', now).length, 0, 'no alert stored for a spot');
  assert.equal(pointsOfInterest(now + 25 * 3_600_000).length, 0, 'a day later, forgotten');
  assert.deepEqual(await lightningTick({ now: now + 25 * 3_600_000, fetchImpl, festivals: [] }), { skipped: 'nothing is on' });
  resetLightning();
});
