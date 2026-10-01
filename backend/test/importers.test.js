import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmEvent, tmVenue, tmPage } from './fixtures/ticketmaster.js';
import { sgEvent, sgVenue } from './fixtures/seatgeek.js';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
delete process.env.TICKETMASTER_KEY; delete process.env.SEATGEEK_CLIENT_ID; delete process.env.EDMTRAIN_KEY; delete process.env.FESTIVAL_FEEDS;
process.env.WIKIDATA_IMPORT = 'false';   // on by default and keyless; its own suite covers it with a fake endpoint

const { q } = await import('../src/db.js');
const { seedAll } = await import('../src/seed.js');
const { candidate, festivalsFrom, normalizeName, importTicketmaster } = await import('../src/importers/ticketmaster.js');
const { parseCSV, recordsFrom, importFeeds } = await import('../src/importers/feeds.js');
const { normalizeFestival, sameFestival } = await import('../src/festivals.js');
const { applyImport, outranks } = await import('../src/importers/common.js');
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

test('the import walks a year in monthly windows with three nets, skips what is curated, and prunes what vanished', async () => {
  const calls = [];
  let serve = (u) => tmPage([]);
  const fetchImpl = async (u) => {
    const url = new URL(u); calls.push(url);
    assert.match(url.searchParams.get('apikey'), /^k-/); assert.equal(url.searchParams.get('size'), '200'); assert.equal(url.searchParams.get('countryCode'), 'US');
    const body = serve(url);
    return new Response(JSON.stringify(body), { status: body.status || 200, headers: { 'content-type': 'application/json', ...(body.retryAfter ? { 'retry-after': body.retryAfter } : {}) } });
  };
  // Front Gate's net: a festival with no "fest" in its name and the festival itself as its only attraction, and a parking add-on.
  const frontgate = [
    tmEvent({ name: 'Electric Forest', url: 'https://www.frontgatetickets.com/event/electric-forest', dates: { start: { localDate: '2026-10-20', dateTime: '2026-10-20T16:00:00Z' }, end: { localDate: '2026-10-23' } },
      _embedded: { venues: [tmVenue({ id: 'v-double-jj', name: 'Double JJ Resort', city: { name: 'Rothbury' }, state: { stateCode: 'MI' }, location: { latitude: '43.51', longitude: '-86.31' } })], attractions: [{ name: 'Electric Forest' }] } }),
    tmEvent({ name: 'Electric Forest Parking', url: 'https://www.frontgatetickets.com/event/electric-forest-parking' }),
  ];
  serve = url => {
    const w0 = url.searchParams.get('startDateTime') === '2026-09-28T12:00:00Z';
    if (!w0) return tmPage([]);
    if (url.searchParams.get('source') === 'frontgate') return tmPage(frontgate);
    if (url.searchParams.get('keyword') === 'festival') return tmPage([...moonrise, ...others]);
    // The second net pages: two pages, the second holding a festival the first net missed.
    return url.searchParams.get('page') === '0' ? tmPage([], { totalPages: 2 }) : tmPage([tmEvent({ name: 'Hidden Hollow', dates: { start: { localDate: '2026-10-17' } },
      classifications: [{ primary: true, segment: { name: 'Music' }, type: { name: 'Event Style' }, subType: { name: 'Festival' } }],
      _embedded: { venues: [tmVenue({ id: 'v-hh', name: 'Hollow Farm', city: { name: 'Floyd' }, state: { stateCode: 'VA' }, location: { latitude: '36.91', longitude: '-80.32' } })] } })], { page: 1, totalPages: 2 });
  };
  const r = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.equal(r.calls, 37, '12 windows, three nets each, one of them two pages');
  assert.equal(r.errors, 0);
  assert.deepEqual({ added: r.added, updated: r.updated, duplicates: r.duplicates, pruned: r.pruned }, { added: 5, updated: 0, duplicates: 1, pruned: 0 });
  assert.equal(r.frontgate, 2); assert.deepEqual(r.hosts, { 'ticketmaster.com': 5, 'frontgatetickets.com': 1 }, 'counted before the curated duplicate is dropped');
  assert.ok(calls.some(u => u.searchParams.get('classificationName') === 'Music' && u.searchParams.get('keyword') === 'festival' && !u.searchParams.has('source')), 'the wide nets span every source');
  assert.ok(calls.some(u => u.searchParams.get('classificationName') === 'Festival' && u.searchParams.get('page') === '1'));
  assert.ok(calls.some(u => u.searchParams.get('source') === 'frontgate' && u.searchParams.get('classificationName') === 'Music' && !u.searchParams.has('keyword')), 'Front Gate: every music listing, no name filter');
  assert.equal(calls.filter(u => u.searchParams.get('startDateTime') === '2026-09-28T12:00:00Z').length, 4);
  const ef = q.festival('tm-electric-forest-2026');
  assert.ok(ef, 'a Front Gate listing counts as a festival without "fest" in its name');
  assert.equal(ef.endDate, '2026-10-24T08:00:00Z'); assert.equal(ef.location, 'Double JJ Resort, Rothbury, MI');
  assert.equal(candidate(frontgate[0]), null, 'the same listing from the wide nets alone would not have passed');
  const published = q.publishedFestivals();
  assert.equal(published.filter(f => f.origin === 'ticketmaster').length, 5);
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
  assert.deepEqual({ added: r2.added, updated: r2.updated, pruned: r2.pruned }, { added: 0, updated: 2, pruned: 3 });
  assert.equal(q.festival('tm-big-sky-jam-2026'), null, 'gone from the API before it started: canceled');
  assert.equal(q.festival('tm-electric-forest-2026'), null, 'same for a Front Gate listing');
  assert.equal(q.festival('tm-moonrise-fest-2026').startDate, '2026-10-16T17:00:00Z', 'moved dates follow the listing');
  assert.equal(q.festival('tm-hidden-hollow-2026').featured, true, 'what the admin set stays');
  assert.equal(q.festival('tm-hidden-hollow-2026').county, 'Floyd County');

  // A rate limit is waited out, not counted: the call is made again after the pause the site asks for.
  const prev = serve; let limited = 0;
  serve = url => (url.searchParams.get('keyword') === 'festival' && limited === 0 && ++limited ? { status: 429, retryAfter: '1' } : prev(url));
  const r429 = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {}, warn: () => {} } });
  assert.equal(r429.errors, 0); assert.equal(limited, 1); assert.equal(r429.pruned, 0, 'the same listings as before, nothing vanished');

  // A run with fetch errors never prunes on absence; it only knows what it managed to fetch.
  serve = url => (url.searchParams.get('keyword') === 'festival' ? { status: 500 } : tmPage([]));
  const r3 = await importTicketmaster({ key: 'k-test', fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.equal(r3.errors, 12); assert.equal(r3.pruned, 0); assert.match(r3.lastError, /500/, 'the report says what went wrong');
  assert.equal(r3.gaveUp, undefined, 'one net failing among two that work is not a dead host');

  // A host that is down is not asked 36 times.
  const dead = await importTicketmaster({ key: 'k-test', fetchImpl: async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect timeout'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); }, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.deepEqual({ errors: dead.errors, gaveUp: dead.gaveUp, lastError: dead.lastError, pruned: dead.pruned }, { errors: 6, gaveUp: true, lastError: 'fetch failed (UND_ERR_CONNECT_TIMEOUT)', pruned: 0 });
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
  const { festival } = normalizeFestival({ name: 'X', location: 'Y', latitude: 39.5, longitude: -105.1, startDate: '2026-10-22', endDate: '2026-10-25', groundsOpen: '2026-10-19' });
  assert.equal(festival.groundsOpen, '2026-10-19T12:00:00Z');
  assert.equal(normalizeFestival({ name: 'X', location: 'Y', latitude: 39.5, longitude: -105.1, startDate: '2026-10-22', endDate: '2026-10-25', groundsOpen: '2026-10-23' }).festival.groundsOpen, undefined, 'grounds cannot open after gates');
});

test('normalizeFestival is the one gate: defaults, ranges, urls, and what a base record keeps', () => {
  assert.deepEqual(normalizeFestival({}), { error: 'name required' });
  assert.deepEqual(normalizeFestival({ name: 'X', location: 'Y', latitude: 91, longitude: 0, startDate: '2026-10-01', endDate: '2026-10-02' }), { error: 'latitude must be a number in range' });
  assert.deepEqual(normalizeFestival({ name: 'X', location: 'Y', latitude: 39.5, longitude: -105.1, startDate: '2026-10-03', endDate: '2026-10-02' }), { error: 'endDate is before startDate' });
  assert.match(normalizeFestival({ name: 'X', location: 'Y', latitude: 1, longitude: 2, startDate: '2026-10-01', endDate: '2026-10-02' }).error, /outside the National Weather Service area/);
  const { festival } = normalizeFestival({ name: '  Dusk Ridge ', location: 'Somewhere, CO', latitude: '39.5', longitude: '-105.1', startDate: '2026-10-01', endDate: '2026-10-01', website: 'javascript:alert(1)' });
  assert.equal(festival.id, 'dusk-ridge-2026'); assert.equal(festival.name, 'Dusk Ridge'); assert.equal(festival.latitude, 39.5);
  assert.equal(festival.website, undefined, 'only http(s) links are kept');
  assert.equal(festival.featured, true, 'curated is featured unless told otherwise');
  const base = { id: 'keep-me', origin: 'community', status: 'pending', name: 'Old', location: 'L', latitude: 39.5, longitude: -105.1, startDate: '2026-10-01T12:00:00Z', endDate: '2026-10-02T08:00:00Z' };
  const edited = normalizeFestival({ name: 'New name', county: 'Some County' }, { base }).festival;
  assert.equal(edited.id, 'keep-me'); assert.equal(edited.origin, 'community'); assert.equal(edited.status, 'pending'); assert.equal(edited.name, 'New name'); assert.equal(edited.featured, false);
  assert.ok(sameFestival(base, { ...base, latitude: 1.01 }), 'a kilometer apart on the same days is the same festival');
  assert.ok(!sameFestival(base, { ...base, name: 'Other', latitude: 1.5 }), 'fifty kilometers apart is not');
  assert.ok(!sameFestival(base, { ...base, latitude: 1.01, startDate: '2026-11-01T12:00:00Z', endDate: '2026-11-02T08:00:00Z' }), 'the same grounds a month later is not');
});

test('runImports reports every source and joins a run already in progress', async () => {
  const [a, b] = await Promise.all([runImports(), runImports()]);
  assert.equal(a, b);
  assert.equal(a.ticketmaster.skipped, 'TICKETMASTER_KEY not set'); assert.equal(a.feeds.skipped, 'FESTIVAL_FEEDS not set');
  assert.equal(a.wikidata.skipped, 'WIKIDATA_IMPORT=false');
  assert.ok(a.startedAt && a.finishedAt);
});

// ---- SeatGeek and Edmtrain share the folding and the write path with Ticketmaster ------------------------

test('SeatGeek: music_festival listings fold into festivals, other types and other countries are dropped, pages are walked', async () => {
  const { sgEvent, sgVenue, sgPage } = await import('./fixtures/seatgeek.js');
  const { festivalsFrom: sgFrom, importSeatGeek } = await import('../src/importers/seatgeek.js');
  const listings = [
    sgEvent(),
    sgEvent({ title: 'Moonrise Fest - Saturday', datetime_utc: '2026-10-10T17:00:00' }),
    sgEvent({ title: 'Moonrise Fest 2 Day Pass', datetime_utc: '2026-10-09T17:00:00', enddatetime_utc: '2026-10-11T06:00:00' }),
    sgEvent({ title: 'Moonrise Fest Camping' }),
    sgEvent({ title: 'Some Band', type: 'concert', taxonomies: [{ id: 2000000, name: 'concert' }] }),
    sgEvent({ title: 'Osheaga', venue: sgVenue({ id: 77, name: 'Parc Jean-Drapeau', city: 'Montreal', state: 'QC', country: 'CA', location: { lat: 45.51, lon: -73.53 } }) }),
    sgEvent({ title: 'Someday Fest', date_tbd: true }),
    sgEvent({ title: 'Lost Fest', venue: sgVenue({ id: 78, location: { lat: 0, lon: 0 } }) }),
    sgEvent({ title: 'Quiet Hollow', time_tbd: true, datetime_utc: '2026-12-05T03:30:00', datetime_local: '2026-12-04T22:30:00',
      venue: sgVenue({ id: 79, name: 'Hollow Farm', city: 'Floyd', state: 'VA', location: { lat: 36.91, lon: -80.32 } }) }),
  ];
  const list = sgFrom(listings, '2026-09-28');
  assert.deepEqual(list.map(f => f.name).sort(), ['Moonrise Fest', 'Quiet Hollow']);
  const m = list.find(f => f.name === 'Moonrise Fest');
  assert.equal(m.id, 'sg-moonrise-fest-2026'); assert.equal(m.origin, 'seatgeek');
  assert.equal(m.startDate, '2026-10-09T17:00:00Z', 'a zoneless SeatGeek stamp is UTC');
  assert.equal(m.endDate, '2026-10-11T08:00:00Z', 'the later of the pass end and the last day');
  assert.equal(m.location, 'Mulberry Mountain, Ozark, AR'); assert.equal(m.website, 'https://seatgeek.com/moonrise-fest-friday-tickets/1');
  const qh = list.find(f => f.name === 'Quiet Hollow');
  assert.equal(qh.startDate, '2026-12-04T16:00:00Z', 'time to be announced: the local date, mid-afternoon');

  // Ticketmaster lists Moonrise Fest on the same grounds and dates (an earlier test moved it; put it back).
  q.upsertFestival({ ...q.festival('tm-moonrise-fest-2026'), startDate: '2026-10-09T17:00:00Z', endDate: '2026-10-12T08:00:00Z' });
  const calls = [];
  const fetchImpl = async u => {
    const url = new URL(u); calls.push(url);
    assert.equal(url.searchParams.get('taxonomies.name'), 'music_festival'); assert.equal(url.searchParams.get('venue.country'), 'US'); assert.ok(url.searchParams.get('client_id'));
    const page = Number(url.searchParams.get('page'));
    const body = page === 1 ? sgPage(listings, { page: 1, total: 101 }) : sgPage([sgEvent({ title: 'Page Two Fest', datetime_utc: '2027-01-15T20:00:00', venue: sgVenue({ id: 80, location: { lat: 30.2, lon: -97.7 }, city: 'Austin', state: 'TX' }) })], { page: 2, total: 101 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await importSeatGeek({ clientId: 'sg-test', fetchImpl, now: NOW, pauseMs: 0 });
  assert.equal(r.calls, 2, 'total says there is a second page');
  assert.deepEqual({ added: r.added, duplicates: r.duplicates, errors: r.errors }, { added: 2, duplicates: 1, errors: 0 });
  assert.ok(q.festival('sg-page-two-fest-2027'));
  assert.equal(q.festival('sg-moonrise-fest-2026'), null, 'Ticketmaster already lists Moonrise Fest on those grounds, so SeatGeek does not add it twice');
  assert.equal(q.publishedFestivals().filter(f => /moonrise fest/i.test(f.name)).length, 1);

  const lines = [];
  const bad = await importSeatGeek({ clientId: 'sg-secret', fetchImpl: async () => new Response('', { status: 403 }), now: NOW, pauseMs: 0, log: { error: m => lines.push(m) } });
  assert.equal(bad.errors, 1); assert.equal(bad.pruned, 0, 'nothing pruned on a bad run'); assert.match(bad.lastError, /^SeatGeek 403/);
  const down = await importSeatGeek({ clientId: 'sg-secret', fetchImpl: async () => { const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error('getaddrinfo ENOTFOUND api.seatgeek.com'), { code: 'ENOTFOUND' }); throw e; }, now: NOW, pauseMs: 0, log: { error: () => {} } });
  assert.equal(down.lastError, 'fetch failed (ENOTFOUND)', 'the cause Node hides behind "fetch failed" is in the report');
  assert.ok(lines.length && lines.every(l => !l.includes('sg-secret')));
  assert.deepEqual(await importSeatGeek({ clientId: '', fetchImpl }), { skipped: 'SEATGEEK_CLIENT_ID not set' });
});

test('Edmtrain: one request, festivals only, US only, the event link kept as given', async () => {
  const { edmEvent, edmVenue, edmBody } = await import('./fixtures/edmtrain.js');
  const { festivalsFrom: edmFrom, importEdmtrain } = await import('../src/importers/edmtrain.js');
  const data = [
    edmEvent(),
    edmEvent({ name: 'Beyond Wonderland Sacramento - Day 2', date: '2026-11-08', link: 'https://edmtrain.com/sacramento?event=700002' }),
    edmEvent({ name: 'Beyond Wonderland Sacramento Shuttle', date: '2026-11-07' }),
    edmEvent({ name: 'Some DJ', festivalInd: false }),
    edmEvent({ name: 'Northern Lights Fest', venue: edmVenue({ id: 901, name: 'Somewhere', location: 'Toronto, ON', state: 'Ontario', latitude: 43.65, longitude: -79.38 }) }),
    edmEvent({ name: 'Stream Fest', livestreamInd: true }),
    edmEvent({ name: 'No Map Fest', venue: edmVenue({ id: 902, latitude: null, longitude: null }) }),
    edmEvent({ name: 'Bayou Bass', date: '2026-12-12', link: 'https://edmtrain.com/new-orleans?event=700009', venue: edmVenue({ id: 903, name: 'The Fillmore', location: 'New Orleans, LA', state: 'LA', latitude: 29.95, longitude: -90.07 }) }),
  ];
  const list = edmFrom(data, '2026-09-28');
  assert.deepEqual(list.map(f => f.name).sort(), ['Bayou Bass', 'Beyond Wonderland Sacramento']);
  const bw = list.find(f => f.name === 'Beyond Wonderland Sacramento');
  assert.equal(bw.id, 'edm-beyond-wonderland-sacramento-2026'); assert.equal(bw.origin, 'edmtrain');
  assert.equal(bw.startDate, '2026-11-07T16:00:00Z'); assert.equal(bw.endDate, '2026-11-09T08:00:00Z', 'two daily listings make a two-day festival');
  assert.equal(bw.source, 'https://edmtrain.com/sacramento?event=700001', 'the first listing\'s link, as the API gave it');
  assert.equal(bw.location, 'Discovery Park, Sacramento, CA');
  assert.equal(list.find(f => f.name === 'Bayou Bass').location, 'The Fillmore, New Orleans, LA', 'a two-letter state passes the US check too');

  const calls = [];
  const fetchImpl = async u => {
    const url = new URL(u); calls.push(url);
    assert.equal(url.searchParams.get('festivalInd'), 'true'); assert.equal(url.searchParams.get('startDate'), '2026-09-28'); assert.ok(url.searchParams.get('client'));
    return new Response(JSON.stringify(edmBody(data)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const r = await importEdmtrain({ key: 'edm-test', fetchImpl, now: NOW });
  assert.equal(r.calls, 1); assert.equal(r.events, data.length);
  assert.deepEqual({ added: r.added, duplicates: r.duplicates, errors: r.errors }, { added: 2, duplicates: 0, errors: 0 });
  assert.ok(q.festival('edm-bayou-bass-2026'));

  const refused = await importEdmtrain({ key: 'edm-secret', fetchImpl: async () => new Response(JSON.stringify(edmBody([], { success: false, message: 'Invalid client' })), { status: 200 }), now: NOW, log: { error: () => {} } });
  assert.equal(refused.errors, 1); assert.equal(refused.pruned, 0); assert.match(refused.lastError, /Invalid client/);
  assert.ok(q.festival('edm-bayou-bass-2026'), 'kept through a refused run');
  assert.deepEqual(await importEdmtrain({ key: '', fetchImpl }), { skipped: 'EDMTRAIN_KEY not set' });
  // Aftershock is curated on the same grounds a month earlier: different dates, so Beyond Wonderland is its own festival.
  assert.equal(q.publishedFestivals().filter(f => f.origin === 'edmtrain').length, 2);
});


test('what is not a festival stays out: SeatGeek concerts, tours and tributes, canceled shows, listings outside the weather service area', async () => {
  const { candidate: sg, festivalsFrom: sgFestivals } = await import('../src/importers/seatgeek.js');
  const today = '2026-09-30';
  assert.equal(sg(sgEvent({ title: 'Tracy Byrd', datetime_utc: '2026-10-03T23:45:00', enddatetime_utc: '2026-10-04T00:45:00', performers: [{ name: 'Tracy Byrd' }] })), null, 'an evening show filed under music_festival');
  assert.equal(sg(sgEvent({ title: 'Morrissey - Live in Concert', performers: [{ name: 'Morrissey' }] })), null);
  assert.equal(sg(sgEvent({ title: 'The Concert: A Tribute To ABBA' })), null);
  assert.equal(sg(sgEvent({ title: 'Los Lonely Boys: Rockpango Fest 2026 - canceled' })), null);
  assert.equal(sg(sgEvent({ title: 'Official 2026 ACL Fest Nights: Bleachers' })), null, 'a side show sold beside the festival');
  assert.equal(sg(sgEvent({ title: 'Get Freaky', time_tbd: true, datetime_local: '2026-10-23T03:30:00', datetime_utc: '2026-10-23T09:30:00' }))?.start, '2026-10-23T16:00:00Z', 'the placeholder time a multi-day event gets');
  assert.equal(sg(sgEvent({ title: 'John Summit (18+)', performers: [{ name: 'Experts Only Festival' }] }))?.name, 'Experts Only Festival', 'sold under the festival it is');
  assert.equal(sg(sgEvent({ title: 'Michigan Renaissance Festival' }))?.name, 'Michigan Renaissance Festival');
  const oneHour = sgFestivals([sgEvent({ title: 'Absolution Fest', datetime_utc: '2026-10-01T22:00:00', enddatetime_utc: '2026-10-01T23:00:00' })], today);
  assert.equal(oneHour[0].endDate, '2026-10-02T08:00:00Z', 'an end an hour after the start is a placeholder: the day is the festival\'s');
  assert.equal(sgFestivals([sgEvent({ title: 'Corona Capital', venue: sgVenue({ name: 'Autódromo Hermanos Rodríguez - Redirect', city: 'Temple City', state: 'CA', location: { lat: 19.40345, lon: -99.08878 } }) })], today).length, 0, 'Mexico City with a US placeholder venue');
  const bill = [{ name: 'Bailey Zimmerman' }, { name: 'Ella Langley' }, { name: 'Sam Barber' }];
  assert.equal(sg(sgEvent({ title: 'Country In The Park', performers: bill.slice(0, 2) })), null, 'two acts on an afternoon: a show');
  const merged = sgFestivals([sgEvent({ title: 'Country In The Park', datetime_utc: '2026-10-23T19:00:00', performers: bill }), sgEvent({ title: 'Country In The Park 2 with Bailey Zimmerman and more', datetime_utc: '2026-10-23T21:00:00', performers: bill })], today);
  assert.deepEqual(merged.map(f => [f.name, f.startDate, f.endDate]), [['Country In The Park', '2026-10-23T19:00:00Z', '2026-10-24T08:00:00Z']], 'same grounds, same day, one name with a word on the end: one festival');
  const passes = sgFestivals(['Rock The South - 4 Day Pass - with Jason Aldean and more (Rescheduled from 06/11-06/13)', 'Rock The South - Thursday - with Zach Top', 'Rock The South - Friday - with Jason Aldean', 'Rock The South - Sunday - with Riley Green']
    .map((title, i) => sgEvent({ title, datetime_utc: `2026-10-0${1 + i}T18:00:00` })), today);
  assert.deepEqual(passes.map(f => [f.name, f.startDate, f.endDate]), [['Rock The South', '2026-10-01T18:00:00Z', '2026-10-05T08:00:00Z']], 'day passes fold into the festival');

  assert.equal(candidate(tmEvent({ name: 'MOVEMENTS - HAPPIER NOW USA TOUR', _embedded: { venues: [tmVenue({ name: 'Observatory Festival Grounds' })], attractions: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }] } })), null, 'a tour with openers at a venue named for a festival');
  assert.equal(candidate(tmEvent({ name: 'Rockpango Fest', dates: { start: { localDate: '2026-10-10', dateTime: '2026-10-11T01:00:00Z' }, status: { code: 'cancelled' } } })), null);
  assert.equal(candidate(tmEvent({ name: 'FORM Arcosanti Festival Car Registration' })), null);
  assert.ok(candidate(tmEvent({ name: 'Vans Warped Tour Orlando' }), { trusted: true }), 'Front Gate sells it: a festival whatever the name says');
  assert.equal(candidate(tmEvent({ name: 'Vans Warped Tour Orlando' })), null, 'the same name unvouched is a tour');
  assert.deepEqual(festivalsFrom([tmEvent({ name: '2-Day Palm Tree Music Festival' }), tmEvent({ name: 'Palm Tree Music Festival - FRI 10/2' }), tmEvent({ name: 'Palm Tree Music Festival - SAT 10/3', dates: { start: { localDate: '2026-10-10', dateTime: '2026-10-10T22:00:00Z' } } })], today).map(f => [f.name, f.startDate, f.endDate]),
    [['Palm Tree Music Festival', '2026-10-09T17:00:00Z', '2026-10-11T08:00:00Z']], 'a two-day pass and two day tickets are one festival');
});

test('a camping pass on sale beside a festival says people camp there; a festival with none stays unknown', async () => {
  const { candidate: tm } = await import('../src/importers/ticketmaster.js');
  const { candidate: sg } = await import('../src/importers/seatgeek.js');
  const { groupListings } = await import('../src/importers/common.js');
  const { tmEvent } = await import('./fixtures/ticketmaster.js');
  const { sgEvent } = await import('./fixtures/seatgeek.js');
  const campingAt = new Set();
  const fest = tm(tmEvent({ name: 'Mulberry Mountain Music Festival' }), { trusted: true, campingAt });
  assert.equal(tm(tmEvent({ name: 'Mulberry Mountain Music Festival Camping Pass' }), { trusted: true, campingAt }), null, 'the pass itself is not a listing');
  assert.equal(campingAt.size, 1);
  const [f] = groupListings([fest], { origin: 'ticketmaster', prefix: 'tm', today: '2026-10-01', campingAt });
  assert.equal(f.camping, true);
  const [plain] = groupListings([tm(tmEvent({ name: 'Mulberry Mountain Music Festival' }), { trusted: true })], { origin: 'ticketmaster', prefix: 'tm', today: '2026-10-01' });
  assert.equal(plain.camping, undefined, 'no pass seen: nobody knows');
  const sgAt = new Set();
  sg(sgEvent({ title: 'Harvest Music Festival RV Pass' }), { campingAt: sgAt });
  assert.equal(sgAt.size, 1, 'SeatGeek too');
});

test('a stored import that a source ahead of it covers goes on its own next run, started or not, so a duplicate never needs hiding by hand', () => {
  assert.ok(outranks('curated', 'ticketmaster') && outranks('community', 'wikidata') && outranks('ticketmaster', 'seatgeek') && !outranks('seatgeek', 'ticketmaster') && !outranks('edmtrain', 'edmtrain'));
  const at = { startDate: '2026-09-25T16:00:00Z', endDate: '2026-09-29T05:00:00Z' };   // under way at NOW, so the vanished-before-it-started rule cannot reach it
  const make = (name, location, latitude, longitude, opts) => normalizeFestival({ name, location, latitude, longitude, ...at }, { status: 'published', ...opts }).festival;
  const zilker = make('Austin City Limits, Weekend 1', 'Zilker Park, Austin, TX', 30.2669, -97.7729, { origin: 'curated', id: 'acl-test-w1' });
  const stubbs = make('ACL Fest', "Stubb's Waller Creek Amphitheater, Austin, TX", 30.2687, -97.7362, { origin: 'seatgeek', id: 'sg-acl-fest-test' });
  for (const f of [zilker, stubbs]) q.upsertFestival(f);
  // Before the matcher knew the nickname this copy got in; the first run after sees it covered, errors or not.
  const r = applyImport({ origin: 'seatgeek', found: [], now: NOW, errors: 1 });
  assert.deepEqual({ added: r.added, updated: r.updated, duplicates: r.duplicates, pruned: r.pruned }, { added: 0, updated: 0, duplicates: 0, pruned: 1 });
  assert.equal(q.festival('sg-acl-fest-test'), null, 'the side show across town is gone'); assert.ok(q.festival('acl-test-w1'), 'the curated record stands');
  // Two imports of one festival: only the one lower in the run order gives way, so the two never remove each other.
  const tm = make('Lollapalooza', 'Grant Park, Chicago, IL', 41.8738, -87.6194, { origin: 'ticketmaster', id: 'tm-lolla-test' });
  const sg = make('Lolla', 'Grant Park, Chicago, IL', 41.8738, -87.6194, { origin: 'seatgeek', id: 'sg-lolla-test' });
  for (const f of [tm, sg]) q.upsertFestival(f);
  assert.equal(applyImport({ origin: 'ticketmaster', found: [tm], now: NOW, errors: 1 }).pruned, 0, 'Ticketmaster runs first and keeps its record');
  const r2 = applyImport({ origin: 'seatgeek', found: [sg], now: NOW, errors: 1 });
  assert.deepEqual({ duplicates: r2.duplicates, pruned: r2.pruned }, { duplicates: 1, pruned: 1 }); assert.equal(q.festival('sg-lolla-test'), null); assert.ok(q.festival('tm-lolla-test'));
  // A suggestion still waiting for review covers nothing.
  const pending = make('Riverbend Roots', 'Riverbend Farm, Athens, GA', 33.95, -83.38, { origin: 'community', status: 'pending', id: 'sub-riverbend-test' });
  const edm = make('Riverbend Roots', 'Riverbend Farm, Athens, GA', 33.95, -83.38, { origin: 'edmtrain', id: 'edm-riverbend-test' });
  for (const f of [pending, edm]) q.upsertFestival(f);
  assert.equal(applyImport({ origin: 'edmtrain', found: [], now: NOW, errors: 1 }).pruned, 0); assert.ok(q.festival('edm-riverbend-test'));
  for (const id of ['acl-test-w1', 'tm-lolla-test', 'sub-riverbend-test', 'edm-riverbend-test']) q.deleteFestival(id);
});
