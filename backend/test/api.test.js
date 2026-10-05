import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { alertFeature, points, hourly, grid } from './fixtures/nws.js';

// Everything below must be set before the app is imported: db.js opens DB_PATH at import time.
const audioDir = mkdtempSync(join(tmpdir(), 'fieldwatch-audio-'));
process.env.DB_PATH = ':memory:';
process.env.RADAR_FETCH_PAUSE_MS = '0';
process.env.AUDIO_DIR = audioDir;
process.env.RADAR_DIR = mkdtempSync(join(tmpdir(), 'fieldwatch-radar-'));
process.env.BACKUP_DIR = mkdtempSync(join(tmpdir(), 'fieldwatch-backup-'));
process.env.ADMIN_KEY = 'test-admin';
process.env.NODE_KEY = 'test-node';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@fieldwatch.test)';
process.env.NWS_RETRY_MS = '0';
delete process.env.OPENAI_API_KEY;
delete process.env.APNS_KEY_PATH;
delete process.env.TICKETMASTER_KEY; delete process.env.SEATGEEK_CLIENT_ID; delete process.env.EDMTRAIN_KEY; delete process.env.FESTIVAL_FEEDS;
process.env.WIKIDATA_IMPORT = 'false';   // keyless and on by default; kept off here so the import route never reaches the network
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
  if (/gridpoints\/[^/]+\/[\d,]+$/.test(url)) return jsonResponse(nwsState.grid || grid);
  if (url.includes('overpass')) return jsonResponse({ elements: [{ type: 'area', id: 1, tags: { boundary: 'administrative', admin_level: '6' } }, { type: 'area', id: 2, tags: { leisure: 'park', name: 'Spirit of the Suwannee Music Park' } }] });
  if (url.includes('sdmdataaccess')) return jsonResponse({ Table: [['mukey', 'muname', 'compname', 'hydgrp', 'drainagecl', 'comppct_r'], ['1', 'Blanton fine sand, 0 to 5 percent slopes', 'Blanton', 'A', 'Somewhat excessively drained', '85']] });
  if (url.includes('n0q-t.cgi')) return new Response(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'), { status: 200, headers: { 'content-type': 'image/png' } });
  return jsonResponse({ detail: 'not found' }, 404);
};

const { app } = await import('../src/app.js');
const { q } = await import('../src/db.js');
const { adminKeyStatus, ensureAdminKey, resetAdminKey } = await import('../src/adminkey.js');
const { pollFestival, pollPoint, headsUp } = await import('../src/poller.js');
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
  assert.equal(pack.lightning, null, 'no lightning grade until the mapper has been read');
  assert.ok(pack.nowcast === null || pack.nowcast.tracked === false, 'no real radar frames in tests');
  assert.equal((await api('GET', `/festivals/${FEST}/nowcast`)).json.tracked, false);
  assert.equal(pack.ground.past, null, 'the rain analysis is out of reach in tests'); assert.match(pack.ground.pastError, /IEMRE 404/);
  const ground = (await api('GET', `/festivals/${FEST}/ground`)).json;
  assert.equal(ground.past, null); assert.match(ground.at, /^\d{4}-/);
  assert.deepEqual((await api('GET', `/festivals/${FEST}/lightning`)).json, { code: 'none', at: (await api('GET', `/festivals/${FEST}/lightning`)).json.at, on: true, source: 'GOES GLM' });
  assert.match(pack.generatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'no fractional seconds');
});

test('an alert NWS stops listing is ended, and one with ends:null falls back to expires', async () => {
  const f = q.festival(FEST);
  nwsState.features = [alertFeature({ id: 'urn:oid:2.49.0.1.840.0.bbb', ends: null, event: 'Flood Advisory', severity: 'Minor' })];
  await pollFestival(f);
  assert.ok(Date.parse(q.alert(FEST, 'urn:oid:2.49.0.1.840.0.aaa').expiresAt) > Date.now(), 'one poll without it is not an end: the service answers empty for seconds at a time');
  await pollFestival(f);
  const alerts = (await api('GET', `/festivals/${FEST}/alerts`)).json;
  assert.deepEqual(alerts.map(a => a.id), ['urn:oid:2.49.0.1.840.0.bbb']);
  assert.equal(alerts[0].expiresAt, '2026-10-23T15:00:00-04:00');
  assert.equal(alerts[0].severity, 'minor');
  const ended = q.alert(FEST, 'urn:oid:2.49.0.1.840.0.aaa');
  assert.ok(ended.expiresAt && Date.parse(ended.expiresAt) <= Date.now(), 'vanished alert got an expiresAt of now');
});

test('an update of a warning the phone already has is stored, ends the message it replaces, and is not pushed again', async () => {
  const f = q.festival(FEST);
  nwsState.features = [alertFeature({ id: 'urn:oid:2.49.0.1.840.0.ccc', ends: null, event: 'Flood Advisory', severity: 'Minor', messageType: 'Update', sent: '2026-10-23T14:30:00-04:00', effective: '2026-10-23T14:30:00-04:00',
    references: [{ '@id': 'https://api.weather.gov/alerts/urn:oid:2.49.0.1.840.0.bbb', identifier: 'urn:oid:2.49.0.1.840.0.bbb', sender: 'w-nws.webmaster@noaa.gov', sent: '2026-10-23T14:02:00-04:00' }] })];
  assert.deepEqual(await pollFestival(f), [], 'the same advisory worded again: nothing to push');
  const alerts = (await api('GET', `/festivals/${FEST}/alerts`)).json;
  assert.deepEqual(alerts.map(a => a.id), ['urn:oid:2.49.0.1.840.0.ccc'], 'the update is what the phone sees');
  assert.ok(Date.parse(q.alert(FEST, 'urn:oid:2.49.0.1.840.0.bbb').expiresAt) <= Date.now(), 'the message it replaced has ended');
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
  assert.equal((await api('POST', '/festivals', { body: { name: 'Two', location: 'L', latitude: 30.3, longitude: -82.9, startDate: '2026-12-01', endDate: '2026-12-02' } })).status, 202);
  assert.equal((await api('POST', '/festivals', { body: { name: 'Three' } })).status, 429);
});

test('the list is what is on: a week before gates for early entry and crews, through the day after; and an admin can run the imports', async () => {
  const DAY = 86_400_000, at = d => new Date(Date.now() + d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const base = { location: 'L', latitude: 39.5, longitude: -105.1, county: '', isPartner: false, feeds: [], site: [], status: 'published' };
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

  // Staff hide a listing that is not a festival; it leaves every public list, stays for the admin to unhide, and an import keeps it hidden.
  const junk = (await api('GET', '/festivals?all=1')).json[0];
  assert.equal((await api('POST', `/festivals/${junk.id}/hide`)).status, 401);
  assert.deepEqual((await api('POST', `/festivals/${junk.id}/hide`, { headers: admin })).json, { ok: true, id: junk.id, status: 'hidden' });
  assert.ok(!(await api('GET', '/festivals?all=1')).json.some(f => f.id === junk.id), 'gone from the public list');
  assert.equal((await api('GET', `/festivals/${junk.id}`)).status, 404);
  assert.equal((await api('GET', '/festivals?all=1&hidden=1')).json.some(f => f.id === junk.id), false, 'no key, no hidden ones');
  assert.equal((await api('GET', '/festivals?all=1&hidden=1', { headers: admin })).json.find(f => f.id === junk.id)?.status, 'hidden');
  assert.equal((await api('POST', `/festivals/${junk.id}/unhide`, { headers: admin })).json.status, 'published');
  assert.ok((await api('GET', '/festivals?all=1')).json.some(f => f.id === junk.id));
  assert.equal((await api('POST', '/festivals/nope/hide', { headers: admin })).status, 404);
  const h = (await api('GET', '/health')).json;
  assert.equal(h.ok, true); assert.equal(typeof h.uptimeSeconds, 'number'); assert.equal(h.adminKey, 'environment'); assert.equal(typeof h.festivals, 'number');
  assert.equal(h.nwsUserAgent, 'set'); assert.equal(h.userAgent, process.env.NWS_USER_AGENT, 'health says who we are, so the shakedown can read it');
  assert.deepEqual({ ...h.sources, wikidata: typeof h.sources.wikidata }, { ticketmaster: false, seatgeek: false, edmtrain: false, wikidata: 'string', feeds: false }, 'no keys in tests; wikidata says why it is off');
  assert.equal(h.imports.running, false);
  assert.equal(h.lightning.on, true); assert.deepEqual(h.lightning.buckets.map(b => b.bucket), ['noaa-goes19', 'noaa-goes18']); assert.equal(h.lightning.files, 0, 'the mapper is never read in tests');
  assert.equal((await api('POST', '/admin/import')).status, 401);
  const kick = await api('POST', '/admin/import', { headers: admin });
  assert.equal(kick.status, 202); assert.equal(kick.json.started, true);
  let r; for (let i = 0; i < 50 && !(r = (await api('GET', '/admin/import', { headers: admin })).json).finishedAt; i++) await new Promise(t => setTimeout(t, 20));
  assert.equal(r.running, false);
  assert.equal(r.ticketmaster.skipped, 'TICKETMASTER_KEY not set');
  assert.equal(r.seatgeek.skipped, 'SEATGEEK_CLIENT_ID not set');
  assert.equal(r.edmtrain.skipped, 'EDMTRAIN_KEY not set');
  assert.equal(r.wikidata.skipped, 'WIKIDATA_IMPORT=false');
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
  const first = await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: FEST } });
  assert.deepEqual(first.json, { ok: true, welcome: { sent: 1 } });
  assert.equal(sent.length, 1, 'subscribing sends one notification straight back, so the chain is seen to work');
  assert.equal(sent[0].endpoint, 'https://push.example.test/a'); assert.equal(sent[0].payload.title, 'Warnings are on');
  assert.match(sent[0].payload.body, /^Suwannee Hulaween\./); assert.equal(sent[0].payload.url, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}`);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('b'), festivalId: FEST } })).json.ok, true);
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: FEST } })).json.ok, true, 'subscribing again is fine');
  const n = sent.length;
  const quiet = await api('POST', '/push/subscribe', { body: { subscription: sub('a'), festivalId: FEST, quiet: true } });
  assert.deepEqual(quiet.json, { ok: true, welcome: false }); assert.equal(sent.length, n, 'a phone registering again on open (quiet) gets no welcome');
  sent.length = 0;

  // A new warning from NWS reaches both browsers; an advisory reaches neither.
  nwsState.features = [
    alertFeature({ id: 'urn:oid:web-1', '@id': 'https://api.weather.gov/alerts/urn:oid:web-1', event: 'Tornado Warning', severity: 'Extreme', headline: 'Tornado Warning until 3:30 PM' }),
    alertFeature({ id: 'urn:oid:web-2', '@id': 'https://api.weather.gov/alerts/urn:oid:web-2', event: 'Rip Current Statement', severity: 'Minor' }),
  ];
  await pollFestival(q.festival(FEST));
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map(x => x.endpoint).sort(), ['https://push.example.test/a', 'https://push.example.test/b']);
  assert.equal(sent[0].payload.title, 'Tornado Warning'); assert.equal(sent[0].payload.tag, 'urn:oid:web-1'); assert.equal(sent[0].payload.urgent, true);
  assert.match(sent[0].payload.body, /^Get to the shelter now\. Lowest floor of a solid building\. Not a tent or a car\. Suwannee Hulaween\. Tornado Warning until 3:30 PM/, 'the line to act on first, in this festival\'s own setup');
  assert.equal(sent[0].payload.url, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}&alert=urn%3Aoid%3Aweb-1`);
  assert.equal(sent[0].opts.urgency, 'high');

  // The warning drops out of the listing twice running: both browsers hear it is over, quietly, under the same tag so it replaces the loud one.
  sent.length = 0;
  nwsState.features = [alertFeature({ id: 'urn:oid:web-2', '@id': 'https://api.weather.gov/alerts/urn:oid:web-2', event: 'Rip Current Statement', severity: 'Minor' })];
  await pollFestival(q.festival(FEST));
  assert.equal(sent.length, 0, 'one empty answer is not an end');
  await pollFestival(q.festival(FEST));
  assert.equal(sent.length, 2);
  assert.equal(sent[0].payload.title, 'Ended: Tornado Warning'); assert.equal(sent[0].payload.tag, 'urn:oid:web-1'); assert.equal(sent[0].payload.ended, true); assert.equal(sent[0].payload.urgent, false); assert.equal(sent[0].opts.urgency, 'normal');
  assert.match(sent[0].payload.body, /^Suwannee Hulaween\. The tornado warning has ended\. \S/, 'and what to do now');
  assert.equal(sent[0].payload.url, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}&alert=urn%3Aoid%3Aweb-1`);

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

test('the QR code for a festival opens the web build on that festival', async () => {
  const { festivalLink } = await import('../src/app.js');
  const r = await api('GET', `/festivals/${FEST}/qr.svg`);
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(r.json, /^<svg/, 'an SVG, so it prints at any size');
  assert.equal((await api('GET', '/festivals/nope/qr.svg')).status, 404);
  // Decode what the same encoder draws as pixels, to prove the link inside is right.
  const { default: QRCode } = await import('qrcode');
  const { PNG } = await import('pngjs');
  const { default: jsQR } = await import('jsqr');
  const png = PNG.sync.read(await QRCode.toBuffer(festivalLink(FEST), { errorCorrectionLevel: 'M', margin: 1, scale: 4 }));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.equal(decoded?.data, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}`);
});

test('a phone with no festival follows a point: subscribing with a location, polling it, and a warning for that spot', async () => {
  const sent = [];
  setWebPushTransport(async (sub, payload, opts) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts }); });
  const sub = { endpoint: 'https://push.example.test/here-1', keys: { p256dh: 'p', auth: 'a' } };
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub } })).status, 400, 'a festival or a point is required');
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub, point: { latitude: 'x', longitude: 2 } } })).status, 400);
  const r = await api('POST', '/push/subscribe', { body: { subscription: sub, point: { latitude: 30.40412, longitude: -82.93951 } } });
  assert.deepEqual(r.json, { ok: true, welcome: { sent: 1 } });
  assert.match(sent[0].payload.body, /wherever this phone is/); assert.equal(sent[0].payload.url, 'https://brandynvandal-photography.github.io/Fieldwatch/?here=1');
  assert.deepEqual(q.webSubscriptionPoints(), [{ latitude: 30.4, longitude: -82.94 }], 'rounded to about a kilometer');
  sent.length = 0;
  nwsState.features = [alertFeature({ id: 'urn:oid:here-1', '@id': 'https://api.weather.gov/alerts/urn:oid:here-1', event: 'Flash Flood Warning', severity: 'Severe' })];
  const fresh = await pollPoint({ latitude: 30.4, longitude: -82.94 });
  assert.equal(fresh.length, 1);
  assert.equal(sent.length, 1); assert.equal(sent[0].endpoint, sub.endpoint); assert.equal(sent[0].payload.title, 'Flash Flood Warning');
  assert.equal(sent[0].payload.url, 'https://brandynvandal-photography.github.io/Fieldwatch/?here=1&alert=urn%3Aoid%3Ahere-1');
  assert.ok(nwsState.calls.some(u => u.includes('/alerts/active?point=30.4000,-82.9400')), 'polled at the rounded point');
  assert.equal((await pollPoint({ latitude: 30.4, longitude: -82.94 })).length, 0, 'seen already');
  assert.equal((await api('DELETE', '/push/subscribe', { body: { endpoint: sub.endpoint } })).json.ok, true);
  assert.deepEqual(q.webSubscriptionPoints(), []);
  nwsState.features = [alertFeature()];
  assert.equal((await api('GET', '/admin/import')).status, 401);
  assert.ok('never' in (await api('GET', '/admin/import', { headers: admin })).json || 'startedAt' in (await api('GET', '/admin/import', { headers: admin })).json);
});


test('the home page feed: every current alert at every festival that is on, the worst first, nothing from a festival weeks out', async () => {
  const { normalizeFestival } = await import('../src/festivals.js');
  const day = n => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  const { festival } = normalizeFestival({ name: 'Feed Test Fest', location: 'Live Oak, FL', latitude: 30.31, longitude: -82.91, startDate: day(2), endDate: day(4) }, { origin: 'community', id: 'feed-test-2026' });
  q.upsertFestival(festival);
  nwsState.features = [
    alertFeature({ id: 'urn:oid:feed-1', '@id': 'https://api.weather.gov/alerts/urn:oid:feed-1', event: 'Heat Advisory', severity: 'Minor' }),
    alertFeature({ id: 'urn:oid:feed-2', '@id': 'https://api.weather.gov/alerts/urn:oid:feed-2', event: 'Severe Thunderstorm Warning', severity: 'Severe' }),
  ];
  await pollFestival(q.festival('feed-test-2026'));
  const feed = (await api('GET', '/alerts')).json;
  assert.ok(feed.codes && typeof feed.codes === 'object' && !Array.isArray(feed.codes), 'the lightning code of every festival that is on rides along, by id');
  assert.ok(feed.on >= 1 && typeof feed.at === 'string');
  const mine = feed.items.find(i => i.festival.id === 'feed-test-2026');
  assert.deepEqual(mine.alerts.map(a => a.event), ['Severe Thunderstorm Warning', 'Heat Advisory'], 'the worst first');
  assert.equal(mine.festival.name, 'Feed Test Fest');
  assert.ok(!feed.items.some(i => i.festival.id === FEST), 'a festival weeks out is not on, so its alerts are not on the home page');
  nwsState.features = [];
  await pollFestival(q.festival('feed-test-2026'));
  assert.ok((await api('GET', '/alerts')).json.items.some(i => i.festival.id === 'feed-test-2026'), 'one empty answer from NWS is not an end');
  await pollFestival(q.festival('feed-test-2026'));
  assert.ok(!(await api('GET', '/alerts')).json.items.some(i => i.festival.id === 'feed-test-2026'), 'cleared alerts leave the feed');
  q.deleteFestival('feed-test-2026');
});

test('a heads-up goes out hours before the forecast turns: once per window, pushed like a warning, listed with the alerts, and not NWS\'s to end', async () => {
  const sent = [];
  setWebPushTransport(async (sub, payload, opts) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts }); });
  const sub = { endpoint: 'https://push.example.test/h', expirationTime: null, keys: { p256dh: 'p-h', auth: 'a-h' } };
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub, festivalId: FEST, quiet: true } })).json.ok, true);
  const now = Date.UTC(2026, 9, 23, 18, 30);   // the fixture forecast turns stormy at 21:00Z, 5 PM in Live Oak
  const a = await headsUp(q.festival(FEST), { now });
  assert.equal(a.channel, 'headsup'); assert.equal(a.event, 'Storms expected around 5:00 PM'); assert.equal(a.minutes, 150); assert.equal(a.severity, 'moderate');
  assert.ok(q.activeAlerts(FEST).some(x => x.id === a.id), 'stored with the festival\'s alerts');
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.title, 'Storms expected around 5:00 PM'); assert.equal(sent[0].opts.urgency, 'normal');
  assert.equal(sent[0].payload.body, 'Suwannee Hulaween. Stake every loop, tie guy lines, weigh the legs by 4:35 PM. The forecast has a 60% chance of thunder, gusts to 34 mph, maybe past the canopy line and 0.6 in of rain.', 'the action first, then the forecast');
  assert.equal(sent[0].payload.url, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}&alert=${encodeURIComponent(a.id)}`);
  assert.equal(await headsUp(q.festival(FEST), { now: now + 25 * 60_000 }), null, 'the same window is not announced twice');
  assert.equal(sent.length, 1);
  const listed = (await api('GET', `/festivals/${FEST}/alerts`)).json.find(x => x.id === a.id);
  assert.equal(listed.channel, 'headsup'); assert.equal(listed.onset, a.onset); assert.match(listed.instruction, /^Stake every loop, tie guy lines, weigh the legs by 4:35 PM\./); assert.equal(listed.plan.length, 4);
  const before = nwsState.features; nwsState.features = [];
  await pollFestival(q.festival(FEST));
  assert.ok(q.activeAlerts(FEST).some(x => x.id === a.id), 'NWS not listing it does not end it: it is ours, and it ends with the window');
  nwsState.features = before;
  // The forecast moves the storms an hour later: the stored heads-up follows (its hour, its first task, the same id), the page is told, nobody is pushed again.
  const shift = (s, h) => ({ ...s, values: s.values.map(v => { const [t0, d] = v.validTime.split('/'); return { ...v, validTime: `${new Date(Date.parse(t0) + h * 3600000).toISOString().replace('.000Z', '+00:00')}/${d}` }; }) });
  nwsState.grid = { properties: { ...grid.properties, probabilityOfThunder: shift(grid.properties.probabilityOfThunder, 1) } };
  assert.equal(await headsUp(q.festival(FEST), { now: now + 50 * 60_000 }), null);
  const moved = q.alert(FEST, a.id);
  assert.equal(moved.event, 'Storms expected around 6:00 PM'); assert.equal(moved.onset, '2026-10-23T22:00:00.000Z'); assert.equal(moved.issuedAt, a.issuedAt); assert.ok(moved.updatedAt);
  assert.equal(sent.length, 1, 'the same window an hour later is not a second push');
  // The forecast lets go of the storms altogether: the heads-up is withdrawn rather than left counting down to nothing.
  nwsState.grid = { properties: { ...grid.properties, probabilityOfThunder: { values: [] }, windGust: { values: [] }, quantitativePrecipitation: { values: [] } } };
  assert.equal(await headsUp(q.festival(FEST), { now: now + 75 * 60_000 }), null);
  const gone = q.alert(FEST, a.id);
  assert.ok(Date.parse(gone.expiresAt) <= now + 75 * 60_000, 'ended'); assert.equal(gone.withdrawn, true);
  assert.ok(!q.activeAlerts(FEST, now + 75 * 60_000).some(x => x.id === a.id), 'and off the list, by that clock');
  nwsState.grid = null;
  q.updateAlert(FEST, { ...a, expiresAt: new Date().toISOString() });
  assert.equal((await api('DELETE', '/push/subscribe', { body: { endpoint: sub.endpoint } })).json.ok, true);
});

test('the ground: the lookups run on demand, staff set what they know better, anyone reads it, the pack carries it, an edit keeps it', async () => {
  assert.equal((await api('PUT', `/festivals/${FEST}/ground`, { body: { surface: 'sand' } })).status, 401);
  assert.equal((await api('PUT', `/festivals/${FEST}/ground`, { headers: admin, body: { surface: 'lava' } })).status, 400);
  const look = await api('POST', `/festivals/${FEST}/ground/lookup`, { headers: admin });
  assert.equal(look.status, 200); assert.equal(look.json.surface, 'grass'); assert.equal(look.json.surfaceSource, 'OpenStreetMap: leisure=park');
  assert.equal(look.json.soil, 'A'); assert.match(look.json.soilName, /^Blanton fine sand/); assert.equal(look.json.soilSource, 'USDA soil survey'); assert.equal(look.json.low, false);
  assert.equal(look.json.camping, true, 'the seed says people camp at Hulaween'); assert.equal(look.json.campingSource, 'the listing');
  const set = await api('PUT', `/festivals/${FEST}/ground`, { headers: admin, body: { surface: 'pavement', structures: ['canopies', 'stage'], low: false, camping: false, note: 'the lot, this year' } });
  assert.equal(set.json.camping, false); assert.equal(set.json.campingSource, 'staff');
  assert.equal(set.status, 200); assert.equal(set.json.surface, 'pavement'); assert.equal(set.json.surfaceSource, 'staff'); assert.equal(set.json.soil, 'A', 'the soil lookup stays under a surface override'); assert.deepEqual(set.json.structures, ['canopies', 'stage']);
  assert.equal((await api('GET', `/festivals/${FEST}/ground`)).json.surface, 'pavement', 'anyone can read it');
  assert.equal((await api('GET', `/festivals/${FEST}/pack`)).json.ground.surface, 'pavement');
  assert.equal(q.festival(FEST).ground.override.surface, 'pavement', 'it is on the record');
  const edited = await api('PUT', `/festivals/${FEST}`, { headers: admin, body: { name: 'Suwannee Hulaween', location: 'Spirit of the Suwannee Music Park, Live Oak, FL', latitude: 30.404, longitude: -82.9395, startDate: q.festival(FEST).startDate, endDate: q.festival(FEST).endDate } });
  assert.equal(edited.status, 200); assert.equal(edited.json.ground.override.surface, 'pavement', 'an edit of the record keeps the ground'); assert.equal(edited.json.ground.soil, 'A');
  const cleared = await api('DELETE', `/festivals/${FEST}/ground`, { headers: admin });
  assert.equal(cleared.json.surface, 'grass'); assert.equal(cleared.json.surfaceSource, 'OpenStreetMap: leisure=park'); assert.deepEqual(cleared.json.structures, ['canopies']); assert.equal(cleared.json.camping, true);
});

test('one tap from the field: a ground report is stored, shows on the ground and in the pack, and is rate limited', async () => {
  assert.equal((await api('POST', `/festivals/${FEST}/ground/report`, { body: { state: 'swampy' } })).status, 400);
  const r = await api('POST', `/festivals/${FEST}/ground/report`, { body: { state: 'mud' } });
  assert.equal(r.status, 200); assert.equal(r.json.state, 'mud'); assert.equal(r.json.effective, 0, 'no rain analysis in tests, so nothing counted'); assert.equal(r.json.learned, null, 'and nothing learned from mud with no rain behind it');
  assert.equal(r.json.reports.last.state, 'mud'); assert.equal(r.json.reports.recent, 1);
  assert.equal((await api('GET', `/festivals/${FEST}/ground`)).json.reports.last.state, 'mud');
  assert.equal((await api('GET', `/festivals/${FEST}/pack`)).json.ground.reports.recent, 1);
  for (let n = 0; n < 4; n++) assert.equal((await api('POST', `/festivals/${FEST}/ground/report`, { body: { state: 'fine' } })).status, 200);
  assert.equal((await api('POST', `/festivals/${FEST}/ground/report`, { body: { state: 'fine' } })).status, 429);
});

test('the live stream: a page listening hears which festival changed and what kind, the moment it lands', async () => {
  const ctl = new AbortController();
  const res = await fetchReal(`${base}/events?f=${FEST}`, { signal: ctl.signal });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /text\/event-stream/); assert.equal(res.headers.get('access-control-allow-origin'), '*', 'a page on another origin may listen');
  const reader = res.body.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  assert.match(first, /retry: 5000/, 'the browser reconnects on its own');
  const before = nwsState.features;
  nwsState.features = [alertFeature({ id: 'urn:oid:live-1', '@id': 'https://api.weather.gov/alerts/urn:oid:live-1', event: 'Wind Advisory', severity: 'Minor' })];
  const heard = (async () => { let buf = ''; for (;;) { const { value, done } = await reader.read(); if (done) return buf; buf += decoder.decode(value); if (buf.includes('event: change')) return buf; } })();
  await pollFestival(q.festival(FEST));
  const chunk = await heard;
  assert.match(chunk, /event: change\ndata: \{"festivalId":"hulaween-2026","kind":"alerts","at":"[^"]+"\}\n\n/);
  assert.equal((await api('GET', '/health')).json.live, 1, 'one page listening');
  const id = Number((/id: (\d+)\nevent: change/.exec(chunk) || [])[1]);
  assert.ok(id > 0, 'every event is numbered');
  // A page that reconnects says where it left off (the browser sends Last-Event-ID by itself) and hears what it missed.
  const ctl2 = new AbortController();
  const res2 = await fetchReal(`${base}/events?f=${FEST}`, { signal: ctl2.signal, headers: { 'Last-Event-ID': String(id - 1) } });
  const reader2 = res2.body.getReader(); let buf2 = '';
  for (;;) { const { value, done } = await reader2.read(); if (done) break; buf2 += decoder.decode(value); if (buf2.includes(`id: ${id}\n`)) break; }
  assert.match(buf2, new RegExp(`id: ${id}\\nevent: change\\ndata: \\{"festivalId":"hulaween-2026","kind":"alerts"`), 'the missed change is replayed first');
  ctl.abort(); ctl2.abort(); nwsState.features = before;
  await new Promise(r => setTimeout(r, 50));
  assert.equal((await api('GET', '/health')).json.live, 0, 'and gone when it hangs up');
});

test('health says what to alert on; the counters add up with nobody in them; a backup is a file to download', async () => {
  const h = (await api('GET', '/health')).json;
  assert.equal(h.ok, true); assert.deepEqual(h.problems, []); assert.ok(Array.isArray(h.warnings));
  assert.ok(h.polling && 'lastOkAt' in h.polling); assert.ok(h.radar && 'festivals' in h.radar); assert.ok(h.backups && 'count' in h.backups);
  assert.equal((await api('GET', '/health?strict=1')).status, 200, 'strict answers 200 while nothing is wrong');
  await api('GET', `/festivals/${FEST}/pack`); await api('GET', `/festivals/${FEST}/alerts`); await api('GET', '/alerts');
  assert.equal((await api('GET', '/admin/stats')).status, 401);
  const st = (await api('GET', '/admin/stats?days=7', { headers: admin })).json;
  assert.ok(st.totals.pack >= 1 && st.totals.alerts >= 1 && st.totals.feed >= 1, JSON.stringify(st.totals));
  assert.ok(st.totals['alert.new'] >= 1, 'alerts stored are counted');
  assert.ok(st.festivals.some(f => f.id === FEST && f.counts.pack >= 1), 'per festival, by name');
  assert.ok(!JSON.stringify(st).includes('push.example'), 'no endpoint, token or address in the numbers');
  const made = (await api('POST', '/admin/backup', { headers: admin })).json;
  assert.ok(made.bytes > 0 && made.count >= 1 && /^fieldwatch-\d{4}-\d{2}-\d{2}\.db$/.test(made.newest), JSON.stringify(made));
  const dl = await fetchReal(`${base}/admin/backup`, { headers: admin });
  assert.equal(dl.status, 200); assert.match(dl.headers.get('content-disposition') || '', /fieldwatch-\d{4}-\d{2}-\d{2}\.db/);
  assert.equal(Buffer.from(await dl.arrayBuffer()).subarray(0, 15).toString(), 'SQLite format 3');
  const copy = new Database(join(process.env.BACKUP_DIR, made.newest), { readonly: true });
  assert.ok(copy.prepare('SELECT count(*) AS n FROM festivals').get().n >= 1, 'the copy opens and holds the festivals'); copy.close();
  assert.equal((await api('GET', '/health')).json.backups.newest, made.newest);
});

test('the shakedown script reads a whole backend in one pass', async () => {
  const { shakedown } = await import('../scripts/shakedown.mjs');
  const now = Date.now(), DAY = 86_400_000;
  q.upsertFestival({ ...q.festival(FEST), id: 'shakedown-2026', name: 'Shakedown', startDate: new Date(now - DAY).toISOString(), endDate: new Date(now + DAY).toISOString() });
  try {
    const r = await shakedown(base, { key: 'test-admin', fetchImpl: fetchReal, sseMs: 400 });
    assert.equal(r.health.ok, true); assert.deepEqual(r.errors, []);
    const row = r.festivals.find(f => f.id === 'shakedown-2026');
    assert.ok(row, `the festival that is on is in the report: ${r.festivals.map(f => f.id)}`);
    assert.match(row.alerts, /\d+ active/); assert.match(row.lightning, /^(none|green|yellow|orange|red|indoor)/); assert.match(row.radar, /frames/); assert.match(row.ground, /soil/); assert.match(row.nowcast, /tracked|rain in/);
    assert.equal(r.live.opened, true); assert.equal(r.live.hello, true, 'the stream said hello');
    assert.ok(r.admin.stats.totals && r.admin.imports, 'with the key, the counters and the last import');
  } finally { q.deleteFestival('shakedown-2026'); }
});

test('a festival\'s own staff key posts, moderates and sets the ground for that festival and nothing else; the admin issues and revokes it', async () => {
  const other = festivals.find(f => f.id !== FEST).id;
  assert.equal((await api('POST', `/festivals/${FEST}/partner-key`)).status, 401, 'only the admin issues keys');
  const issued = (await api('POST', `/festivals/${FEST}/partner-key`, { headers: admin })).json;
  assert.match(issued.key, /^[A-Za-z0-9_-]{20,}$/); assert.match(issued.link, new RegExp(`\\?f=${FEST}&staff=1$`));
  assert.equal(q.festival(FEST).isPartner, true, 'a festival with a staff key is a partner');
  const staff = { 'x-admin-key': issued.key };
  assert.deepEqual((await api('GET', '/staff/me', { headers: staff })).json, { scope: 'partner', festivalId: FEST, name: q.festival(FEST).name });
  assert.deepEqual((await api('GET', '/staff/me', { headers: admin })).json, { scope: 'admin' });
  assert.equal((await api('GET', '/staff/me', { headers: { 'x-admin-key': 'nope' } })).status, 401);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'Gates open late', body: 'Noon, not eleven.' }, headers: staff })).status, 201, 'its own festival: a post goes out');
  assert.equal((await api('POST', `/festivals/${other}/posts`, { body: { title: 'x', body: 'y' }, headers: staff })).status, 401, 'another festival: no');
  assert.equal((await api('GET', `/festivals/${FEST}/incidents/pending`, { headers: staff })).status, 200);
  assert.equal((await api('PUT', `/festivals/${FEST}/ground`, { body: { surface: 'gravel' }, headers: staff })).status, 200);
  assert.equal((await api('GET', '/admin/stats', { headers: staff })).status, 401, 'nothing admin-wide');
  assert.equal((await api('POST', `/festivals/${other}/hide`, { headers: staff })).status, 401);
  assert.equal((await api('GET', `/festivals/${FEST}/partner-key`, { headers: admin })).json.issued, true);
  assert.equal((await api('DELETE', `/festivals/${FEST}/partner-key`, { headers: admin })).json.issued, false);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { body: { title: 'x', body: 'y' }, headers: staff })).status, 401, 'revoked: the key is dead');
  assert.ok(!JSON.stringify(q.partnerKeys()).includes(issued.key), 'the key itself is never stored');
});

test('the admin key the server makes: made once, kept hashed, never shown again; a reset kills the old one', async () => {
  const saved = process.env.ADMIN_KEY, madeKey = k => ({ 'x-admin-key': k });
  delete process.env.ADMIN_KEY;
  try {
    assert.equal(adminKeyStatus().source, 'none', 'nothing made yet: this suite set ADMIN_KEY before boot');
    const made = ensureAdminKey();
    assert.match(made.key, /^[A-Za-z0-9_-]{32}$/); assert.equal(made.source, 'database'); assert.ok(made.madeAt);
    assert.deepEqual(ensureAdminKey(), { source: 'database', madeAt: made.madeAt }, 'the next boot finds it and never sees the key again');
    assert.equal((await api('GET', '/admin/stats', { headers: madeKey(made.key) })).status, 200, 'the made key is the admin key');
    assert.deepEqual((await api('GET', '/staff/me', { headers: madeKey(made.key) })).json, { scope: 'admin' });
    assert.equal((await api('GET', '/admin/stats', { headers: admin })).status, 401, 'with ADMIN_KEY unset, the environment key is nothing');
    assert.equal((await api('GET', '/health')).json.adminKey, 'database');
    assert.ok(!JSON.stringify(q.setting('admin')).includes(made.key), 'the key itself is never stored');
    const next = resetAdminKey();
    assert.notEqual(next.key, made.key);
    assert.equal((await api('GET', '/admin/stats', { headers: madeKey(made.key) })).status, 401, 'the old key is dead the moment the new one exists');
    assert.equal((await api('GET', '/admin/stats', { headers: madeKey(next.key) })).status, 200, 'and the running server takes the new one with no restart');
  } finally { process.env.ADMIN_KEY = saved; q.deleteSetting('admin'); }
  assert.equal((await api('GET', '/admin/stats', { headers: admin })).status, 200, 'ADMIN_KEY back: the environment wins again');
  assert.equal((await api('GET', '/health')).json.adminKey, 'environment');
});

test('a spot, festival or not: the lightning grade and the flashes for wherever a phone stands', async () => {
  assert.equal((await api('GET', '/point/nope/lightning')).status, 400); assert.equal((await api('GET', '/point/91,0/lightning')).status, 400);
  const r = await api('GET', '/point/35.2271,-80.8431/lightning');
  assert.equal(r.status, 200); assert.equal(r.json.code, 'none'); assert.equal(r.json.point, true); assert.ok(r.json.warming === true || r.json.on === false, 'the first fifteen minutes are a warm-up');
  const fl = await api('GET', '/point/35.2271,-80.8431/lightning/flashes');
  assert.equal(fl.status, 200); assert.deepEqual(fl.json.flashes, []);
});

test('a hold the safety team calls stands on the page as a warning until its end, the all-clear ends it, a post can be taken back, and the reach is kept', async () => {
  const sent = []; setWebPushTransport(async (sub, payload, opts) => { sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), opts }); });
  const sub = { endpoint: 'https://push.example.test/hold', expirationTime: null, keys: { p256dh: 'p-h', auth: 'a-h' } };
  assert.equal((await api('POST', '/push/subscribe', { body: { subscription: sub, festivalId: FEST, quiet: true } })).json.ok, true);
  assert.equal((await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'x', body: 'y', kind: 'siren' } })).status, 400);
  const before = Date.now();
  const hold = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Shelter in place', body: 'Lightning within 8 miles. Get into a vehicle or a building now.', kind: 'shelter', minutes: 45 } });
  assert.equal(hold.status, 201); assert.equal(hold.json.kind, 'shelter'); assert.equal(hold.json.reach, 1); assert.deepEqual(hold.json.ended, []);
  const standing = q.activeAlerts(FEST).find(a => a.id === `official-${FEST}-${hold.json.id}`);
  assert.ok(standing, 'a hold is kept with the alerts so the page carries it'); assert.equal(standing.severity, 'severe', 'shelter is always urgent'); assert.equal(standing.kind, 'shelter'); assert.equal(standing.minutes, 45);
  assert.ok(Math.abs(Date.parse(standing.expiresAt) - (before + 45 * 60_000)) < 5000, 'it ends when staff said');
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.title, 'Shelter in place'); assert.equal(sent[0].opts.urgency, 'high'); assert.equal(sent[0].payload.channel, 'official');
  const listed = (await api('GET', `/festivals/${FEST}/posts`)).json.find(p => p.id === hold.json.id);
  assert.equal(listed.kind, 'shelter'); assert.equal(listed.reach, 1); assert.equal(listed.expiresAt, standing.expiresAt);
  // A notice stays a post and a push, not an alert on the sky.
  const notice = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Water station moved', body: 'Now by the east gate.' } });
  assert.equal(notice.json.kind, 'notice'); assert.equal(q.alert(FEST, `official-${FEST}-${notice.json.id}`), null);
  // The all-clear ends every hold standing and is said once.
  sent.length = 0;
  const clear = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'All clear', body: 'The hold is over.', kind: 'allclear' } });
  assert.deepEqual(clear.json.ended, [standing.id]);
  assert.ok(Date.parse(q.alert(FEST, standing.id).expiresAt) <= Date.now(), 'the hold ended');
  assert.equal(sent.length, 1); assert.equal(sent[0].payload.title, 'All clear'); assert.equal(sent[0].opts.urgency, 'normal');
  // Staff take the notice back: off the list, and the phones hear so under its tag.
  sent.length = 0;
  assert.equal((await api('DELETE', `/festivals/${FEST}/posts/999999`, { headers: admin })).status, 404);
  assert.equal((await api('DELETE', `/festivals/${FEST}/posts/${notice.json.id}`)).status, 401);
  const gone = await api('DELETE', `/festivals/${FEST}/posts/${notice.json.id}`, { headers: admin });
  assert.equal(gone.status, 200); assert.equal(gone.json.ended, false, 'a notice had no alert to end');
  assert.equal((await api('DELETE', `/festivals/${FEST}/posts/${notice.json.id}`, { headers: admin })).status, 409, 'once');
  assert.ok(!(await api('GET', `/festivals/${FEST}/posts`)).json.some(p => p.id === notice.json.id), 'off the list');
  assert.equal(sent.length, 0, 'a minor notice taken back is nothing to push about');
  const hold2 = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Evacuate the grounds', body: 'Leave now, as staff direct.', kind: 'evacuate' } });
  sent.length = 0;
  const back = await api('DELETE', `/festivals/${FEST}/posts/${hold2.json.id}`, { headers: admin });
  assert.equal(back.json.ended, true); assert.equal(sent.length, 1); assert.equal(sent[0].payload.title, 'Retracted: Evacuate the grounds'); assert.equal(sent[0].payload.tag, `official-${FEST}-${hold2.json.id}`); assert.equal(sent[0].payload.ended, true);
  assert.equal(q.alert(FEST, `official-${FEST}-${hold2.json.id}`).retracted, true);
  assert.equal((await api('DELETE', '/push/subscribe', { body: { endpoint: sub.endpoint } })).json.ok, true);
});

test('the staff key hands off as a link and a QR, the record carries shelter and medical, and a report landing is on the stream', async () => {
  const issued = await api('POST', `/festivals/${FEST}/partner-key`, { headers: admin });
  assert.equal(issued.status, 200); assert.ok(issued.json.key);
  assert.equal(issued.json.handoff, `https://brandynvandal-photography.github.io/Fieldwatch/?f=${FEST}&staff=1&key=${encodeURIComponent(issued.json.key)}`);
  assert.match(issued.json.qr, /^<svg/, 'the handoff as a QR, to scan once');
  assert.equal((await api('GET', '/staff/me', { headers: { 'x-admin-key': issued.json.key } })).json.scope, 'partner');
  const edited = await api('PUT', `/festivals/${FEST}`, { headers: { 'x-admin-key': issued.json.key }, body: { shelter: 'The Music Hall and the cars in Lot B', medical: 'Medical tent by the main gate. ER: Shands Live Oak, 8 minutes north on US 129.' } });
  assert.equal(edited.status, 200); assert.equal(edited.json.shelter, 'The Music Hall and the cars in Lot B'); assert.match(edited.json.medical, /^Medical tent/); assert.equal(edited.json.name, 'Suwannee Hulaween', 'the rest of the record stays');
  assert.equal((await api('GET', `/festivals/${FEST}`)).json.shelter, 'The Music Hall and the cars in Lot B');
  const hold = await api('POST', `/festivals/${FEST}/posts`, { headers: admin, body: { title: 'Shelter in place', body: 'Now.', kind: 'shelter' } });
  assert.equal(q.alert(FEST, `official-${FEST}-${hold.json.id}`).instruction, 'Shelter: The Music Hall and the cars in Lot B', 'a hold carries where shelter is');
  await api('DELETE', `/festivals/${FEST}/posts/${hold.json.id}`, { headers: admin });
  const { live } = await import('../src/live.js'), heard = []; const on = e => heard.push(e); live.on('change', on);
  (await import('../src/app.js')).resetReportLimit();
  assert.equal((await api('POST', `/festivals/${FEST}/reports`, { body: { summary: 'Fence down by the north gate, people climbing' } })).status, 202);
  live.off('change', on);
  assert.ok(heard.some(e => e.festivalId === FEST && e.kind === 'reports'), 'the staff queue hears it land');
  await api('DELETE', `/festivals/${FEST}/partner-key`, { headers: admin });
});
