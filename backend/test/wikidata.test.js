import { test } from 'node:test';
import assert from 'node:assert/strict';
import { items, hulaween, sparqlResult, pages, robots, wdItem } from './fixtures/wikidata.js';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
delete process.env.WIKIDATA_IMPORT;

const { q } = await import('../src/db.js');
const { seedAll } = await import('../src/seed.js');
const { importWikidata, parseCandidates, eventsFrom, robotsAllows, listingsFor, festivalsFrom, CACHE_KEY, SPARQL } = await import('../src/importers/wikidata.js');
seedAll();
const NOW = Date.parse('2026-09-28T12:00:00Z'), DAY = 86_400_000;
const cache = () => JSON.parse(q.setting(CACHE_KEY) || '{}');

test('SPARQL results become candidates: WKT coordinates, one per item, no label or no coordinates means no candidate', () => {
  const c = parseCandidates(sparqlResult(items));
  assert.deepEqual(c.map(x => x.qid), ['Q9001', 'Q9002', 'Q9003', 'Q9004', 'Q9005']);
  assert.deepEqual(c[2], { qid: 'Q9003', name: 'Moonrise Fest', latitude: 35.49, longitude: -93.83, website: 'https://moonrisefest.example/', place: 'Mulberry Mountain, Ozark' });
  assert.equal(c[0].website, null); assert.equal(c[1].place, 'Wendover');
  const odd = parseCandidates(sparqlResult([
    wdItem({ qid: 'Q1', label: 'Q1', lat: 1, lon: 2 }),                                   // the label service hands the id back when there is no label
    wdItem({ qid: 'Q2', label: 'Two', lat: 1, lon: 2, website: 'https://two.example/' }),
    wdItem({ qid: 'Q2', label: 'Two', lat: 1, lon: 2, website: 'https://two.example/other' }),   // a second website row for the same item
    wdItem({ qid: 'Q3', label: 'Three', lat: 1, lon: 2, website: 'https://two.example/' }),      // another item on the same site: one festival, not two
    { ...wdItem({ qid: 'Q4', label: 'Four', lat: 1, lon: 2 }), coord: { type: 'literal', value: 'nonsense' } },
    wdItem({ qid: 'Q5', label: 'Five', lat: 1, lon: 2, website: 'javascript:alert(1)' }),
  ]));
  assert.deepEqual(odd.map(x => [x.qid, x.website]), [['Q2', 'https://two.example/'], ['Q5', null]]);
  assert.deepEqual(parseCandidates({}), []); assert.deepEqual(parseCandidates(null), []);
  for (const s of ['wd:Q868557', 'wd:Q132241', 'wd:Q30', 'wdt:P625', 'wdt:P856', 'wdt:P576', 'wikibase:label']) assert.ok(SPARQL.includes(s), s);
});

test('robots.txt: only the * group counts, the longest matching rule wins, nothing said means yes', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\n'), false);
  assert.equal(robotsAllows(robots['https://hiddenhollow.example/robots.txt']), false, 'Googlebot may, everyone else may not');
  assert.equal(robotsAllows(robots['https://moonrisefest.example/robots.txt']), true);
  assert.equal(robotsAllows('User-agent: Googlebot\nDisallow: /\n'), true, 'a rule for someone else');
  assert.equal(robotsAllows(''), true); assert.equal(robotsAllows(null), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow:\n'), true, 'an empty Disallow allows everything');
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /festival/\n', '/festival/'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /festival/\n', '/'), false);
  assert.equal(robotsAllows('User-agent: bing\nUser-agent: *\nDisallow: /*\n'), false, 'two agents share a group; a wildcard root');
});

test('JSON-LD events: the right types, @graph and subEvent, bare dates as whole days, the next twelve months only', () => {
  const ev = eventsFrom(pages['https://moonrisefest.example/'], NOW);
  assert.deepEqual(ev, [
    { start: '2026-10-09T22:00:00Z', end: '2026-10-10T08:00:00Z', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
    { start: '2026-10-10T16:00:00Z', end: '2026-10-11T08:00:00Z', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
    { start: '2026-10-11T16:00:00Z', end: '2026-10-12T08:00:00Z', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
  ], 'a broken block is skipped, last year and the cancelled show are dropped, no end means the same day');
  assert.deepEqual(eventsFrom(pages['https://bigskyjam.example/'], NOW), [], 'the edition after next');
  assert.deepEqual(eventsFrom(pages['https://saltflatssound.example/'], NOW), []);
  assert.deepEqual(eventsFrom('<html><body>nothing</body></html>', NOW), []); assert.deepEqual(eventsFrom('', NOW), []);
  assert.deepEqual(eventsFrom(pages['https://hulaween.example/'], NOW), [{ start: '2026-10-22T16:00:00Z', end: '2026-10-26T08:00:00Z', lat: 40, lon: -100, place: 'Somewhere else entirely' }], 'a schema.org URL as the type');
  const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  assert.deepEqual(eventsFrom(ld({ '@type': 'Festival', startDate: '2026-10-01', subEvent: [{ '@type': 'MusicEvent', startDate: '2026-10-02', endDate: '2026-10-01T10:00:00Z' }] }), NOW),
    [{ start: '2026-10-01T16:00:00Z', end: '2026-10-02T08:00:00Z' }, { start: '2026-10-02T16:00:00Z', end: '2026-10-03T08:00:00Z' }], 'subEvents count; an end before the start is ignored');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-09-26', endDate: '2026-09-29' }), NOW), [{ start: '2026-09-26T16:00:00Z', end: '2026-09-30T08:00:00Z' }], 'on right now: still listed');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: 'soon' }), NOW), []);
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-01', eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }), NOW), [], 'a stream is not a place');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Place', startDate: '2026-10-01' }), NOW), []);
  assert.deepEqual(eventsFrom(ld([{ '@type': 'Event', startDate: '2026-10-01' }, { '@type': 'Event', startDate: '2026-10-01' }]), NOW).length, 1, 'the same event twice on one page is one');
});

test('listings take the page geo only when it is near the Wikidata point, and fold by item into one festival', () => {
  const [, , moonrise] = parseCandidates(sparqlResult(items));
  const near = listingsFor(moonrise, eventsFrom(pages['https://moonrisefest.example/'], NOW));
  assert.equal(near.length, 3); assert.equal(near[0].lat, 35.6981); assert.equal(near[0].key, 'wd:Q9003'); assert.equal(near[0].place, 'Mulberry Mountain, Ozark');
  const far = listingsFor(parseCandidates(sparqlResult([hulaween]))[0], eventsFrom(pages['https://hulaween.example/'], NOW));
  assert.equal(far[0].lat, 30.4045); assert.equal(far[0].lon, -82.939, 'a thousand kilometres off: Wikidata wins');
  const list = festivalsFrom([...near, ...far], '2026-09-28');
  assert.deepEqual(list.map(f => [f.id, f.wikidata, f.origin]), [['wd-moonrise-fest-2026', 'Q9003', 'wikidata'], ['wd-suwannee-hulaween-2026', 'Q9006', 'wikidata']]);
  assert.equal(list[0].startDate, '2026-10-09T22:00:00Z'); assert.equal(list[0].endDate, '2026-10-12T08:00:00Z');
});

test('the import: one query, polite site reads, a cache that makes the next run cheap, dedupe against curated, the switch, a dead endpoint', async () => {
  const fetched = [];
  const serve = { sparql: () => sparqlResult(items), fail: new Set() };
  const fetchImpl = async (u, opts = {}) => {
    const url = String(u); fetched.push(url);
    assert.equal(opts.headers?.['User-Agent'], process.env.NWS_USER_AGENT, 'every request says who we are');
    if (url.startsWith('https://query.wikidata.org/sparql?')) {
      const p = new URL(url).searchParams;
      assert.equal(opts.headers.Accept, 'application/sparql-results+json'); assert.equal(p.get('format'), 'json'); assert.ok(p.get('query').includes('wd:Q30'));
      const body = serve.sparql();
      return new Response(JSON.stringify(body), { status: body.status || 200, headers: { 'content-type': 'application/sparql-results+json' } });
    }
    if (serve.fail.has(url)) throw new Error('socket hang up');
    if (url.endsWith('/robots.txt')) return robots[url] ? new Response(robots[url], { status: 200 }) : new Response('not here', { status: 404 });
    if (pages[url]) return new Response(pages[url], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('', { status: 404 });
  };
  const opts = { fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } };

  const r = await importWikidata(opts);
  assert.deepEqual(r, { calls: 8, errors: 0, candidates: 5, sitesChecked: 4, festivals: 1, added: 1, updated: 0, duplicates: 0, pruned: 0 }, 'the query, robots.txt and a page per site, only robots.txt where it says no');
  assert.ok(!fetched.includes('https://hiddenhollow.example/'), 'a site whose robots.txt disallows us is never read');
  assert.ok(fetched.includes('https://moonrisefest.example/robots.txt') && fetched.includes('https://moonrisefest.example/'));
  const m = q.festival('wd-moonrise-fest-2026');
  assert.equal(m.name, 'Moonrise Fest'); assert.equal(m.origin, 'wikidata'); assert.equal(m.status, 'published'); assert.equal(m.featured, false);
  assert.equal(m.wikidata, 'Q9003');
  assert.equal(m.startDate, '2026-10-09T22:00:00Z', 'the Friday block has a time and a zone'); assert.equal(m.endDate, '2026-10-12T08:00:00Z', 'the Sunday block runs into the small hours');
  assert.equal(m.latitude, 35.6981); assert.equal(m.longitude, -93.7793, 'the page puts the grounds 24 km from where Wikidata has the town');
  assert.equal(m.location, 'Mulberry Mountain, Ozark'); assert.equal(m.county, '');
  assert.equal(m.source, 'https://moonrisefest.example/'); assert.equal(m.website, 'https://moonrisefest.example/'); assert.equal(m.verifiedOn, '2026-09-28');
  assert.equal(q.publishedFestivals().filter(f => f.origin === 'wikidata').length, 1, 'no site, no JSON-LD, a year out, robots: none of those became a festival');
  const c = cache();
  assert.deepEqual(Object.keys(c).sort(), ['https://bigskyjam.example/', 'https://hiddenhollow.example/', 'https://moonrisefest.example/', 'https://saltflatssound.example/']);
  assert.equal(c['https://moonrisefest.example/'].ok, true); assert.equal(c['https://moonrisefest.example/'].events.length, 3); assert.equal(c['https://moonrisefest.example/'].checkedAt, '2026-09-28T12:00:00Z');
  assert.equal(c['https://saltflatssound.example/'].ok, false); assert.equal(c['https://bigskyjam.example/'].ok, false);
  assert.deepEqual(c['https://hiddenhollow.example/'], { checkedAt: '2026-09-28T12:00:00Z', ok: false, robots: true });

  // The next day: the query runs, no site is read, and the festival is still there (not pruned as vanished).
  fetched.length = 0;
  const r2 = await importWikidata({ ...opts, now: NOW + DAY });
  assert.deepEqual(fetched, ['https://query.wikidata.org/sparql?' + fetched[0]?.split('?')[1]], 'one request');
  assert.deepEqual({ sitesChecked: r2.sitesChecked, updated: r2.updated, pruned: r2.pruned, festivals: r2.festivals }, { sitesChecked: 0, updated: 1, pruned: 0, festivals: 1 });
  // A week later the sites are read again (hits and misses alike); with a cap of one, the rest keep what they said last time.
  fetched.length = 0;
  const r3 = await importWikidata({ ...opts, now: NOW + 7 * DAY, maxSites: 1 });
  assert.equal(r3.sitesChecked, 1); assert.equal(fetched.filter(u => !u.includes('wikidata.org')).length, 2, 'robots.txt and the page of the first site');
  assert.equal(r3.festivals, 1, 'Moonrise came from the cache'); assert.equal(r3.pruned, 0);
  assert.equal(cache()['https://saltflatssound.example/'].checkedAt, '2026-10-05T12:00:00Z'); assert.equal(cache()['https://moonrisefest.example/'].checkedAt, '2026-09-28T12:00:00Z');
  const r4 = await importWikidata({ ...opts, now: NOW + 7 * DAY, cacheDays: 0 });
  assert.equal(r4.sitesChecked, 4, 'cacheDays is the knob');

  // An admin sets a county and features it; the next read keeps that. A site that is down keeps what it said, and counts as an error.
  q.upsertFestival({ ...q.festival('wd-moonrise-fest-2026'), featured: true, county: 'Franklin County' });
  serve.fail.add('https://moonrisefest.example/');
  const r5 = await importWikidata({ ...opts, now: NOW + 7 * DAY, cacheDays: 0 });
  assert.equal(r5.errors, 1); assert.equal(r5.pruned, 0); assert.equal(r5.updated, 1);
  assert.equal(q.festival('wd-moonrise-fest-2026').featured, true); assert.equal(q.festival('wd-moonrise-fest-2026').county, 'Franklin County');
  assert.equal(cache()['https://moonrisefest.example/'].ok, true); assert.equal(cache()['https://moonrisefest.example/'].error, 'socket hang up');
  serve.fail.clear();

  // Hulaween turns up on Wikidata: the curated record on those grounds and dates wins, and only the new site is read.
  serve.sparql = () => sparqlResult([...items, hulaween]);
  fetched.length = 0;
  const r6 = await importWikidata({ ...opts, now: NOW + 7 * DAY });
  assert.deepEqual({ candidates: r6.candidates, sitesChecked: r6.sitesChecked, festivals: r6.festivals, added: r6.added, duplicates: r6.duplicates }, { candidates: 6, sitesChecked: 1, festivals: 2, added: 0, duplicates: 1 });
  assert.ok(fetched.includes('https://hulaween.example/'));
  assert.equal(q.festival('wd-suwannee-hulaween-2026'), null);
  assert.equal(q.publishedFestivals().filter(f => /hulaween/i.test(f.name)).length, 1); assert.equal(q.publishedFestivals().find(f => /hulaween/i.test(f.name)).origin, 'curated');
  // Gone from Wikidata again: its cache entry goes too, so a site only lives in the settings row while Wikidata lists it.
  serve.sparql = () => sparqlResult(items);
  await importWikidata({ ...opts, now: NOW + 7 * DAY });
  assert.ok(!('https://hulaween.example/' in cache()));

  // Off by the switch, either way of saying so.
  assert.deepEqual(await importWikidata({ ...opts, enabled: false }), { skipped: 'WIKIDATA_IMPORT=false' });
  process.env.WIKIDATA_IMPORT = 'false';
  assert.deepEqual(await importWikidata(opts), { skipped: 'WIKIDATA_IMPORT=false' });
  delete process.env.WIKIDATA_IMPORT;

  // The endpoint is down or refuses: one error, nothing read, nothing pruned, the cache untouched.
  serve.sparql = () => ({ status: 503 });
  const lines = [];
  const bad = await importWikidata({ ...opts, log: { error: m => lines.push(m) } });
  assert.deepEqual(bad, { calls: 1, errors: 1, candidates: 0, sitesChecked: 0, festivals: 0, added: 0, updated: 0, duplicates: 0, pruned: 0 });
  assert.deepEqual(lines, ['wikidata: SPARQL 503']);
  assert.ok(q.festival('wd-moonrise-fest-2026'), 'kept through a bad run'); assert.equal(Object.keys(cache()).length, 4);
  const dead = await importWikidata({ ...opts, fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.equal(dead.errors, 1); assert.equal(dead.pruned, 0);
  // Not even bad JSON from the endpoint throws out of the importer.
  const junk = await importWikidata({ ...opts, fetchImpl: async () => new Response('<html>busy</html>', { status: 200 }) });
  assert.equal(junk.errors, 1); assert.equal(junk.calls, 1);
});

test('a listing that vanished from its site before it started is pruned on a clean run; one that ended a month ago always is', async () => {
  const stale = { ...q.festival('wd-moonrise-fest-2026'), id: 'wd-old-days-2026', name: 'Old Days', startDate: '2026-08-01T16:00:00Z', endDate: '2026-08-03T08:00:00Z' };
  q.upsertFestival(stale);
  const empty = { ...pages, 'https://moonrisefest.example/': '<html><head><title>Moonrise Fest</title></head><body>See you next year</body></html>' };
  const fetchImpl = async u => {
    const url = String(u);
    if (url.includes('wikidata.org')) return new Response(JSON.stringify(sparqlResult(items)), { status: 200 });
    if (url.endsWith('/robots.txt')) return new Response(robots[url] || '', { status: robots[url] ? 200 : 404 });
    return new Response(empty[url] || '', { status: empty[url] ? 200 : 404 });
  };
  const lines = [];
  const r = await importWikidata({ fetchImpl, now: NOW + 8 * DAY, pauseMs: 0, cacheDays: 0, log: { error: m => lines.push(m) } });
  assert.deepEqual(lines, []); assert.equal(r.errors, 0); assert.equal(r.festivals, 0); assert.equal(r.pruned, 2);
  assert.equal(q.festival('wd-moonrise-fest-2026'), null, 'the page no longer announces it: cancelled');
  assert.equal(q.festival('wd-old-days-2026'), null);
  assert.equal(cache()['https://moonrisefest.example/'].ok, false);
});
