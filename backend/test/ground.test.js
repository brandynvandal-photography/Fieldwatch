// The ground under a festival from free public data: OpenStreetMap land use, the USDA soil survey, the Mesonet's rain
// analysis, and the staff override on top. Every service is a fake here; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
const { coverFromNLCD, effectiveGround, ensureGround, groundFor, indoorFromTags, indoorFromWords, learnedThreshold, lookupGround, pastRain, reportGround, reportSummary, soilFromUSDA, surfaceFromOSM, surfaceFromTags, validOverride } = await import('../src/ground.js');
const { iso } = await import('../src/util.js');

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const fest = { id: 'ground-test', name: 'Ground Test', location: 'Live Oak, FL', latitude: 30.404, longitude: -82.9395, startDate: '2026-09-29T00:00:00Z', endDate: '2026-10-02T00:00:00Z' };
const overpass = elements => json({ version: 0.6, elements });
const sda = rows => json({ Table: [['mukey', 'muname', 'compname', 'hydgrp', 'drainagecl', 'comppct_r'], ...rows] });
const nlcd = code => json({ type: 'FeatureCollection', features: [{ type: 'Feature', id: '', geometry: null, properties: { GRAY_INDEX: code } }] });
const DAY = 86400000;

test('tags read for the ground: a surface tag first, then a use, then land cover; boundaries say nothing', () => {
  assert.deepEqual(surfaceFromTags({ surface: 'asphalt', amenity: 'parking' }), ['pavement', false]);
  assert.deepEqual(surfaceFromTags({ leisure: 'park' }), ['grass', false]);
  assert.deepEqual(surfaceFromTags({ landuse: 'farmland' }), ['grass', false]);
  assert.deepEqual(surfaceFromTags({ natural: 'beach' }), ['sand', false]);
  assert.deepEqual(surfaceFromTags({ natural: 'wetland' }), ['grass', true], 'a wetland is low ground');
  assert.deepEqual(surfaceFromTags({ surface: 'gravel' }), ['gravel', false]);
  assert.equal(surfaceFromTags({ boundary: 'administrative', admin_level: '6', name: 'Suwannee County' }), null);
  assert.equal(surfaceFromTags({}), null);
});

test('the surface from Overpass: the most telling area under the point wins, a county boundary is ignored', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url: String(url), body: init?.body, ua: init?.headers?.['User-Agent'] }); return overpass([
    { type: 'area', id: 1, tags: { boundary: 'administrative', admin_level: '6', name: 'Suwannee County' } },
    { type: 'area', id: 2, tags: { landuse: 'farmland' } },
    { type: 'area', id: 3, tags: { leisure: 'park', name: 'Spirit of the Suwannee Music Park' } },
  ]); };
  const s = await surfaceFromOSM(fest.latitude, fest.longitude, { fetchImpl });
  assert.deepEqual(s, { surface: 'grass', low: false, camping: false, indoor: false, indoorTag: null, source: 'OpenStreetMap', tag: 'leisure=park' }, 'the park (a use) beats the farmland (land cover); mapped land under the point means outdoors');
  assert.match(decodeURIComponent(calls[0].body), /is_in\(30\.40400,-82\.93950\)/); assert.equal(calls[0].ua, process.env.NWS_USER_AGENT);
  assert.equal(await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { boundary: 'administrative' } }]) }), null, 'nothing telling: null, not a guess');
  const camp = await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { tourism: 'camp_site', name: 'Spirit of the Suwannee' } }, { type: 'area', id: 2, tags: { landuse: 'meadow' } }]) });
  assert.equal(camp.camping, true, 'a campground under the grounds: people camp here'); assert.equal(camp.surface, 'grass'); assert.equal(s.camping, false);
  await assert.rejects(surfaceFromOSM(0, 0, { fetchImpl: async () => new Response('busy', { status: 429 }) }), /Overpass 429/);
});

test('nothing under the point: the nearest mapped ground within 250 m, its distance in the source', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => { bodies.push(decodeURIComponent(init.body)); return bodies.length === 1 ? overpass([{ type: 'area', id: 1, tags: { boundary: 'administrative' } }])
    : overpass([{ type: 'way', id: 7, center: { lat: fest.latitude + 0.0018, lon: fest.longitude }, tags: { amenity: 'parking', surface: 'asphalt' } },
                { type: 'way', id: 8, center: { lat: fest.latitude + 0.0005, lon: fest.longitude }, tags: { landuse: 'farmland' } },
                { type: 'node', id: 9, lat: fest.latitude + 0.002, lon: fest.longitude, tags: { tourism: 'camp_site' } }]); };
  const s = await surfaceFromOSM(fest.latitude, fest.longitude, { fetchImpl });
  assert.equal(bodies.length, 2); assert.match(bodies[0], /is_in\(30\.40400,-82\.93950\)/); assert.match(bodies[1], /nwr\(around:250,30\.40400,-82\.93950\)/); assert.match(bodies[1], /out tags center/);
  assert.deepEqual(s, { surface: 'grass', low: false, camping: true, indoor: null, indoorTag: null, source: 'OpenStreetMap', tag: 'landuse=farmland, 56 m away' }, 'the field 56 m off beats the lot 200 m off; the campground beside it says people camp; nothing under the point says indoors or out');
});

test('the land cover at the point when OpenStreetMap has nothing: an NLCD class read as ground', async () => {
  let url = '';
  const c = await coverFromNLCD(fest.latitude, fest.longitude, { fetchImpl: async u => { url = String(u); return nlcd(81); } });
  assert.deepEqual(c, { surface: 'grass', low: false, source: 'NLCD land cover: Pasture/hay', code: 81 });
  const u = new URL(url);
  assert.equal(u.searchParams.get('REQUEST'), 'GetFeatureInfo'); assert.equal(u.searchParams.get('BBOX'), '-82.94000,30.40350,-82.93900,30.40450', 'a window about 110 m across, the point in its middle pixel');
  assert.equal(u.searchParams.get('X'), '1'); assert.equal(u.searchParams.get('INFO_FORMAT'), 'application/json');
  assert.deepEqual(await coverFromNLCD(0, 0, { fetchImpl: async () => nlcd(23) }), { surface: 'pavement', low: false, source: 'NLCD land cover: Developed, medium intensity', code: 23 });
  assert.deepEqual(await coverFromNLCD(0, 0, { fetchImpl: async () => nlcd(82) }), { surface: 'dirt', low: false, source: 'NLCD land cover: Cultivated crops', code: 82 });
  assert.deepEqual(await coverFromNLCD(0, 0, { fetchImpl: async () => nlcd(95) }), { surface: 'grass', low: true, source: 'NLCD land cover: Emergent herbaceous wetlands', code: 95 }, 'a wetland is low ground');
  assert.deepEqual(await coverFromNLCD(0, 0, { fetchImpl: async () => json({ features: [{ properties: { PALETTE_INDEX: '21' } }] }) }), { surface: 'grass', low: false, source: 'NLCD land cover: Developed, open space', code: 21 }, 'a paletted answer reads the same');
  assert.equal(await coverFromNLCD(0, 0, { fetchImpl: async () => nlcd(11) }), null, 'open water says nothing about a field');
  await assert.rejects(coverFromNLCD(0, 0, { fetchImpl: async () => json({ type: 'FeatureCollection', features: [] }) }), /no class/);
  await assert.rejects(coverFromNLCD(0, 0, { fetchImpl: async () => new Response('down', { status: 502 }) }), /Land cover 502/);
});

test('the soil from the USDA survey: hydrologic group and drainage, a dual group read as its wetter letter, poorly drained is low', async () => {
  let sent;
  const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return sda([['12345', 'Blanton fine sand, 0 to 5 percent slopes', 'Blanton', 'A', 'Somewhat excessively drained', '85']]); };
  const s = await soilFromUSDA(fest.latitude, fest.longitude, { fetchImpl });
  assert.deepEqual(s, { soil: 'A', drainage: 'Somewhat excessively drained', low: false, soilName: 'Blanton fine sand, 0 to 5 percent slopes', source: 'USDA soil survey' });
  assert.match(sent.query, /point\(-82\.93950 30\.40400\)/, 'longitude first in well-known text'); assert.equal(sent.format, 'JSON+COLUMNNAME');
  const clay = await soilFromUSDA(0, 0, { fetchImpl: async () => sda([['1', 'Houston Black clay', 'Houston Black', 'D', 'Moderately well drained', '90']]) });
  assert.equal(clay.soil, 'D'); assert.equal(clay.low, false);
  const dual = await soilFromUSDA(0, 0, { fetchImpl: async () => sda([['1', 'Wabash silty clay loam, frequently flooded', 'Wabash', 'C/D', 'Poorly drained', '90']]) });
  assert.equal(dual.soil, 'D', 'C/D is D unless the field is drained, and a festival field rarely is'); assert.equal(dual.low, true);
  assert.equal(await soilFromUSDA(0, 0, { fetchImpl: async () => json({ Table: [] }) }), null, 'no map unit (water, or outside the survey): null');
  assert.equal(await soilFromUSDA(0, 0, { fetchImpl: async () => json({ Table: [['mukey', 'muname', 'compname', 'hydgrp', 'drainagecl', 'comppct_r']] }) }), null, 'a header alone is no answer');
});

test('rain of the last two days from the Mesonet analysis', async () => {
  const now = Date.UTC(2026, 8, 30, 15);
  const fetchImpl = async url => { assert.match(String(url), /\/iemre\/multiday\/2026-09-28\/2026-09-30\/30\.4040\/-82\.9395\/json$/); return json({ data: [
    { date: '2026-09-28', daily_precip_in: 0.4 }, { date: '2026-09-29', daily_precip_in: 1.1 }, { date: '2026-09-30', daily_precip_in: 0.25 }] }); };
  const r = await pastRain(fest.latitude, fest.longitude, { now, fetchImpl });
  assert.equal(r.in24, 1.35, 'yesterday and today so far'); assert.equal(r.in48, 1.75); assert.equal(r.days.length, 3); assert.equal(r.source, 'IEM daily analysis');
  await assert.rejects(pastRain(0, 0, { now, fetchImpl: async () => json({ data: [] }) }), /no days/);
});

test('a lookup lands on the record, the override sits on top, and the effective ground is what the model reads', async () => {
  const fetchImpl = async (url, init) => String(url).includes('overpass') ? overpass([{ type: 'area', id: 3, tags: { amenity: 'parking', surface: 'asphalt' } }])
    : sda([['1', 'Urban land', 'Urban land', 'D', 'Well drained', '95']]);
  const saved = [];
  const g = await lookupGround(fest, { fetchImpl, save: f => saved.push(f) });
  assert.equal(g.surface, 'pavement'); assert.equal(g.surfaceSource, 'OpenStreetMap: surface=asphalt, amenity=parking'); assert.equal(g.soil, 'D'); assert.equal(g.soilName, 'Urban land'); assert.equal(g.lookupError, null, 'a clean lookup writes null, so an old error clears');
  assert.equal(saved.length, 1); assert.equal(saved[0].ground.surface, 'pavement');
  const eff = effectiveGround(saved[0]);
  assert.deepEqual({ surface: eff.surface, soil: eff.soil, low: eff.low, structures: eff.structures, surfaceSource: eff.surfaceSource }, { surface: 'pavement', soil: 'D', low: false, structures: ['canopies'], surfaceSource: 'OpenStreetMap: surface=asphalt, amenity=parking' });
  assert.deepEqual(effectiveGround({}), { surface: 'grass', soil: 'B', low: false, structures: ['canopies'], camping: null, campingSource: 'unknown', indoor: null, indoorSource: 'unknown', surfaceSource: 'assumed', soilSource: 'assumed', soilName: null, drainage: null, lookedUpAt: null, lookupError: null, override: null, learned: null }, 'nothing known: trampled grass on average soil, and nobody knows if people camp or if there is a roof');
  // Staff know the lot is grass this year, and there is a stage.
  assert.equal(validOverride({ camping: false }).override.camping, false); assert.equal(validOverride({ camping: 'true' }).override.camping, true); assert.equal(validOverride({}).override.camping, undefined);
  assert.equal(effectiveGround({ camping: false }).camping, false, 'the listing says no camping'); assert.equal(effectiveGround({ camping: false, ground: { camping: true, campingSource: 'x' } }).camping, true, 'a lookup beats the listing'); assert.equal(effectiveGround({ ground: { camping: true, override: { camping: false } } }).camping, false, 'staff beat both');
  const { override, error } = validOverride({ surface: 'grass', structures: ['canopies', 'stage'], low: true });
  assert.equal(error, undefined);
  const withOverride = { ...saved[0], ground: { ...saved[0].ground, override } };
  const e2 = effectiveGround(withOverride);
  assert.equal(e2.surface, 'grass'); assert.equal(e2.surfaceSource, 'staff'); assert.equal(e2.soil, 'D'); assert.equal(e2.low, true); assert.deepEqual(e2.structures, ['canopies', 'stage']);
  assert.match(validOverride({ surface: 'lava' }).error, /surface must be one of/); assert.match(validOverride({ structures: ['tents', 'x'] }).error, /structures must be some of/);
  // One service down: the other still lands, and the error is on the record for the sources screen.
  const half = await lookupGround(fest, { fetchImpl: async url => String(url).includes('overpass') ? new Response('no', { status: 504 }) : String(url).includes('mrlc') ? nlcd(82) : sda([['1', 'Blanton fine sand', 'Blanton', 'A', 'Well drained', '90']]) });
  assert.equal(half.surface, 'dirt', 'OpenStreetMap down: the land cover map stands in'); assert.equal(half.surfaceSource, 'NLCD land cover: Cultivated crops'); assert.equal(half.soil, 'A'); assert.match(half.lookupError, /^surface: Overpass 504$/);
  const dark = await lookupGround(fest, { fetchImpl: async url => String(url).includes('overpass') ? overpass([]) : String(url).includes('mrlc') ? new Response('down', { status: 502 }) : sda([['1', 'Blanton fine sand', 'Blanton', 'A', 'Well drained', '90']]) });
  assert.equal(dark.surface, undefined); assert.match(dark.lookupError, /^cover: Land cover 502$/, 'nothing mapped and the cover service down: no guess, the error on the record');
  // groundFor: the effective ground plus the recent rain, the rain kept from the cache when the analysis is down.
  const gf = await groundFor(withOverride, { fetchImpl: async () => json({ data: [{ date: '2026-09-30', daily_precip_in: 0.3 }] }) });
  assert.equal(gf.surface, 'grass'); assert.equal(gf.past.in24, 0.3);
  const again = await groundFor(withOverride, { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(again.past.in24, 0.3, 'a fetch that fails keeps the last analysis');
});

test('a festival that is on gets its lookup once; one festival per pass, none tried again within six hours', async () => {
  let calls = 0;
  const fetchImpl = async url => { calls++; return String(url).includes('overpass') ? overpass([{ type: 'area', id: 1, tags: { landuse: 'meadow' } }]) : sda([['1', 'Loam', 'Loam', 'B', 'Well drained', '90']]); };
  const saved = new Map(); const save = f => saved.set(f.id, f);
  const a = { ...fest, id: 'eg-a' }, b = { ...fest, id: 'eg-b' };
  const first = await ensureGround([a, b], { fetchImpl, save });
  assert.equal(first.surface, 'grass'); assert.equal(saved.size, 1); assert.ok(saved.has('eg-a')); assert.equal(calls, 2);
  const second = await ensureGround([saved.get('eg-a'), b], { fetchImpl, save });
  assert.ok(saved.has('eg-b'), 'the next pass takes the next festival'); assert.equal(second.soil, 'B');
  assert.equal(await ensureGround([saved.get('eg-a'), saved.get('eg-b')], { fetchImpl, save }), null, 'both looked up: nothing to do');
  assert.equal(await ensureGround([a], { fetchImpl, save }), null, 'a record still without a lookup (a failed save) is not retried within six hours');
});

test('a lookup that found nothing is tried again after a day; one that found the ground is left alone', async () => {
  const now = Date.now(), urls = [];
  const fetchImpl = async url => { urls.push(String(url)); return String(url).includes('overpass') ? overpass([]) : String(url).includes('mrlc') ? nlcd(82) : sda([['1', 'Loam', 'Loam', 'B', 'Well drained', '90']]); };
  const saved = new Map(); const save = f => saved.set(f.id, f);
  const empty = { ...fest, id: 'eg-empty', ground: { lookedUpAt: iso(now - 2 * DAY), lookupError: 'surface: Overpass 504' } };
  const full = { ...fest, id: 'eg-full', ground: { lookedUpAt: iso(now - 2 * DAY), surface: 'grass', soil: 'B' } };
  const fresh = { ...fest, id: 'eg-fresh', ground: { lookedUpAt: iso(now - 2 * 3600000) } };
  const g = await ensureGround([full, fresh, empty], { now, fetchImpl, save });
  assert.equal(g.surface, 'dirt'); assert.equal(g.surfaceSource, 'NLCD land cover: Cultivated crops'); assert.equal(g.soil, 'B'); assert.equal(g.lookupError, null);
  assert.ok(saved.has('eg-empty') && !saved.has('eg-full') && !saved.has('eg-fresh'), 'the empty one from two days ago is tried again; the full one and the one from two hours ago are not');
  assert.equal(await ensureGround([full, fresh, saved.get('eg-empty')], { now, fetchImpl, save }), null, 'and once it has the ground, nothing to do');
});

test('the venue learns how much rain it takes from what people report, and a report carries the rain counted at the time', async () => {
  assert.equal(learnedThreshold([]), null);
  assert.equal(learnedThreshold([{ state: 'mud', effective: 0.02 }]), null, 'mud with no rain behind it teaches nothing');
  assert.equal(learnedThreshold([{ state: 'fine', effective: 0.6 }]), null, 'fine ground alone sets no line');
  assert.equal(learnedThreshold([{ state: 'soft', effective: 0.45 }, { state: 'mud', effective: 0.9 }]).threshold, 0.45, 'the least rain at which it went soft');
  assert.equal(learnedThreshold([{ state: 'soft', effective: 0.45 }, { state: 'fine', effective: 0.6 }, { state: 'mud', effective: 0.9 }]).threshold, 0.75, 'fine at 0.6 and mud at 0.9: the line sits between');
  assert.equal(learnedThreshold([{ state: 'soft', effective: 0.45 }, { state: 'fine', effective: 0.6 }]).threshold, 0.7, 'fine above every wet report: just past the fine');
  const rows = []; const q = { insertGroundReport: (fid, state, effective, tier) => rows.unshift({ festival: fid, state, effective, tier, at: new Date().toISOString() }), groundReports: () => rows };
  const now = Date.UTC(2026, 8, 30, 15), fetchImpl = async () => json({ data: [{ date: '2026-09-29', daily_precip_in: 1.0 }, { date: '2026-09-30', daily_precip_in: 0.5 }] });
  const f = { ...fest, id: 'learn-test' }; const saved = [];
  assert.match((await reportGround(f, 'boggy', { now, fetchImpl, q })).error, /state must be one of/);
  const r = await reportGround(f, 'mud', { now, fetchImpl, q, save: x => saved.push(x) });
  assert.equal(r.ok, true); assert.equal(r.effective, 0.9, 'today and yesterday at their weights: 1.5 at 0.6'); assert.equal(rows[0].tier, 'soft', 'what the table said at the time');
  assert.equal(r.learned.threshold, 0.9); assert.equal(saved[0].ground.learned.threshold, 0.9, 'written onto the record');
  assert.deepEqual(reportSummary(q, f.id, now), { last: { state: 'mud', at: rows[0].at }, recent: 1 });
});

test('indoors or out: a building or a club under the point, the venue words in the listing, and the staff word over both', async () => {
  assert.equal(indoorFromTags({ building: 'yes', amenity: 'nightclub' }), true); assert.equal(indoorFromTags({ amenity: 'theatre' }), true); assert.equal(indoorFromTags({ leisure: 'sports_centre' }), true);
  assert.equal(indoorFromTags({ building: 'roof' }), null, 'a roof with no walls is not inside'); assert.equal(indoorFromTags({ leisure: 'park' }), null, 'a park says nothing about a roof on its own');
  assert.equal(indoorFromTags({ building: 'stadium' }), null, 'a stadium is open to the sky'); assert.equal(indoorFromTags({ building: 'pavilion' }), null, 'a pavilion is a roof on posts');
  assert.equal(indoorFromTags({ amenity: 'theatre', 'theatre:type': 'amphi' }), null, 'an amphitheater is a theatre with no roof');
  assert.equal(indoorFromTags({ amenity: 'events_venue' }), null, 'an events venue is as often a field as a hall'); assert.equal(indoorFromTags({ building: 'yes', amenity: 'events_venue' }), true, 'unless it is a building');
  assert.equal(indoorFromWords('Temple Tribal Fest - Playa Azul Playa Azul Nightclub, Temple, TX'), true);
  assert.equal(indoorFromWords('Suwannee Hulaween Spirit of the Suwannee Music Park, Live Oak, FL'), false);
  assert.equal(indoorFromWords('Music Hall at Fair Park, Dallas, TX'), true, 'the building word wins over the grounds it stands in');
  assert.equal(indoorFromWords('House of Blues, Dallas, TX'), null, 'nothing said: unknown, and unknown is treated as outdoors, the safe side');
  const club = await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { building: 'yes', amenity: 'nightclub', name: 'Playa Azul' } }]) });
  assert.deepEqual(club, { surface: null, low: false, camping: false, indoor: true, indoorTag: 'building=yes, amenity=nightclub', source: 'OpenStreetMap', tag: 'building=yes, amenity=nightclub' }, 'a club under the point: indoors, no ground to speak of');
  const looked = await lookupGround({ ...fest, location: 'Playa Azul Nightclub, Temple, TX' }, { fetchImpl: async url => String(url).includes('overpass') ? overpass([{ type: 'area', id: 1, tags: { building: 'yes', amenity: 'nightclub' } }]) : String(url).includes('mrlc') ? nlcd(23) : sda([['1', 'Urban land', 'Urban land', 'D', 'Well drained', '95']]) });
  assert.equal(looked.indoor, true); assert.equal(looked.indoorSource, 'OpenStreetMap: building=yes, amenity=nightclub');
  const e = effectiveGround({ name: 'Temple Tribal Fest', location: 'Playa Azul Nightclub, Temple, TX' });
  assert.equal(e.indoor, true); assert.equal(e.indoorSource, 'the listing');
  assert.equal(effectiveGround({ name: 'X', location: 'Playa Azul Nightclub', ground: { indoor: false, indoorSource: 'OpenStreetMap: leisure=park' } }).indoor, false, 'the lookup beats the words');
  // Wakaan at Mulberry Mountain: the pin falls on the lodge of a campground on a mountain. Any one thing that says outdoors beats the roof.
  const lodge = await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { building: 'yes', name: 'Lodge' } }, { type: 'area', id: 2, tags: { tourism: 'camp_site', name: 'Mulberry Mountain' } }]) });
  assert.deepEqual({ indoor: lodge.indoor, camping: lodge.camping }, { indoor: false, camping: true }, 'a building inside a campground is a building on the grounds');
  const mountain = effectiveGround({ name: 'Wakaan Music Festival', location: 'Mulberry Mountain, Ozark, AR', ground: { indoor: true, indoorSource: 'OpenStreetMap: building=yes' } });
  assert.equal(mountain.indoor, false); assert.equal(mountain.indoorSource, 'the listing', 'a mountain in the listing beats a roof under the pin');
  const camp = effectiveGround({ name: 'X', location: 'Somewhere, AR', camping: true, ground: { indoor: true, indoorSource: 'OpenStreetMap: building=yes' } });
  assert.equal(camp.indoor, false); assert.equal(camp.indoorSource, 'people camp here');
  assert.equal(effectiveGround({ name: 'X', location: 'Somewhere, AR', ground: { indoor: true, indoorSource: 'OpenStreetMap: building=yes, amenity=nightclub' } }).indoor, true, 'nothing says out: the roof stands');
  assert.equal(effectiveGround({ name: 'X', location: 'Mulberry Mountain', camping: true, ground: { indoor: true, override: validOverride({ indoor: true }).override } }).indoor, true, 'staff still have the last word');
  const over = effectiveGround({ name: 'X', location: 'Playa Azul Nightclub', ground: { indoor: true, override: validOverride({ indoor: 'false' }).override } });
  assert.equal(over.indoor, false); assert.equal(over.indoorSource, 'staff');
  assert.equal(validOverride({ indoor: true }).override.indoor, true); assert.equal(validOverride({}).override.indoor, undefined);
});
