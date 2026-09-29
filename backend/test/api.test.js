import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alertFeature, points, hourly } from './fixtures/nws.js';

// Everything below must be set before the app is imported: db.js opens DB_PATH at import time.
const audioDir = mkdtempSync(join(tmpdir(), 'fieldwatch-audio-'));
process.env.DB_PATH = ':memory:';
process.env.RADAR_FETCH_PAUSE_MS = '0';
process.env.AUDIO_DIR = audioDir;
process.env.RADAR_DIR = mkdtempSync(join(tmpdir(), 'fieldwatch-radar-'));
process.env.ADMIN_KEY = 'test-admin';
process.env.NODE_KEY = 'test-node';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
delete process.env.OPENAI_API_KEY;
delete process.env.APNS_KEY_PATH;
const { default: webpushLib } = await import('web-push');
const vapid = webpushLib.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = vapid.publicKey;
process.env.VAPID_PRIVATE_KEY = vapid.privateKey;

// Node's own fetch, kept for talking to our server; the global one becomes the NWS fake below.
const fetchReal = globalThis.fetch;

// Fake api.weather.gov. `nwsState.features` is what /alerts/active returns right now.
const nwsState = { features: [alertFeature()], calls: [] };
const jsonResponse = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/geo+json' } });
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  nwsState.calls.push(url);
  assert.equal(opts.headers?.['User-Agent'], process.env.NWS_USER_AGENT, 'every NWS call carries our User-Agent');
  if (url.includes('/alerts/active')) return jsonResponse({ type: 'FeatureCollection', features: nwsState.features });
  if (url.includes('/points/')) return jsonResponse(points);
  if (url.includes('/forecast/hourly')) return jsonResponse(hourly);
  if (url.includes('n0q-t.cgi')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
  return jsonResponse({ detail: 'not found' }, 404);
};

const { app } = await import('../src/app.js');
const { q } = await import('../src/db.js');
const { pollFestival } = await import('../src/poller.js');
const { refreshRadar, radarWanted, noteInterest } = await import('../src/radar.js');
const { setWebPushTransport } = await import('../src/webpush.js');
setWebPushTransport(async () => {});
const { isLive } = await import('../src/festivals.js');

const festivals = JSON.parse(readFileSync(new URL('../data/festivals.json', import.meta.url), 'utf8'));
for (const f of festivals) q.upsertFestival(f);
const FEST = 'hulaween-2026';

let server, base;
before(async () => {
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const api = async (method, path, { body, headers = {}, form } = {}) => {
  const init = { method, headers: { ...headers } };
  if (form) init.body = form;
  else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['content-type'] = 'application/json'; }
  const res = await fetchReal(`${base}${path}`, init);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
};
const admin = { 'x-admin-key': 'test-admin' };
const node = { 'x-node-key': 'test-node' };

test('health and festival list', async () => {
  assert.equal((await api('GET', '/health')).json.ok, true);
  const list = (await api('GET', '/festivals')).json;
  assert.deepEqual(list.map(f => f.id), festivals.filter(f => isLive(f)).map(f => f.id), 'the list is what is on right now');
  assert.equal((await api('GET', '/festivals?all=1')).json.length, festivals.length);
  assert.ok((await api('GET', '/festivals?all=1')).json.some(f => f.id === FEST));
  assert.equal((await api('GET', '/festivals/nope')).status, 404);
  assert.equal((await api('GET', `/festivals/${FEST}`)).json.name, 'Suwannee Hulaween');
});

test('pack carries festival, normalized NWS alerts, forecast, posts and incidents', async () => {
  const { status, json: pack } = await api('GET', `/festivals/${FEST}/pack`);
  assert.equal(status, 200);
  assert.equal(pack.festival.id, FEST);
  assert.equal(pack.alerts.length, 1);
  const a = pack.alerts[0];
  assert.equal(a.id, 'urn:oid:2.49.0.1.840.0.aaa');
  assert.equal(a.severity, 'severe', 'NWS severity is lowercased to match the Swift enum');
  assert.equal(a.channel, 'weather');
  assert.equal(a.relayCount, 0);
  assert.equal(a.expiresAt, '2026-10-23T15:00:00-04:00', 'ends wins over expires');
  assert.equal(a.source, 'NWS Jacksonville FL');
  assert.equal(pack.hourly.length, 36, 'the pack keeps 36 hours, not everything NWS sends');
  assert.deepEqual(Object.keys(pack.hourly[0]).sort(), ['precipChance', 'shortForecast', 'startTime', 'temperature', 'windSpeed']);
  assert.equal(pack.hourly[0].precipChance, null);
  assert.equal(pack.hourly[1].precipChance, 40);
  assert.deepEqual(pack.posts, []);
  assert.deepEqual(pack.incidents, []);
  assert.equal(pack.radar.festivalId, FEST);
  assert.ok(Array.isArray(pack.radar.frames));
  assert.match(pack.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'no fractional seconds');
});

test('an alert NWS stops listing is ended, and one with ends:null falls back to expires', async () => {
  const f = q.festival(FEST);
  nwsState.features = [alertFeature({ id: 'urn:oid:2.49.0.1.840.0.bbb', ends: null, event: 'Flood Advisory', severity: 'Minor' })];
  await pollFestival(f);
  const alerts = (await api('GET', `/festivals/${FEST}/alerts`)).json;
  assert.deepEqual(alerts.map(a => a.id), ['urn:oid:2.49.0.1.840.0.bbb']);
  assert.equal(alerts[0].expiresAt, '2026-10-23T15:00:00-04:00');
  assert.equal(alerts[0].severity, 'minor');
  const ended = q.alert('urn:oid:2.49.0.1.840.0.aaa');
  assert.ok(ended.expiresAt && Date.parse(ended.expiresAt) <= Date.now(), 'vanished alert got an expiresAt of now');
});

test('staff posts need the admin key and a known severity', async () => {
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'x', body: 'y' } })).status, 401);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'x', body: 'y' }, headers: { 'x-admin-key': 'wrong' } })).status, 401);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'x' }, headers: admin })).status, 400);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'x', body: 'y', severity: 'loud' }, headers: admin })).status, 400);
  const created = await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'Medical tent has moved', body: 'Now beside the water station at the east gate.' }, headers: admin });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.push, { sent: 0, skipped: true }, 'no APNs configured, no push, no crash');
  const posts = (await api('GET', `/festivals/${FEST}/posts`)).json;
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Medical tent has moved');
  assert.equal(typeof posts[0].id, 'string', 'ids are strings for the Swift model');
  assert.match(posts[0].postedAt, /Z$/);
});

const wav = () => new Blob([Buffer.alloc(64, 1)], { type: 'audio/wav' });
const uploadCall = (fields, { withAudio = true } = {}) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (withAudio) form.append('audio', wav(), 'call.wav');
  return form;
};

test('node uploads: hazard traffic is stored and published, gossip is dropped with its audio', async () => {
  assert.equal((await api('POST', `/festivals/${FEST}/incidents`, { form: uploadCall({ transcript: 'hi' }) })).status, 401);

  const gossip = await api('POST', `/festivals/${FEST}/incidents`, { headers: node, form: uploadCall({ transcript: 'Engine 4 returning to quarters', talkgroup: 'Fire Dispatch' }) });
  assert.equal(gossip.status, 200);
  assert.deepEqual(gossip.json, { stored: false, reason: 'not safety-relevant' });
  assert.equal(readdirSync(audioDir).length, 0, 'dropped audio is deleted');

  const id = 'inc-11111111-2222-4333-8444-555555555555';
  const kept = await api('POST', `/festivals/${FEST}/incidents`, {
    headers: node,
    form: uploadCall({ id, transcript: 'Weather hold on the main stage, lightning within eight miles. Caller 352-555-0142.', talkgroup: 'SO Dispatch', occurredAt: '2026-10-23T18:05:00Z' }),
  });
  assert.equal(kept.status, 201, JSON.stringify(kept.json));
  assert.equal(kept.json.id, id, 'the node id is kept so phones on the node Wi-Fi do not see a duplicate');
  assert.equal(kept.json.category, 'weather');
  assert.equal(kept.json.level, 'warning');
  assert.equal(kept.json.published, true);

  const list = (await api('GET', `/festivals/${FEST}/incidents`)).json;
  assert.equal(list.length, 1);
  const i = list[0];
  assert.equal(i.id, id);
  assert.equal(i.source, 'scanner');
  assert.equal(i.occurredAt, '2026-10-23T18:05:00Z');
  assert.ok(!i.transcript.includes('352-555-0142'), 'phone number redacted before storage');
  assert.match(i.audioURL, /^\/audio\/\d+-[0-9a-f]{8}\.wav$/);
  const clip = await api('GET', i.audioURL);
  assert.equal(clip.status, 200);
  assert.equal(readdirSync(audioDir).length, 1);

  const dup = await api('POST', `/festivals/${FEST}/incidents`, { headers: node, form: uploadCall({ id, transcript: 'Weather hold on the main stage' }) });
  assert.deepEqual(dup.json, { stored: true, id, duplicate: true });
  assert.equal(readdirSync(audioDir).length, 1, 'a duplicate upload does not leave a second file behind');

  const badDate = await api('POST', `/festivals/${FEST}/incidents`, { headers: node, form: uploadCall({ transcript: 'Evacuate the campground now', occurredAt: 'yesterday-ish' }, { withAudio: false }) });
  assert.equal(badDate.status, 201);
  const stored = q.incident(badDate.json.id);
  assert.match(stored.occurredAt, /Z$/, 'unparseable occurredAt falls back to now instead of poisoning the phone decoder');
  assert.equal(stored.audioURL, null);

  const pack = (await api('GET', `/festivals/${FEST}/pack`)).json;
  assert.equal(pack.incidents.length, 2, 'the pack carries published incidents');
});

test('attendee reports queue for moderation, publish with an edited summary, and are rate limited', async () => {
  assert.equal((await api('POST', `/festivals/${FEST}/reports`, { body: { summary: 'short' } })).status, 400);
  const rep = await api('POST', `/festivals/${FEST}/reports`, { body: { summary: 'Flooded path behind Stage 2, knee deep water', location: 'Stage 2' } });
  assert.equal(rep.status, 202, JSON.stringify(rep.json));
  assert.equal(rep.json.queued, true);
  assert.match(rep.json.id, /^rep-/);

  const publicList = (await api('GET', `/festivals/${FEST}/incidents`)).json;
  assert.ok(!publicList.some(i => i.id === rep.json.id), 'attendee reports are never auto-published');

  assert.equal((await api('GET', `/festivals/${FEST}/incidents/pending`)).status, 401);
  const pending = (await api('GET', `/festivals/${FEST}/incidents/pending`, { headers: admin })).json;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].category, 'flood');
  assert.equal(pending[0].source, 'attendee');

  const pub = await api('POST', `/festivals/${FEST}/incidents/${rep.json.id}/publish`, { headers: admin, body: { summary: 'Flooding behind Stage 2, avoid the path' } });
  assert.equal(pub.status, 200, JSON.stringify(pub.json));
  const after = (await api('GET', `/festivals/${FEST}/incidents`)).json.find(i => i.id === rep.json.id);
  assert.equal(after.summary, 'Flooding behind Stage 2, avoid the path');
  assert.equal(after.location, 'Stage 2');

  assert.equal((await api('POST', `/festivals/${FEST}/incidents/rep-nope/publish`, { headers: admin })).status, 404);
  assert.equal((await api('DELETE', `/festivals/${FEST}/incidents/${rep.json.id}`, { headers: admin })).json.ok, true);
  assert.ok(!(await api('GET', `/festivals/${FEST}/incidents`)).json.some(i => i.id === rep.json.id));

  // Every attempt counts, including the rejected 'short' one above: 5 per 10 minutes per IP.
  for (let n = 0; n < 3; n++) assert.equal((await api('POST', `/festivals/${FEST}/reports`, { body: { summary: `Report number ${n} about something` } })).status, 202);
  assert.equal((await api('POST', `/festivals/${FEST}/reports`, { body: { summary: 'One report too many here' } })).status, 429);
});

test('anyone can suggest a festival; it is hidden until an admin approves it, and the admin can remove it', async () => {
  assert.equal((await api('POST', '/festivals', { body: {} })).json.error, 'name required');
  const sent = await api('POST', '/festivals', { body: { name: 'Moon Hollow Gathering', location: 'Live Oak, FL', latitude: '30.3', longitude: '-82.9', startDate: '2026-11-06', endDate: '2026-11-08',
    website: 'moonhollow.org', isPartner: true, feeds: [{ id: 'x' }], site: [{}], featured: true, note: 'Small one, 300 people, second year' } });
  assert.equal(sent.status, 202); assert.match(sent.json.id, /^sub-moon-hollow-gathering-[0-9a-f]{6}$/); assert.equal(sent.json.pending, true);
  const id = sent.json.id;
  assert.ok(!(await api('GET', '/festivals?all=1')).json.some(f => f.id === id), 'not public yet');
  assert.equal((await api('GET', `/festivals/${id}`)).status, 404, 'nor by id');
  assert.equal((await api('GET', `/festivals/${id}/pack`)).status, 404);
  assert.equal((await api('GET', `/festivals/${id}`, { headers: admin })).status, 200, 'an admin sees it');
  assert.equal((await api('GET', '/festivals/pending')).status, 401);
  const pending = (await api('GET', '/festivals/pending', { headers: admin })).json;
  assert.equal(pending.length, 1);
  const p = pending[0];
  assert.equal(p.status, 'pending'); assert.equal(p.origin, 'community'); assert.equal(p.featured, false);
  assert.equal(p.isPartner, false); assert.deepEqual(p.feeds, []); assert.deepEqual(p.site, []);
  assert.equal(p.website, 'https://moonhollow.org/'); assert.equal(p.note, 'Small one, 300 people, second year');
  assert.equal(p.startDate, '2026-11-06T12:00:00Z'); assert.equal(p.endDate, '2026-11-09T08:00:00Z', 'a bare last day lasts through the night');
  assert.ok(p.submittedAt);

  assert.equal((await api('POST', `/festivals/${id}/approve`)).status, 401);
  assert.equal((await api('POST', '/festivals/sub-nope/approve', { headers: admin })).status, 404);
  const ok = await api('POST', `/festivals/${id}/approve`, { headers: admin, body: { county: 'Suwannee County' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.status, 'published'); assert.equal(ok.json.county, 'Suwannee County'); assert.equal(ok.json.name, 'Moon Hollow Gathering');
  assert.ok((await api('GET', '/festivals?all=1')).json.some(f => f.id === id), 'public once approved (and listed once it is on)');
  assert.deepEqual((await api('GET', '/festivals/pending', { headers: admin })).json, []);
  assert.equal((await api('GET', `/festivals/${id}/alerts`)).status, 200);

  assert.equal((await api('DELETE', `/festivals/${id}`)).status, 401);
  assert.equal((await api('DELETE', `/festivals/${id}`, { headers: admin })).json.ok, true);
  assert.equal((await api('GET', `/festivals/${id}`, { headers: admin })).status, 404);

  // Three an hour from one address, valid or not.
  assert.equal((await api('POST', '/festivals', { body: { name: 'Two', location: 'L', latitude: 1, longitude: 2, startDate: '2026-12-01', endDate: '2026-12-02' } })).status, 202);
  assert.equal((await api('POST', '/festivals', { body: { name: 'Three' } })).status, 429);
});

test('the list is what is on: a week before gates for early entry and crews, through the day after; and an admin can run the imports', async () => {
  const DAY = 86_400_000, at = d => new Date(Date.now() + d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = { location: 'L', latitude: 1, longitude: 2, county: '', isPartner: false, feeds: [], site: [], status: 'published' };
  q.upsertFestival({ ...base, id: 'old-days-2026', name: 'Old Days', startDate: at(-5), endDate: at(-2) });
  q.upsertFestival({ ...base, id: 'wrap-up-2026', name: 'Wrap Up', startDate: at(-3), endDate: at(-0.5) });
  q.upsertFestival({ ...base, id: 'crew-week-2026', name: 'Crew Week', startDate: at(5), endDate: at(8) });
  q.upsertFestival({ ...base, id: 'next-month-2026', name: 'Next Month', startDate: at(20), endDate: at(23) });
  q.upsertFestival({ ...base, id: 'big-build-2026', name: 'Big Build', startDate: at(12), endDate: at(15), groundsOpen: at(-1) });
  const ids = (await api('GET', '/festivals')).json.map(f => f.id);
  assert.ok(ids.includes('wrap-up-2026'), 'the day after the end still counts: teardown');
  assert.ok(ids.includes('crew-week-2026'), 'five days out, vendors and early entry are arriving');
  assert.ok(ids.includes('big-build-2026'), 'a festival that says when its grounds open is on from then');
  assert.ok(!ids.includes('old-days-2026') && !ids.includes('next-month-2026'));
  assert.ok((await api('GET', '/festivals?all=1')).json.some(f => f.id === 'next-month-2026'));
  assert.equal((await api('GET', '/festivals/next-month-2026')).status, 200, 'by id it is there, for a phone that saved it');
  // Frames are fetched ahead for featured festivals and for any a phone asked about in the last day.
  assert.equal(radarWanted({ id: 'crew-week-2026', featured: false }), false);
  assert.equal(radarWanted({ id: 'x', featured: true }), true);
  await api('GET', '/festivals/crew-week-2026/radar');
  assert.equal(radarWanted({ id: 'crew-week-2026', featured: false }), true);
  assert.equal(radarWanted({ id: 'crew-week-2026', featured: false }, Date.now() + 25 * 3_600_000), false);
  for (const id of ['old-days-2026', 'wrap-up-2026', 'crew-week-2026', 'next-month-2026', 'big-build-2026']) q.deleteFestival(id);

  assert.equal((await api('POST', '/admin/import')).status, 401);
  const r = (await api('POST', '/admin/import', { headers: admin })).json;
  assert.equal(r.ticketmaster.skipped, 'TICKETMASTER_KEY not set');
  assert.equal(r.seatgeek.skipped, 'SEATGEEK_CLIENT_ID not set');
  assert.equal(r.edmtrain.skipped, 'EDMTRAIN_KEY not set');
  assert.equal(r.feeds.skipped, 'FESTIVAL_FEEDS not set');

  // PUT still adds or edits a festival outright, through the same validator.
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { headers: admin, body: { name: 'Dusk Ridge' } })).json.error, 'location required');
  const put = await api('PUT', '/festivals/dusk-ridge-2026', { headers: admin, body: { name: 'Dusk Ridge', location: 'Somewhere, CO', latitude: 39.5, longitude: -105.1, county: 'Park County', startDate: '2026-10-09T18:00:00Z', endDate: '2026-10-12T06:00:00Z' } });
  assert.equal(put.status, 200); assert.equal(put.json.id, 'dusk-ridge-2026'); assert.equal(put.json.origin, 'curated'); assert.equal(put.json.featured, true); assert.deepEqual(put.json.feeds, []);
  const edit = await api('PUT', '/festivals/dusk-ridge-2026', { headers: admin, body: { name: 'Dusk Ridge', location: 'Somewhere, CO', latitude: 39.5, longitude: -105.1, county: 'Park County', startDate: '2026-10-09T18:00:00Z', endDate: '2026-10-12T06:00:00Z', featured: false } });
  assert.equal(edit.json.featured, false);
  q.deleteFestival('dusk-ridge-2026');
});

test('device registration validates the APNs token', async () => {
  assert.equal((await api('POST', '/devices', { body: { token: 'nope' } })).status, 400);
  const token = 'a'.repeat(64);
  assert.equal((await api('POST', '/devices', { body: { token, festivalId: FEST } })).status, 200);
  assert.deepEqual(q.tokensFor(FEST), [token]);
  assert.equal((await api('DELETE', `/devices/${token}`)).status, 200);
  assert.deepEqual(q.tokensFor(FEST), []);
});

test('festival upsert validates coordinates and dates', async () => {
  const good = { name: 'Dusk Ridge', location: 'Ridge Farm, Somewhere, OH', latitude: 40.1, longitude: -82.4, startDate: '2026-10-30T16:00:00Z', endDate: '2026-11-01T06:00:00Z', county: 'Licking County' };
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: good })).status, 401);
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: { ...good, latitude: 'north' }, headers: admin })).status, 400);
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: { ...good, latitude: '40.1' }, headers: admin })).json.latitude, 40.1, 'a number typed into a form is still a number');
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: { ...good, longitude: 200 }, headers: admin })).status, 400);
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: { ...good, endDate: 'soon' }, headers: admin })).status, 400);
  assert.equal((await api('PUT', '/festivals/dusk-ridge-2026', { body: { ...good, endDate: '2026-10-01T00:00:00Z' }, headers: admin })).status, 400);
  const put = await api('PUT', '/festivals/dusk-ridge-2026', { body: good, headers: admin });
  assert.equal(put.status, 200, JSON.stringify(put.json));
  assert.deepEqual(put.json.feeds, []);
  assert.equal(put.json.isPartner, false);
  assert.equal((await api('GET', '/festivals/dusk-ridge-2026')).json.county, 'Licking County');
});

test('radar: manifest, immutable frames, and the pack carry the loop', async () => {
  const f = q.festival(FEST);
  await refreshRadar(f);
  const { status, json: loop } = await api('GET', `/festivals/${FEST}/radar`);
  assert.equal(status, 200);
  assert.equal(loop.frames.length, 72);
  assert.equal(loop.hours, 12);
  assert.ok(loop.bounds.north > loop.bounds.south && loop.bounds.east > loop.bounds.west);
  const frame = await api('GET', loop.frames.at(-1).url);
  assert.equal(frame.status, 200);
  assert.equal(frame.headers.get('content-type'), 'image/png');
  assert.match(frame.headers.get('cache-control'), /immutable/);
  assert.equal((await api('GET', `/radar/${FEST}/nope.png`)).status, 404);
  const pack = (await api('GET', `/festivals/${FEST}/pack`)).json;
  assert.equal(pack.radar.frames.length, 72);
  assert.equal(pack.radar.frames.at(-1).url, loop.frames.at(-1).url);
});

test('a browser on another origin may call the API', async () => {
  const pre = await api('OPTIONS', `/festivals/${FEST}/reports`, { headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  assert.match(pre.headers.get('access-control-allow-headers'), /content-type/i);
  assert.match(pre.headers.get('access-control-allow-methods'), /POST/);
  const get = await api('GET', '/festivals');
  assert.equal(get.headers.get('access-control-allow-origin'), '*');
});

test('errors come back as JSON', async () => {
  const bad = await api('POST', '/devices', { body: '{not json' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'invalid JSON' });
  assert.deepEqual((await api('GET', '/nothing/here')).json, { error: 'not found' });
});

test('web push: a browser subscribes to a festival and gets warnings and staff posts, not advisories; dead endpoints are dropped', async () => {
  const sent = []; let dead = null;
  setWebPushTransport(async (sub, payload, opts) => {
    if (dead && sub.endpoint === dead) { const e = new Error('gone'); e.statusCode = 410; throw e; }
    sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts });
  });
  const sub = n => ({ endpoint: `https://push.example.test/${n}`, expirationTime: null, keys: { p256dh: `p-${n}`, auth: `a-${n}` } });
  assert.equal((await api('GET', '/push/vapid')).json.key, process.env.VAPID_PUBLIC_KEY);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: { endpoint: 'nope' } } })).status, 400);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: 'nope' } })).status, 404);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: FEST } })).json.ok, true);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('b'), festivalId: FEST } })).json.ok, true);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: FEST } })).json.ok, true, 'subscribing again is fine');

  // A new warning from NWS reaches both browsers; an advisory reaches neither.
  nwsState.features = [
    alertFeature({ id: 'urn:oid:web-1', '@id': 'https://api.weather.gov/alerts/urn:oid:web-1', event: 'Tornado Warning', severity: 'Extreme', headline: 'Tornado Warning until 3:30 PM' }),
    alertFeature({ id: 'urn:oid:web-2', '@id': 'https://api.weather.gov/alerts/urn:oid:web-2', event: 'Rip Current Statement', severity: 'Minor' }),
  ];
  await pollFestival(q.festival(FEST));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(x => x.endpoint).sort(), ['https://push.example.test/a', 'https://push.example.test/b']);
  assert.equal(sent[0].payload.title, 'Tornado Warning'); assert.equal(sent[0].payload.tag, 'urn:oid:web-1'); assert.equal(sent[0].payload.urgent, true);
  assert.match(sent[0].payload.body, /^Suwannee Hulaween\. Tornado Warning until 3:30 PM/);
  assert.equal(sent[0].payload.url, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}&alert=urn%3Aoid%3Aweb-1`);
  assert.equal(sent[0].opts.urgency, 'high');

  // A staff post reaches them too, whatever its severity.
  sent.length = 0;
  const post = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Gates closed', body: 'Lightning within 8 miles. Shelter in vehicles.' } });
  assert.deepEqual(post.json.web, { sent: 2, gone: 0, failed: 0 });
  assert.equal(sent[0].payload.title, 'Gates closed'); assert.equal(sent[0].opts.urgency, 'normal');

  // A browser that is gone (410) is dropped on the next send and never tried again.
  dead = 'https://push.example.test/b'; sent.length = 0;
  assert.deepEqual((await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Gates open', body: 'Storm passed.' } })).json.web, { sent: 1, gone: 1, failed: 0 });
  dead = null; sent.length = 0;
  assert.deepEqual((await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Water', body: 'Free water at the east gate.' } })).json.web, { sent: 1, gone: 0, failed: 0 });
  assert.equal(sent[0].endpoint, 'https://push.example.test/a');

  // Switching off.
  assert.equal((await api('DELETE', '/push/subscribe', { body: {} })).status, 400);
  assert.equal((await api('DELETE', '/push/subscribe', { body: { endpoint: 'https://push.example.test/a' } })).json.ok, true);
  assert.deepEqual((await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Bye', body: 'See you next year.' } })).json.web, { sent: 0 });
  nwsState.features = [alertFeature()];
});
