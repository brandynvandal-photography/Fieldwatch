import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmEvent, tmVenue, tmPage } from './fixtures/ticketmaster.js';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
delete process.env.TICKETMASTER_KEY; delete process.env.FESTIVAL_FEEDS;

const { q } = await import('../src/db.js');
const { seedAll } = await import('../src/seed.js');
const { candidate, festivalsFrom, normalizeName, importTicketmaster } = await import('../src/importers/ticketmaster.js');
const { parseCSV, recordsFrom, importFeeds } = await import('../src/importers/feeds.js');
const { normalizeFestival, sameFestival } = await import('../src/festivals.js');
const { runImports } = await import('../src/importers/index.js');
seedAll();
const NOW = Date.parse('2026-09-28T12:00:00Z');

const moonrise = [
  tmEvent(),
  tmEvent({ name: 'Moonrise Fest - Saturday', dates: { start: { localDate: '2026-10-10', dateTime: '2026-10-10T17:00:00Z' } } }),
  tmEvent({ name: 'Moonrise Fest - Sunday', dates: { start: { localDate: '2026-10-11', dateTime: '2026-10-11T17:00:00Z' } } }),
  tmEvent({ name: 'Moonrise Fest 3 Day Pass', dates: { start: { localDate: '2026-10-09', dateTime: '2026-10-09T17:00:00Z' }, end: { localDate: '2026-10-11' } } }),
  tmEvent({ name: 'Moonrise Fest Parking' }),
  // Not a festival by name, one act, not styled one: whatever matched the keyword, it is a concert.
  tmEvent({ name: 'Moonrise Gathering of the Tribute Bands', _embedded: { venues: [tmVenue()], attractions: [{}] } }),
];
const others = [
  // Ticketmaster styles it a festival even though the name does not say so.
  tmEvent({ name: 'Big Sky Jam', classifications: [{ primary: true, segment: { name: 'Music' }, type: { name: 'Event Style' }, subType: { name: 'Festival' } }],
    dates: { start: { localDate: '2026-11-13', dateTime: '2026-11-13T22:00:00Z' }, end: { localDate: '2026-11-15', dateTime: '2026-11-16T05:00:00Z' } },
    _embedded: { venues: [tmVenue({ id: 'v-bigsky', name: 'Riverfront Park', city: { name: 'Missoula' }, state: { stateCode: 'MT' }, location: { latitude: '46.87', longitude: '-113.99' } })], attractions: [{}, {}] } }),
  // A lineup is a festival whatever the name says.
  tmEvent({ name: 'Riverbend Roots Weekend', dates: { start: { localDate: '2026-12-04' } },
    _embedded: { venues: [tmVenue({ id: 'v-river', name: 'Riverbend Farm', city: { name: 'Athens' }, state: { stateCode: 'GA' }, location: { latitude: '33.95', longitude: '-83.38' } })], attractions: [{}, {}, {}, {}, {}, {}] } }),
  // Not festivals: a concert at a venue with "Festival" in its name, a sports event, a test listing, no coordinates.
  tmEvent({ name: 'The Chill Band at Festival Pier', _embedded: { venues: [tmVenue({ id: 'v-pier', name: 'Festival Pier', location: { latitude: '39.96', longitude: '-75.14' } })], attractions: [{}] } }),
  tmEvent({ name: 'Fall Fest Tailgate', classifications: [{ primary: true, segment: { name: 'Sports' } }] }),
  tmEvent({ name: 'Test Fest', test: true }),
  tmEvent({ name: 'Nowhere Fest', _embedded: { venues: [{ id: 'v-none', name: 'TBA' }] } }),
  // Already curated: same grounds, same dates as Suwannee Hulaween.
  tmEvent({ name: 'Suwannee Hulaween 2026', dates: { start: { localDate: '2026-10-22', dateTime: '2026-10-22T16:00:00Z' }, end: { localDate: '2026-10-25' } },
    _embedded: { venues: [tmVenue({ id: 'v-sosmp', name: 'Spirit of the Suwannee Music Park', city: { name: 'Live Oak' }, state: { stateCode: 'FL' }, location: { latitude: '30.4045', longitude: '-82.9390' } })], attractions: [{}, {}, {}, {}, {}] } }),
];

test('per-day listings fold into one festival and add-ons, venues, sports and test rows are dropped', () => {
  assert.equal(normalizeName('Moonrise Fest - Friday'), normalizeName('Moonrise Fest 3 Day Pass'));
  assert.equal(candidate(moonrise[4]), null, 'parking is not a festival');
  const list = festivalsFrom([...moonrise, ...others], '2026-09-28');
  assert.deepEqual(list.map(f => f.name).sort(), ['Big Sky Jam', 'Moonrise Fest', 'Riverbend Roots Weekend', 'Suwannee Hulaween']);
  const m = list.find(f => f.name === 'Moonrise Fest');
  assert.equal(m.id, 'tm-moonrise-fest-2026');
  assert.equal(m.startDate, '2026-10-09T17:00:00Z', 'earliest listing starts it');
  assert.equal(m.endDate, '2026-10-12T08:00:00Z', 'the last day runs into the small hours after it');
  assert.equal(m.location, 'Mulberry Mountain, Ozark, AR');
  assert.equal(m.latitude, 35.6981); assert.equal(m.longitude, -93.7793);
  assert.equal(m.origin, 'ticketmaster'); assert.equal(m.status, 'published'); assert.equal(m.featured, false);
  assert.equal(m.county, ''); assert.deepEqual(m.feeds, []); assert.deepEqual(m.site, []); assert.equal(m.isPartner, false);
  assert.equal(m.website, 'https://www.ticketmaster.com/moonrise-fest-friday/event/1');
  const big = list.find(f => f.name === 'Big Sky Jam');
  assert.equal(big.endDate, '2026-11-16T05:00:00Z', 'an explicit end time is kept');
  const river = list.find(f => f.name === 'Riverbend Roots Weekend');
  assert.equal(river.startDate, '2026-12-04T16:00:00Z', 'a listing with only a date gets an afternoon start');
  assert.equal(river.endDate, '2026-12-05T08:00:00Z');
});

test('the import walks a year in monthly windows with two nets, skips what is curated, and prunes what vanished', async () => {
  const calls = [];
  let serve = (u) => tmPage([]);
  const fetchImpl = async (u) => {
    const url = new URL(u); calls.push(url);
    assert.match(url.searchParams.get('apikey'), /^k-/); assert.equal(url.searchParams.get('size'), '200'); assert.equal(url.searchParams.get('countryCode'), 'US');
    const body = serve(url);
    return new Response(JSON.stringify(body), { status: body.status || 200, headers: { 'content-type': 'application/json' } });
  };
  serve = url => {
    const w0 = url.searchParams.get('startDateTime') === '2026-09-28T12:00:00Z';
    if (!w0) return tmPage([]);
    if (url.searchParams.get('keyword') === 'festival') return tmPage([...moonrise, ...others]);
    // The second net pages: two pages, the second holding a festival the first net missed.
    return url.searchParams.get('page') === '0' ? tmPage([], { totalPages: 2 }) : tmPage([tmEvent({ name: 'Hidden Hollow', dates: { start: { localDate: '2026-10-17' } },
      classifications: [{ primary: true, segment: { name: 'Music' }, type: { name: 'Event Style' }, subType: { name: 'Festival' } }],
      _embedded: { venues: [tmVenue({ id: 'v-hh', name: 'Hollow Farm', city: { name: 'Floyd' }, state: { stateCode: 'VA' }, location: { latitude: '36.91', longitude: '-80.32' } })] } })], { page: 1, totalPages: 2 });
  };
  const r = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.equal(r.calls, 25, '12 windows, two nets each, one of them two pages');
  assert.equal(r.errors, 0);
  assert.deepEqual({ added: r.added, updated: r.updated, duplicates: r.duplicates, pruned: r.pruned }, { added: 4, updated: 0, duplicates: 1, pruned: 0 });
  assert.ok(calls.some(u => u.searchParams.get('classificationName') === 'Music' && u.searchParams.get('keyword') === 'festival'));
  assert.ok(calls.some(u => u.searchParams.get('classificationName') === 'Festival' && u.searchParams.get('page') === '1'));
  assert.equal(calls.filter(u => u.searchParams.get('startDateTime') === '2026-09-28T12:00:00Z').length, 3);
  const published = q.publishedFestivals();
  assert.equal(published.filter(f => f.origin === 'ticketmaster').length, 4);
  assert.equal(published.filter(f => /hulaween/i.test(f.name)).length, 1, 'the curated Hulaween is not listed twice');
  assert.equal(published.find(f => /hulaween/i.test(f.name)).origin, 'curated');

  // An admin features an imported festival; the next run keeps that, updates dates, and prunes a listing that vanished before it started.
  const hh = q.festival('tm-hidden-hollow-2026');
  q.upsertFestival({ ...hh, featured: true, county: 'Floyd County' });
  serve = url => {
    if (url.searchParams.get('startDateTime') !== '2026-09-28T12:00:00Z') return tmPage([]);
    if (url.searchParams.get('keyword') === 'festival') return tmPage([...moonrise.map(e => ({ ...e, dates: { start: { localDate: '2026-10-16', dateTime: '2026-10-16T17:00:00Z' } } }))]);
    return tmPage([tmEvent({ name: 'Hidden Hollow', dates: { start: { localDate: '2026-10-17' } },
      classifications: [{ primary: true, segment: { name: 'Music' }, type: { name: 'Event Style' }, subType: { name: 'Festival' } }],
      _embedded: { venues: [tmVenue({ id: 'v-hh', location: { latitude: '36.91', longitude: '-80.32' } })] } })]);
  };
  const r2 = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0 });
  assert.deepEqual({ added: r2.added, updated: r2.updated, pruned: r2.pruned }, { added: 0, updated: 2, pruned: 2 });
  assert.equal(q.festival('tm-big-sky-jam-2026'), null, 'gone from the API before it started: cancelled');
  assert.equal(q.festival('tm-moonrise-fest-2026').startDate, '2026-10-16T17:00:00Z', 'moved dates follow the listing');
  assert.equal(q.festival('tm-hidden-hollow-2026').featured, true, 'what the admin set stays');
  assert.equal(q.festival('tm-hidden-hollow-2026').county, 'Floyd County');

  // A run with fetch errors never prunes on absence; it only knows what it managed to fetch.
  serve = url => (url.searchParams.get('keyword') === 'festival' ? { status: 500 } : tmPage([]));
  const r3 = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.equal(r3.errors, 12); assert.equal(r3.pruned, 0);
  assert.ok(q.festival('tm-moonrise-fest-2026'), 'kept through a bad run');

  // Without a key the source is skipped, and the error line never carries the key.
  assert.deepEqual(await importTicketmaster({ key: '', fetchImpl }), { skipped: 'TICKETMASTER_KEY not set' });
  const lines = [];
  serve = () => ({ status: 401 });
  await importTicketmaster({ key: 'k-secret', fetchImpl, now: NOW, pauseMs: 0, log: { error: m => lines.push(m) } });
  assert.ok(lines.length && lines.every(l => !l.includes('k-secret')));
});

test('a feed is a CSV or JSON file anywhere: sheet column names, quoted commas, bare dates', async () => {
  assert.deepEqual(parseCSV('a,b\n1,"x, y"\n"2 ""two""",z\n'), [{ a: '1', b: 'x, y' }, { a: '2 "two"', b: 'z' }]);
  const csv = 'Festival,Where,Lat,Lon,First day,Last day,Website\n"Bayou Bash, Vol. 3","Fontainebleau State Park, Mandeville, LA",30.34,-90.03,10/30/2026,11/1/2026,bayoubash.org\nNo Place,,,,2026-10-01,2026-10-02,\n';
  const json = JSON.stringify([{ id: 'hulaween-2026', name: 'Suwannee Hulaween', location: 'Spirit of the Suwannee Music Park, Live Oak, FL', latitude: 30.404, longitude: -82.9395, startDate: '2026-10-22T14:00:00Z', endDate: '2026-10-26T04:00:00Z', featured: true, county: 'Suwannee County', website: 'https://suwanneehulaween.com/' }]);
  const fetchImpl = async u => new Response(String(u).endsWith('.csv') ? csv : json, { status: 200 });
  const r = await importFeeds({ urls: ['https://sheets.example/list.csv', 'https://repo.example/list.json'], fetchImpl, log: { error: () => {} } });
  assert.equal(r.rows, 3); assert.equal(r.saved, 2);
  assert.deepEqual(r.rejected, [{ name: 'No Place', error: 'location required' }]);
  const b = q.festival('feed-bayou-bash-vol-3-2026');
  assert.equal(b.name, 'Bayou Bash, Vol. 3'); assert.equal(b.origin, 'feed'); assert.equal(b.featured, false);
  assert.equal(b.startDate, '2026-10-30T12:00:00Z'); assert.equal(b.endDate, '2026-11-02T08:00:00Z', 'a bare last day lasts through the night');
  assert.equal(b.website, 'https://bayoubash.org/');
  assert.equal(q.festival('hulaween-2026').origin, 'curated', 'a feed row can edit a curated festival without changing what it is');
  assert.equal(q.festival('hulaween-2026').website, 'https://suwanneehulaween.com/');
  assert.deepEqual(await importFeeds({ urls: [], fetchImpl }), { skipped: 'FESTIVAL_FEEDS not set' });
  const bad = await importFeeds({ urls: ['https://down.example/x.csv'], fetchImpl: async () => new Response('', { status: 503 }), log: { error: () => {} } });
  assert.equal(bad.rejected[0].error, 'HTTP 503');
});

test('isLive: grounds open a week out, or when the festival says, through the day after the end', async () => {
  const { isLive, opensAt } = await import('../src/festivals.js');
  const f = { startDate: '2026-10-22T14:00:00Z', endDate: '2026-10-26T04:00:00Z' };
  const t = s => Date.parse(s);
  assert.equal(isLive(f, t('2026-10-14T14:00:00Z')), false, 'eight days out: not yet');
  assert.equal(isLive(f, t('2026-10-15T15:00:00Z')), true, 'seven days out: build crews and early entry');
  assert.equal(isLive(f, t('2026-10-24T00:00:00Z')), true);
  assert.equal(isLive(f, t('2026-10-27T03:00:00Z')), true, 'the day after: exodus and teardown');
  assert.equal(isLive(f, t('2026-10-27T05:00:00Z')), false);
  const g = { ...f, groundsOpen: '2026-10-08T12:00:00Z' };
  assert.equal(opensAt(g), t('2026-10-08T12:00:00Z')); assert.equal(isLive(g, t('2026-10-09T00:00:00Z')), true, 'a two-week build is on from when the festival says');
  const { festival } = normalizeFestival({ name: 'X', location: 'Y', latitude: 1, longitude: 2, startDate: '2026-10-22', endDate: '2026-10-25', groundsOpen: '2026-10-19' });
  assert.equal(festival.groundsOpen, '2026-10-19T12:00:00Z');
  assert.equal(normalizeFestival({ name: 'X', location: 'Y', latitude: 1, longitude: 2, startDate: '2026-10-22', endDate: '2026-10-25', groundsOpen: '2026-10-23' }).festival.groundsOpen, undefined, 'grounds cannot open after gates');
});

test('normalizeFestival is the one gate: defaults, ranges, urls, and what a base record keeps', () => {
  assert.deepEqual(normalizeFestival({}), { error: 'name required' });
  assert.deepEqual(normalizeFestival({ name: 'X', location: 'Y', latitude: 91, longitude: 0, startDate: '2026-10-01', endDate: '2026-10-02' }), { error: 'latitude must be a number in range' });
  assert.deepEqual(normalizeFestival({ name: 'X', location: 'Y', latitude: 1, longitude: 2, startDate: '2026-10-03', endDate: '2026-10-02' }), { error: 'endDate is before startDate' });
  const { festival } = normalizeFestival({ name: '  Dusk Ridge ', location: 'Somewhere, CO', latitude: '39.5', longitude: '-105.1', startDate: '2026-10-01', endDate: '2026-10-01', website: 'javascript:alert(1)' });
  assert.equal(festival.id, 'dusk-ridge-2026'); assert.equal(festival.name, 'Dusk Ridge'); assert.equal(festival.latitude, 39.5);
  assert.equal(festival.website, undefined, 'only http(s) links are kept');
  assert.equal(festival.featured, true, 'curated is featured unless told otherwise');
  const base = { id: 'keep-me', origin: 'community', status: 'pending', name: 'Old', location: 'L', latitude: 1, longitude: 2, startDate: '2026-10-01T12:00:00Z', endDate: '2026-10-02T08:00:00Z' };
  const edited = normalizeFestival({ name: 'New name', county: 'Some County' }, { base }).festival;
  assert.equal(edited.id, 'keep-me'); assert.equal(edited.origin, 'community'); assert.equal(edited.status, 'pending'); assert.equal(edited.name, 'New name'); assert.equal(edited.featured, false);
  assert.ok(sameFestival(base, { ...base, latitude: 1.01 }), 'a kilometre apart on the same days is the same festival');
  assert.ok(!sameFestival(base, { ...base, name: 'Other', latitude: 1.5 }), 'fifty kilometres apart is not');
  assert.ok(!sameFestival(base, { ...base, latitude: 1.01, startDate: '2026-11-01T12:00:00Z', endDate: '2026-11-02T08:00:00Z' }), 'the same grounds a month later is not');
});

test('runImports reports every source and joins a run already in progress', async () => {
  const [a, b] = await Promise.all([runImports(), runImports()]);
  assert.equal(a, b);
  assert.equal(a.ticketmaster.skipped, 'TICKETMASTER_KEY not set'); assert.equal(a.feeds.skipped, 'FESTIVAL_FEEDS not set');
  assert.ok(a.startedAt && a.finishedAt);
});
