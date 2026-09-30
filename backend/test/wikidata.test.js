import { test } from 'node:test';
import assert from 'node:assert/strict';
import { items, hulaween, riverfests, twoEditions, sparqlResult, classResult, answerSparql, pages, robots, wdItem } from './fixtures/wikidata.js';

process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@fieldwatch.test)';   // a real-looking contact: the placeholder's example.com switches the importer off
delete process.env.WIKIDATA_IMPORT;

const { q } = await import('../src/db.js');
const { seedAll } = await import('../src/seed.js');
const { importWikidata, parseCandidates, eventsFrom, robotsAllows, ruleMatches, listingsFor, festivalsFrom, checkSite, publicHost, skipReason, productToken, CACHE_KEY, CLASSES_SPARQL, CLASS_CHUNK, itemsSparql, parseClasses } = await import('../src/importers/wikidata.js');
const { importsConfigured } = await import('../src/importers/index.js');
seedAll();
const NOW = Date.parse('2026-09-28T12:00:00Z'), DAY = 86_400_000;
const cache = () => JSON.parse(q.setting(CACHE_KEY) || '{}');
const at = d => new Date(NOW + d * DAY).toISOString().replace(/\.\d{3}Z$/, 'Z');
const ld = o => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

test('SPARQL results become candidates: WKT coordinates, one per item, no label or no coordinates means no candidate', () => {
  const c = parseCandidates(sparqlResult(items));
  assert.deepEqual(c.map(x => x.qid), ['Q9001', 'Q9002', 'Q9003', 'Q9004', 'Q9005']);
  assert.deepEqual(c[2], { qid: 'Q9003', name: 'Moonrise Fest', latitude: 35.49, longitude: -93.83, website: 'https://moonrisefest.example/', place: 'Mulberry Mountain, Ozark' });
  assert.equal(c[0].website, null); assert.equal(c[1].place, 'Wendover');
  const odd = parseCandidates(sparqlResult([
    wdItem({ qid: 'Q1', label: 'Q1', lat: 39.5, lon: -105.1 }),                                   // the label service hands the id back when there is no label
    wdItem({ qid: 'Q2', label: 'Two', lat: 39.5, lon: -105.1, website: 'https://two.example/' }),
    wdItem({ qid: 'Q2', label: 'Two', lat: 39.5, lon: -105.1, website: 'https://two.example/other' }),   // a second website row for the same item
    wdItem({ qid: 'Q3', label: 'Three', lat: 39.5, lon: -105.1, website: 'https://two.example/' }),      // another item on the same site: one festival, not two
    { ...wdItem({ qid: 'Q4', label: 'Four', lat: 39.5, lon: -105.1 }), coord: { type: 'literal', value: 'nonsense' } },
    wdItem({ qid: 'Q5', label: 'Five', lat: 39.5, lon: -105.1, website: 'javascript:alert(1)' }),
    wdItem({ qid: 'Q30', label: 'Thirty', lat: 39.5, lon: -105.1, website: 'https://shared.example/' }),   // the lower id keeps a shared site, whichever the endpoint lists first
    wdItem({ qid: 'Q20', label: 'Twenty', lat: 39.5, lon: -105.1, website: 'https://shared.example/' }),
    wdItem({ qid: 'Q7', label: 'Loopback', lat: 39.5, lon: -105.1, website: 'http://127.0.0.1:3000/' }),  // a private address is not a site we read
    wdItem({ qid: 'Q8', label: 'Printer', lat: 39.5, lon: -105.1, website: 'https://printer.local/' }),
    wdItem({ qid: 'Q9', label: 'Nine', lat: 39.5, lon: -105.1, website: 'https://[::1]/' }),
  ]));
  assert.deepEqual(odd.map(x => [x.qid, x.website]), [['Q2', 'https://two.example/'], ['Q5', null], ['Q20', 'https://shared.example/'], ['Q7', null], ['Q8', null], ['Q9', null]]);
  assert.deepEqual(parseCandidates(sparqlResult([wdItem({ qid: 'Q2', label: 'Two', lat: 39.5, lon: -105.1, website: 'https://two.example/other' }), wdItem({ qid: 'Q2', label: 'Two', lat: 39.5, lon: -105.1, website: 'https://two.example/' })])).map(x => x.website),
    ['https://two.example/'], 'the shortest of an item\'s sites is its homepage, in any order');
  assert.deepEqual(parseCandidates({}), []); assert.deepEqual(parseCandidates(null), []);
  for (const s of ['wd:Q868557', 'wd:Q132241', 'wdt:P279*']) assert.ok(CLASSES_SPARQL.includes(s), s);
  const q = itemsSparql(['Q868557', 'Q1362001']);
  for (const s of ['VALUES ?class { wd:Q868557 wd:Q1362001 }', 'wdt:P31 ?class', 'wd:Q30', 'wdt:P625', 'wdt:P856', 'wdt:P576', 'wikibase:label']) assert.ok(q.includes(s), s);
  assert.ok(!q.includes('P279'), 'no property path in the item query: that is what timed out');
  assert.deepEqual(parseClasses(classResult(['Q1', 'Q1', 'Q2', 'bad'])), ['Q1', 'Q2']);
  assert.ok(CLASS_CHUNK >= 100 && CLASS_CHUNK <= 500);
});

test('robots.txt: the group naming us over *, wildcards and $ as written, the longest matching rule wins, nothing said means yes', () => {
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\n'), false);
  assert.equal(robotsAllows(robots['https://hiddenhollow.example/robots.txt']), false, 'Googlebot may, everyone else may not');
  assert.equal(robotsAllows(robots['https://moonrisefest.example/robots.txt']), true);
  assert.equal(robotsAllows('User-agent: Googlebot\nDisallow: /\n'), true, 'a rule for someone else');
  assert.equal(robotsAllows(''), true); assert.equal(robotsAllows(null), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow:\n'), true, 'an empty Disallow allows everything');
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /festival/\n', '/festival/'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\nAllow: /festival/\n', '/'), false);
  assert.equal(robotsAllows('User-agent: bing\nUser-agent: *\nDisallow: /*\n'), false, 'two agents share a group; a wildcard root');
  assert.equal(robotsAllows('User-agent: *\nSitemap: https://x.example/s.xml\nDisallow: /\n'), false, 'a Sitemap line does not split the group');
  // What Squarespace serves: Disallow:/*?author=* is a rule about query strings, not Disallow: /.
  const sq = robots['https://squarespace.example/robots.txt'];
  assert.equal(robotsAllows(sq, '/'), true); assert.equal(robotsAllows(sq, '/tickets'), true);
  assert.equal(robotsAllows(sq, '/blog?author=jo'), false); assert.equal(robotsAllows(sq, '/blog?format=json'), false); assert.equal(robotsAllows(sq, '/?tag=x'), false); assert.equal(robotsAllows(sq, '/blog?page=2&format=json'), false);
  assert.equal(robotsAllows(sq, '/account'), false, '$ pins the end'); assert.equal(robotsAllows(sq, '/accounts'), true); assert.equal(robotsAllows(sq, '/account/orders'), false);
  assert.equal(robotsAllows(sq, '/configure'), false, 'a rule without a wildcard is a prefix');
  assert.equal(robotsAllows(sq, '/', 'GPTBot'), false, 'the group naming the bot wins over *'); assert.equal(robotsAllows(sq, '/', 'ccbot'), false);
  // Our own product token is the first word of the User-Agent.
  assert.equal(productToken(), 'fieldwatch'); assert.equal(productToken('Fieldwatch/0.1 (ops@fieldwatch.test)'), 'fieldwatch'); assert.equal(productToken('Mozilla/5.0'), 'mozilla'); assert.equal(productToken(''), 'fieldwatch');
  assert.equal(robotsAllows('User-agent: Fieldwatch\nDisallow: /\n\nUser-agent: *\nAllow: /\n'), false, 'named, so the * group does not apply');
  assert.equal(robotsAllows('User-agent: *\nDisallow: /\n\nUser-agent: fieldwatch/1.0\nDisallow: /cart\n'), true, 'our group has nothing against the homepage');
  assert.equal(robotsAllows('User-agent: Fieldwatch\nDisallow: /\n', '/', 'other'), true);
  assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$\n', '/a.pdf'), false); assert.equal(robotsAllows('User-agent: *\nDisallow: /*.pdf$\n', '/a.pdf?x'), true);
  assert.equal(ruleMatches('/*/y', '/x/y/z'), true); assert.equal(ruleMatches('/*/y$', '/x/y/z'), false); assert.equal(ruleMatches('/a*b*c', '/abc'), true); assert.equal(ruleMatches('/a*b*c', '/acb'), false);
  assert.equal(robotsAllows(`User-agent: *\nDisallow: ${'/*'.repeat(200)}x\n`, `/${'a/'.repeat(100)}`), true, 'a hostile pattern is matched in linear time');
});

test('JSON-LD events: the right types, @graph and subEvent, bare dates as whole days, the next twelve months only', () => {
  const ev = eventsFrom(pages['https://moonrisefest.example/'], NOW);
  assert.deepEqual(ev, [
    { start: '2026-10-09T22:00:00Z', end: '2026-10-10T08:00:00Z', name: 'Moonrise Fest - Friday', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
    { start: '2026-10-10T16:00:00Z', end: '2026-10-11T08:00:00Z', name: 'Moonrise Fest - Saturday', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
    { start: '2026-10-11T16:00:00Z', end: '2026-10-12T08:00:00Z', name: 'Moonrise Fest - Sunday', lat: 35.6981, lon: -93.7793, place: 'Mulberry Mountain, Ozark, AR' },
  ], 'a broken block is skipped, last year and the cancelled show are dropped, no end means the same day');
  assert.deepEqual(eventsFrom(pages['https://bigskyjam.example/'], NOW), [], 'the edition after next');
  assert.deepEqual(eventsFrom(pages['https://saltflatssound.example/'], NOW), []);
  assert.deepEqual(eventsFrom('<html><body>nothing</body></html>', NOW), []); assert.deepEqual(eventsFrom('', NOW), []);
  assert.deepEqual(eventsFrom(pages['https://hulaween.example/'], NOW), [{ start: '2026-10-22T16:00:00Z', end: '2026-10-26T08:00:00Z', name: 'Suwannee Hulaween 2026', lat: 40, lon: -100, place: 'Somewhere else entirely' }], 'a schema.org URL as the type');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Festival', startDate: '2026-10-01', subEvent: [{ '@type': 'MusicEvent', startDate: '2026-10-02', endDate: '2026-10-01T10:00:00Z' }] }), NOW),
    [{ start: '2026-10-01T16:00:00Z', end: '2026-10-02T08:00:00Z' }, { start: '2026-10-02T16:00:00Z', end: '2026-10-03T08:00:00Z' }], 'subEvents count; an end before the start is ignored');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-09-26', endDate: '2026-09-29' }), NOW), [{ start: '2026-09-26T16:00:00Z', end: '2026-09-30T08:00:00Z' }], 'on right now: still listed');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: 'soon' }), NOW), []);
  // A start that is a date but not YYYY-MM-DD used to throw when the end was missing or earlier; the same-day fallback comes from the normalised start.
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: 'Fri, 09 Oct 2026 17:00:00 GMT' }), NOW), [{ start: '2026-10-09T17:00:00Z', end: '2026-10-10T08:00:00Z' }]);
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: 'Fri, 09 Oct 2026 17:00:00 GMT', endDate: 'Thu, 08 Oct 2026 10:00:00 GMT' }), NOW), [{ start: '2026-10-09T17:00:00Z', end: '2026-10-10T08:00:00Z' }]);
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-09T23:30:00-05:00' }), NOW), [{ start: '2026-10-10T04:30:00Z', end: '2026-10-11T08:00:00Z' }], 'the day is the UTC day of the start');
  assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-01', eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }), NOW), [], 'a stream is not a place');
  assert.equal(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-01', eventAttendanceMode: { '@id': 'https://schema.org/MixedEventAttendanceMode' } }), NOW).length, 1);
  // eventStatus as an object, and every way of not happening.
  for (const status of [{ '@id': 'https://schema.org/EventCancelled' }, { '@id': 'https://schema.org/EventMovedOnline' }, 'https://schema.org/EventPostponed', 'EventCanceled', ['https://schema.org/EventCancelled']])
    assert.deepEqual(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-01', eventStatus: status }), NOW), [], JSON.stringify(status));
  for (const status of ['https://schema.org/EventScheduled', { '@id': 'https://schema.org/EventRescheduled' }, undefined])
    assert.equal(eventsFrom(ld({ '@type': 'Event', startDate: '2026-10-01', eventStatus: status }), NOW).length, 1, JSON.stringify(status));
  assert.deepEqual(eventsFrom(ld({ '@type': 'Place', startDate: '2026-10-01' }), NOW), []);
  assert.deepEqual(eventsFrom(ld([{ '@type': 'Event', startDate: '2026-10-01' }, { '@type': 'Event', startDate: '2026-10-01' }]), NOW).length, 1, 'the same event twice on one page is one');
  assert.equal(eventsFrom('<SCRIPT TYPE="application/ld+json">' + JSON.stringify({ '@type': 'Event', startDate: '2026-10-01' }) + '</SCRIPT>', NOW).length, 1, 'tags in any case');
  // Script tags are walked once, left to right; a <script> that never closes ends the scan instead of stalling it.
  const open = '<script type="application/ld+json">', block = ld({ '@type': 'Event', startDate: '2026-10-01' });
  assert.deepEqual(eventsFrom(open + JSON.stringify({ '@type': 'Event', startDate: '2026-10-01' }), NOW), [], 'never closed: not read');
  assert.equal(eventsFrom(block + open + '{', NOW).length, 1, 'a closed block before an unclosed one still counts');
  assert.deepEqual(eventsFrom(open + '{' + block, NOW), [], 'an unclosed tag swallows the block after it');
  const t0 = performance.now();
  assert.deepEqual(eventsFrom(open.repeat(20_000) + '{' + block, NOW), []);
  assert.deepEqual(eventsFrom(open.repeat(20_000), NOW), []);
  assert.ok(performance.now() - t0 < 2000, `twenty thousand unclosed tags took ${Math.round(performance.now() - t0)} ms`);
});

test('listings take the page geo only when near the Wikidata point, fold by name and item, keep the first fortnight, and carry the item in the id', () => {
  const [, , moonrise] = parseCandidates(sparqlResult(items));
  const near = listingsFor(moonrise, eventsFrom(pages['https://moonrisefest.example/'], NOW));
  assert.equal(near.length, 3); assert.equal(near[0].lat, 35.6981); assert.equal(near[0].key, 'moonrise fest|Q9003'); assert.equal(near[0].place, 'Mulberry Mountain, Ozark');
  assert.equal(near[0].name, 'Moonrise Fest', 'a block named after the festival carries the Wikidata label');
  const far = listingsFor(parseCandidates(sparqlResult([hulaween]))[0], eventsFrom(pages['https://hulaween.example/'], NOW));
  assert.equal(far[0].lat, 30.4045); assert.equal(far[0].lon, -82.939, 'a thousand kilometres off: Wikidata wins');
  const list = festivalsFrom([...near, ...far], '2026-09-28');
  assert.deepEqual(list.map(f => [f.id, f.wikidata, f.origin]), [['wd-q9003-moonrise-fest-2026', 'Q9003', 'wikidata'], ['wd-q9006-suwannee-hulaween-2026', 'Q9006', 'wikidata']]);
  assert.equal(list[0].startDate, '2026-10-09T22:00:00Z'); assert.equal(list[0].endDate, '2026-10-12T08:00:00Z');
  assert.equal(listingsFor(moonrise, [{ start: '2026-10-09T22:00:00Z', end: '2026-10-10T08:00:00Z' }])[0].key, 'moonrise fest|Q9003', 'events cached before names were kept still fold');
  // Two Riverfests: one label, two items, two records.
  const [littleRock, wichita] = parseCandidates(sparqlResult(riverfests));
  const rf = festivalsFrom([...listingsFor(littleRock, eventsFrom(pages[littleRock.website], NOW)), ...listingsFor(wichita, eventsFrom(pages[wichita.website], NOW))], '2026-09-28');
  assert.deepEqual(rf.map(f => [f.id, f.name, f.startDate, f.location]), [['wd-q9102-riverfest-2026', 'Riverfest', '2026-10-02T16:00:00Z', 'Little Rock'], ['wd-q9101-riverfest-2026', 'Riverfest', '2026-10-16T16:00:00Z', 'Wichita']]);
  // One homepage, two editions: only the first fortnight counts, so autumn does not run into spring. The pre-party named after
  // the festival folds in; a differently named night is its own record, not a stretch of the festival's dates.
  const [te] = parseCandidates(sparqlResult([twoEditions]));
  const evs = eventsFrom(pages[te.website], NOW); assert.equal(evs.length, 4);
  const ls = listingsFor(te, evs); assert.equal(ls.length, 3, 'spring is out');
  assert.deepEqual(festivalsFrom(ls, '2026-09-28').map(f => [f.id, f.name, f.startDate, f.endDate]), [
    ['wd-q9107-two-editions-2026', 'Two Editions', '2026-10-15T16:00:00Z', '2026-10-19T08:00:00Z'],
    ['wd-q9107-silent-cinema-night-2026', 'Silent Cinema Night', '2026-10-20T16:00:00Z', '2026-10-21T08:00:00Z'],
  ]);
  assert.deepEqual(listingsFor(te, []), []);
  // Two groups whose names slug alike would share an id: one record.
  const l = (name, key, start) => ({ key, name, place: 'X', lat: 39.5, lon: -105.1, start, end: '2026-10-04T08:00:00Z', url: 'https://a.example/', qid: 'Q1' });
  assert.equal(festivalsFrom([l('Fest & Co', 'a|Q1', '2026-10-01T16:00:00Z'), l('Fest and Co', 'b|Q1', '2026-10-03T16:00:00Z')], '2026-09-28').length, 1);
});

test('the switch: off by false, 0 or no; on otherwise, but not until NWS_USER_AGENT is a real contact', () => {
  const ua = 'Fieldwatch/1.0 (ops@fieldwatch.test)';
  for (const v of ['false', 'FALSE', '0', 'no', ' No ', false]) assert.equal(skipReason({ enabled: v, userAgent: ua }), 'WIKIDATA_IMPORT=false', String(v));
  for (const v of [undefined, '', 'true', '1', 'yes', 'on', true]) assert.equal(skipReason({ enabled: v, userAgent: ua }), null, String(v));
  for (const bad of ['', '  ', 'Fieldwatch/0.1 (you@example.com)', 'Fieldwatch (ops@EXAMPLE.COM)']) assert.match(skipReason({ enabled: 'true', userAgent: bad }), /NWS_USER_AGENT/, JSON.stringify(bad));
  assert.equal(skipReason({ enabled: 'false', userAgent: '' }), 'WIKIDATA_IMPORT=false', 'off is off, whatever the agent');
  assert.equal(skipReason(), null, 'this suite runs with a contact set and the switch unset');
  assert.equal(importsConfigured(), true, 'a keyless deployment still imports');
  const saved = process.env.NWS_USER_AGENT;
  process.env.NWS_USER_AGENT = 'Fieldwatch/0.1 (you@example.com)';
  assert.match(skipReason(), /placeholder/); assert.equal(importsConfigured(), false, 'nothing else is configured here');
  process.env.NWS_USER_AGENT = saved;
});

test('the import: one query, polite site reads, a cache that makes the next run cheap, dedupe against curated, the switch, a dead endpoint', async () => {
  const fetched = [];
  const serve = { sparql: () => sparqlResult(items), fail: new Set(), busy: new Set() };
  const fetchImpl = async (u, opts = {}) => {
    const url = String(u); fetched.push(url);
    assert.equal(opts.headers?.['User-Agent'], process.env.NWS_USER_AGENT, 'every request says who we are');
    if (url.startsWith('https://query.wikidata.org/sparql?')) {
      const p = new URL(url).searchParams;
      assert.equal(opts.headers.Accept, 'application/sparql-results+json'); assert.equal(p.get('format'), 'json'); assert.ok(p.get('query').includes('?class WHERE') || p.get('query').includes('wd:Q30'), 'the kinds query, or an item query for the US');
      const body = answerSparql(url, serve.sparql);
      return new Response(JSON.stringify(body), { status: body.status || 200, headers: { 'content-type': 'application/sparql-results+json' } });
    }
    assert.equal(opts.redirect, 'manual', 'a site is followed by hand');
    if (serve.fail.has(url)) throw new Error('socket hang up');
    if (serve.busy.has(url)) return new Response('busy', { status: 503 });
    if (url.endsWith('/robots.txt')) return robots[url] ? new Response(robots[url], { status: 200 }) : new Response('not here', { status: 404 });
    if (pages[url]) return new Response(pages[url], { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return new Response('', { status: 404 });
  };
  const opts = { fetchImpl, now: NOW, pauseMs: 0, log: { error: () => {} } };

  const r = await importWikidata(opts);
  assert.deepEqual(r, { calls: 9, errors: 0, candidates: 5, sitesChecked: 4, siteErrors: 0, festivals: 1, added: 1, updated: 0, duplicates: 0, pruned: 0 }, 'the two queries, robots.txt and a page per site, only robots.txt where it says no');
  assert.ok(!fetched.includes('https://hiddenhollow.example/'), 'a site whose robots.txt disallows us is never read');
  assert.ok(fetched.includes('https://moonrisefest.example/robots.txt') && fetched.includes('https://moonrisefest.example/'));
  const m = q.festival('wd-q9003-moonrise-fest-2026');
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
  assert.deepEqual(fetched.map(u => u.split('?')[0]), ['https://query.wikidata.org/sparql', 'https://query.wikidata.org/sparql'], 'the two queries and nothing else');
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
  q.upsertFestival({ ...q.festival('wd-q9003-moonrise-fest-2026'), featured: true, county: 'Franklin County' });
  serve.fail.add('https://moonrisefest.example/');
  const r5 = await importWikidata({ ...opts, now: NOW + 7 * DAY, cacheDays: 0 });
  assert.equal(r5.siteErrors, 1); assert.equal(r5.errors, 0, 'a site that is down is not an error of the run'); assert.equal(r5.pruned, 0); assert.equal(r5.updated, 1);
  assert.equal(q.festival('wd-q9003-moonrise-fest-2026').featured, true); assert.equal(q.festival('wd-q9003-moonrise-fest-2026').county, 'Franklin County');
  assert.equal(cache()['https://moonrisefest.example/'].ok, true); assert.equal(cache()['https://moonrisefest.example/'].error, 'socket hang up');
  serve.fail.clear();
  // A robots.txt that answers 5xx is not permission: the site is an error today, keeps its last answer, and is asked again later.
  serve.busy.add('https://moonrisefest.example/robots.txt'); fetched.length = 0;
  const r5b = await importWikidata({ ...opts, now: NOW + 7 * DAY, cacheDays: 0 });
  assert.equal(r5b.siteErrors, 1); assert.equal(r5b.festivals, 1); assert.equal(r5b.updated, 1);
  assert.ok(!fetched.includes('https://moonrisefest.example/'), 'the page is not read on a 503 from robots.txt');
  assert.equal(cache()['https://moonrisefest.example/'].ok, true); assert.equal(cache()['https://moonrisefest.example/'].error, 'robots.txt HTTP 503');
  serve.busy.clear();

  // Hulaween turns up on Wikidata: the curated record on those grounds and dates wins, and only the new site is read.
  serve.sparql = () => sparqlResult([...items, hulaween]);
  fetched.length = 0;
  const r6 = await importWikidata({ ...opts, now: NOW + 7 * DAY });
  assert.deepEqual({ candidates: r6.candidates, sitesChecked: r6.sitesChecked, festivals: r6.festivals, added: r6.added, duplicates: r6.duplicates }, { candidates: 6, sitesChecked: 1, festivals: 2, added: 0, duplicates: 1 });
  assert.ok(fetched.includes('https://hulaween.example/'));
  assert.equal(q.festival('wd-q9006-suwannee-hulaween-2026'), null);
  assert.equal(q.publishedFestivals().filter(f => /hulaween/i.test(f.name)).length, 1); assert.equal(q.publishedFestivals().find(f => /hulaween/i.test(f.name)).origin, 'curated');
  // Gone from Wikidata again: its cache entry goes too, so a site only lives in the settings row while Wikidata lists it.
  serve.sparql = () => sparqlResult(items);
  await importWikidata({ ...opts, now: NOW + 7 * DAY });
  assert.ok(!('https://hulaween.example/' in cache()));

  // Off by the switch, every way of saying so; off with a placeholder contact, with a reason that says which.
  fetched.length = 0;
  assert.deepEqual(await importWikidata({ ...opts, enabled: false }), { skipped: 'WIKIDATA_IMPORT=false' });
  for (const v of ['false', '0', 'no']) { process.env.WIKIDATA_IMPORT = v; assert.deepEqual(await importWikidata(opts), { skipped: 'WIKIDATA_IMPORT=false' }, v); }
  delete process.env.WIKIDATA_IMPORT;
  assert.match((await importWikidata({ ...opts, userAgent: 'Fieldwatch/0.1 (you@example.com)' })).skipped, /NWS_USER_AGENT is unset or still the example\.com placeholder/);
  assert.match((await importWikidata({ ...opts, userAgent: '' })).skipped, /NWS_USER_AGENT/);
  const saved = process.env.NWS_USER_AGENT; delete process.env.NWS_USER_AGENT;
  assert.match((await importWikidata(opts)).skipped, /NWS_USER_AGENT/);
  process.env.NWS_USER_AGENT = saved;
  assert.deepEqual(fetched, [], 'nothing was asked of anyone');

  // The endpoint is down or refuses: one error, nothing read, nothing pruned, the cache untouched.
  serve.sparql = () => ({ status: 503 });
  const lines = [];
  const bad = await importWikidata({ ...opts, log: { error: m => lines.push(m) } });
  assert.deepEqual(bad, { calls: 2, errors: 1, lastError: 'SPARQL 503', candidates: 0, sitesChecked: 0, siteErrors: 0, festivals: 0, added: 0, updated: 0, duplicates: 0, pruned: 0 });
  assert.deepEqual(lines, ['wikidata: SPARQL 503']);
  assert.ok(q.festival('wd-q9003-moonrise-fest-2026'), 'kept through a bad run'); assert.equal(Object.keys(cache()).length, 4);
  const dead = await importWikidata({ ...opts, fetchImpl: async () => { throw new Error('fetch failed'); } });
  assert.equal(dead.errors, 1); assert.equal(dead.pruned, 0);
  // Not even bad JSON from the endpoint throws out of the importer.
  const junk = await importWikidata({ ...opts, fetchImpl: async () => new Response('<html>busy</html>', { status: 200 }) });
  assert.equal(junk.errors, 1); assert.equal(junk.calls, 1);
});

test('a site is followed by hand: five hops at most, robots.txt read again on every new origin, never off the public internet', async () => {
  const fetched = [];
  const redirects = { 'https://old.example/': 'https://new.example/', 'https://loop.example/': 'https://loop.example/', 'https://toblocked.example/': 'https://blocked.example/',
    'https://tometa.example/': 'http://169.254.169.254/latest/meta-data/', 'https://moved.example/': '/private/', 'https://tolocal.example/': 'https://printer.local/', 'https://nowhere.example/': null };
  const fetchImpl = async (u, opts) => {
    const url = String(u); fetched.push(url);
    assert.equal(opts.redirect, 'manual'); assert.equal(opts.headers['User-Agent'], process.env.NWS_USER_AGENT);
    if (url in redirects) return new Response(null, { status: 302, headers: redirects[url] ? { location: redirects[url] } : {} });
    if (url.endsWith('/robots.txt')) return url.startsWith('https://flaky.') ? new Response('', { status: 503 }) : robots[url] ? new Response(robots[url]) : new Response('', { status: 404 });
    return pages[url] ? new Response(pages[url]) : new Response('', { status: 404 });
  };
  const o = { fetchImpl, now: NOW };
  assert.deepEqual(await checkSite('https://old.example/', o), { calls: 4, events: [{ start: '2026-11-06T16:00:00Z', end: '2026-11-09T08:00:00Z', name: 'Moved Fest' }], robots: false });
  assert.deepEqual(fetched, ['https://old.example/robots.txt', 'https://old.example/', 'https://new.example/robots.txt', 'https://new.example/'], 'the new origin is asked before it is read');
  fetched.length = 0;
  assert.deepEqual(await checkSite('https://toblocked.example/', o), { calls: 3, events: [], robots: true }, 'the origin a redirect leads to says no');
  assert.ok(!fetched.includes('https://blocked.example/'));
  assert.deepEqual(await checkSite('https://moved.example/', o), { calls: 2, events: [], robots: true }, 'the same origin, a path it disallows');
  fetched.length = 0;
  await assert.rejects(checkSite('https://tometa.example/', o), /redirect to a private address/);
  await assert.rejects(checkSite('https://tolocal.example/', o), /redirect to a private address/);
  assert.ok(fetched.every(u => !u.includes('169.254') && !u.includes('.local')), 'never requested');
  fetched.length = 0;
  await assert.rejects(checkSite('https://loop.example/', o), /too many redirects/);
  assert.equal(fetched.filter(u => u === 'https://loop.example/').length, 6, 'the request and five hops');
  await assert.rejects(checkSite('https://nowhere.example/', o), /HTTP 302 without a Location/);
  await assert.rejects(checkSite('https://flaky.example/', o), /robots\.txt HTTP 503/);
  fetched.length = 0;
  for (const bad of ['http://127.0.0.1:3000/', 'https://localhost/', 'https://[::1]/', 'https://printer.local/', 'https://intranet/', 'http://2130706433/', 'http://0x7f.0.0.1/', 'https://10.0.0.1/', 'https://169.254.169.254/'])
    await assert.rejects(checkSite(bad, o), /not a public host/, bad);
  assert.deepEqual(fetched, [], 'not even robots.txt');
  for (const [h, ok] of [['moonrisefest.example', true], ['www.bonnaroo.com', true], ['xn--bcher-kva.example', true], ['a.b.c.d.example.org', true], ['127.0.0.1', false], ['[::1]', false], ['localhost', false], ['a.localhost', false],
    ['printer.local', false], ['intranet', false], ['1.2.3.4.5', false], ['a.b', false], ['-bad.example', false], ['bad_host.example', false], ['box.internal', false], ['', false], [null, false]]) assert.equal(publicHost(h), ok, String(h));
});

test('sites never seen are read first, then the longest unchecked; a private address is never a site; a site that is down does not stop pruning', async () => {
  const fetched = []; const serve = { items, fail: null };
  const fetchImpl = async u => {
    const url = String(u); fetched.push(url);
    if (url.includes('wikidata.org')) return new Response(JSON.stringify(answerSparql(url, serve.items)), { status: 200 });
    if (url === serve.fail) throw new Error('socket hang up');
    if (url.endsWith('/robots.txt')) return new Response(robots[url] || '', { status: robots[url] ? 200 : 404 });
    return new Response(pages[url] || '', { status: pages[url] ? 200 : 404 });
  };
  const opts = { fetchImpl, pauseMs: 0, log: { error: () => {} } };
  // With a cap of two: the site never seen, then the one checked longest ago; the one seen most recently waits, so a long list is walked to its end.
  q.setSetting(CACHE_KEY, JSON.stringify({ 'https://saltflatssound.example/': { checkedAt: at(-2), ok: false }, 'https://moonrisefest.example/': { checkedAt: at(-12), ok: false }, 'https://bigskyjam.example/': { checkedAt: at(-9), ok: false } }));
  const r = await importWikidata({ ...opts, now: NOW + 5 * DAY, maxSites: 2 });
  assert.equal(r.sitesChecked, 2);
  assert.deepEqual([...new Set(fetched.filter(u => !u.includes('wikidata.org')).map(u => new URL(u).origin))], ['https://hiddenhollow.example', 'https://moonrisefest.example']);
  assert.equal(cache()['https://saltflatssound.example/'].checkedAt, at(-2)); assert.equal(cache()['https://bigskyjam.example/'].checkedAt, at(-9));
  assert.equal(r.festivals, 1); assert.ok(q.festival('wd-q9003-moonrise-fest-2026'));
  // A candidate whose site is a private address gets no request and no cache row, and is no error.
  fetched.length = 0;
  serve.items = [...items, wdItem({ qid: 'Q9008', label: 'Loopback Fest', lat: 39.5, lon: -105.1, website: 'http://127.0.0.1:3000/' }), wdItem({ qid: 'Q9009', label: 'Printer Fest', lat: 39.5, lon: -105.1, website: 'https://printer.local/' })];
  const p = await importWikidata({ ...opts, now: NOW + 5 * DAY, maxSites: 0 });
  assert.equal(p.candidates, 7); assert.equal(p.errors, 0); assert.equal(p.sitesChecked, 0);
  assert.ok(fetched.every(u => u.includes('wikidata.org')));
  assert.ok(!Object.keys(cache()).some(k => k.includes('127.0.0.1') || k.includes('.local')));
  // A listing that vanished from a site that answered is pruned even when another site is down: only a failed query holds pruning back.
  serve.items = items; serve.fail = 'https://saltflatssound.example/';
  q.upsertFestival({ ...q.festival('wd-q9003-moonrise-fest-2026'), id: 'wd-q9999-ghost-fest-2026', name: 'Ghost Fest', startDate: at(20), endDate: at(22) });
  const g = await importWikidata({ ...opts, now: NOW + 5 * DAY, cacheDays: 0 });
  assert.equal(g.siteErrors, 1, 'the site that hung up'); assert.match(g.lastSiteError, /socket hang up/); assert.equal(g.pruned, 1); assert.equal(g.updated, 1);
  assert.equal(q.festival('wd-q9999-ghost-fest-2026'), null); assert.ok(q.festival('wd-q9003-moonrise-fest-2026'));
  assert.equal(cache()['https://saltflatssound.example/'].error, 'socket hang up');
});

test('a listing that vanished from its site before it started is pruned on a clean run; one that ended a month ago always is', async () => {
  const stale = { ...q.festival('wd-q9003-moonrise-fest-2026'), id: 'wd-old-days-2026', name: 'Old Days', startDate: '2026-08-01T16:00:00Z', endDate: '2026-08-03T08:00:00Z' };
  q.upsertFestival(stale);
  const empty = { ...pages, 'https://moonrisefest.example/': '<html><head><title>Moonrise Fest</title></head><body>See you next year</body></html>' };
  const fetchImpl = async u => {
    const url = String(u);
    if (url.includes('wikidata.org')) return new Response(JSON.stringify(answerSparql(url, items)), { status: 200 });
    if (url.endsWith('/robots.txt')) return new Response(robots[url] || '', { status: robots[url] ? 200 : 404 });
    return new Response(empty[url] || '', { status: empty[url] ? 200 : 404 });
  };
  const lines = [];
  const r = await importWikidata({ fetchImpl, now: NOW + 8 * DAY, pauseMs: 0, cacheDays: 0, log: { error: m => lines.push(m) } });
  assert.deepEqual(lines, []); assert.equal(r.errors, 0); assert.equal(r.festivals, 0); assert.equal(r.pruned, 2);
  assert.equal(q.festival('wd-q9003-moonrise-fest-2026'), null, 'the page no longer announces it: cancelled');
  assert.equal(q.festival('wd-old-days-2026'), null);
  assert.equal(cache()['https://moonrisefest.example/'].ok, false);
});


test('events on the festival\'s own site that never carry its name are its events, and the festival is what the site is about', () => {
  const cherry = parseCandidates(sparqlResult([wdItem({ qid: 'Q535568', label: 'National Cherry Blossom Festival', lat: 38.8853, lon: -77.0386, website: 'https://cherry.example/', admin: 'Washington, D.C.' })]))[0];
  const ld = { '@context': 'https://schema.org', '@graph': [
    { '@type': 'Event', name: 'Pink Tie Party', startDate: '2027-03-12T19:00:00-05:00', endDate: '2027-03-12T23:00:00-05:00', location: { '@type': 'Place', name: 'Tidal Basin' } },
    { '@type': 'Event', name: 'Opening Ceremony', startDate: '2027-03-20T17:00:00-04:00', endDate: '2027-03-20T18:30:00-04:00', location: { '@type': 'Place', name: 'Tidal Basin' } },
    { '@type': 'Festival', name: 'BloomFest at the Tidal Basin', startDate: '2027-03-20', endDate: '2027-04-11', location: { '@type': 'Place', name: 'Tidal Basin' } },
  ] };
  const evs = eventsFrom(`<html><head><script type="application/ld+json">${JSON.stringify(ld)}</script></head><body></body></html>`, NOW);
  assert.equal(evs.length, 3);
  const ls = listingsFor(cherry, evs);
  assert.deepEqual([...new Set(ls.map(l => l.name))], ['National Cherry Blossom Festival'], 'the gala, the ceremony and BloomFest are the festival');
  const out = festivalsFrom(ls, '2026-09-28');
  assert.equal(out.length, 1); assert.equal(out[0].name, 'National Cherry Blossom Festival');
  assert.equal(out[0].startDate.slice(0, 10), '2027-03-13'); assert.equal(out[0].endDate.slice(0, 10), '2027-04-12');
});
