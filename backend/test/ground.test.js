// The ground under a festival from free public data: OpenStreetMap land use, the USDA soil survey, the Mesonet's rain
// analysis, and the staff override on top. Every service is a fake here; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
const { effectiveGround, ensureGround, groundFor, learnedThreshold, lookupGround, pastRain, reportGround, reportSummary, soilFromUSDA, surfaceFromOSM, surfaceFromTags, validOverride } = await import('../src/ground.js');

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const fest = { id: 'ground-test', name: 'Ground Test', location: 'Live Oak, FL', latitude: 30.404, longitude: -82.9395, startDate: '2026-09-29T00:00:00Z', endDate: '2026-10-02T00:00:00Z' };
const overpass = elements => json({ version: 0.6, elements });
const sda = rows => json({ Table: [['mukey', 'muname', 'compname', 'hydgrp', 'drainagecl', 'comppct_r'], ...rows] });

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
  assert.deepEqual(s, { surface: 'grass', low: false, camping: false, source: 'OpenStreetMap', tag: 'leisure=park' }, 'the park (a use) beats the farmland (land cover)');
  assert.match(decodeURIComponent(calls[0].body), /is_in\(30\.40400,-82\.93950\)/); assert.equal(calls[0].ua, process.env.NWS_USER_AGENT);
  assert.equal(await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { boundary: 'administrative' } }]) }), null, 'nothing telling: null, not a guess');
  const camp = await surfaceFromOSM(0, 0, { fetchImpl: async () => overpass([{ type: 'area', id: 1, tags: { tourism: 'camp_site', name: 'Spirit of the Suwannee' } }, { type: 'area', id: 2, tags: { landuse: 'meadow' } }]) });
  assert.equal(camp.camping, true, 'a campground under the grounds: people camp here'); assert.equal(camp.surface, 'grass'); assert.equal(s.camping, false);
  await assert.rejects(surfaceFromOSM(0, 0, { fetchImpl: async () => new Response('busy', { status: 429 }) }), /Overpass 429/);
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
  assert.equal(g.surface, 'pavement'); assert.equal(g.surfaceSource, 'OpenStreetMap: surface=asphalt, amenity=parking'); assert.equal(g.soil, 'D'); assert.equal(g.soilName, 'Urban land'); assert.equal(g.lookupError, undefined);
  assert.equal(saved.length, 1); assert.equal(saved[0].ground.surface, 'pavement');
  const eff = effectiveGround(saved[0]);
  assert.deepEqual({ surface: eff.surface, soil: eff.soil, low: eff.low, structures: eff.structures, surfaceSource: eff.surfaceSource }, { surface: 'pavement', soil: 'D', low: false, structures: ['canopies'], surfaceSource: 'OpenStreetMap: surface=asphalt, amenity=parking' });
  assert.deepEqual(effectiveGround({}), { surface: 'grass', soil: 'B', low: false, structures: ['canopies'], camping: null, campingSource: 'unknown', surfaceSource: 'assumed', soilSource: 'assumed', soilName: null, drainage: null, lookedUpAt: null, lookupError: null, override: null, learned: null }, 'nothing known: trampled grass on average soil, and nobody knows if people camp');
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
  const half = await lookupGround(fest, { fetchImpl: async url => String(url).includes('overpass') ? new Response('no', { status: 504 }) : sda([['1', 'Blanton fine sand', 'Blanton', 'A', 'Well drained', '90']]) });
  assert.equal(half.surface, undefined); assert.equal(half.soil, 'A'); assert.match(half.lookupError, /surface: Overpass 504/);
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
