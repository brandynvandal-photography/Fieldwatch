// Wikidata, no key: every US festival that has coordinates and an official website, from one
// SPARQL query. Wikidata knows where a festival is but rarely when this year's edition runs, so
// the importer reads each festival's own homepage for schema.org JSON-LD (the Festival, Event or
// MusicEvent blocks sites publish for search engines) and takes the dates from there. Sites are
// fetched politely and carefully: robots.txt is honoured (the group naming our product token, else
// the * group), redirects are followed by hand with the robots check repeated on every new origin,
// nothing but a public DNS name is ever fetched, at most WIKIDATA_MAX_SITES a run with a pause
// between them, and each site's result is remembered in the settings table for WIKIDATA_CACHE_DAYS
// so a daily run only touches sites it has not seen lately. Records fold and dedupe like the ticket
// sites' (common.js): a curated festival on the same grounds and dates is never overwritten.
import { q } from '../db.js';
import { distanceKm } from '../festivals.js';
import { applyImport, dayEnd, dayStart, displayName, groupListings, listingKey, normalizeName, errorText } from './common.js';
import { iso } from '../util.js';

export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const CACHE_KEY = 'wikidata:sites';
const DAY = 86_400_000;
const MAX_BODY = 1_000_000, SITE_TIMEOUT_MS = 8_000, SPARQL_TIMEOUT_MS = 90_000, GEO_KM = 50, WINDOW_DAYS = 365, MAX_EVENTS = 50;
const CLUSTER_DAYS = 14, MAX_HOPS = 5;
const EVENT_TYPES = new Set(['festival', 'musicevent', 'event']);
const OFF = new Set(['false', '0', 'no']);

// Instances (or instances of subclasses) of music festival or festival, in the United States, with
// coordinates, not dissolved; the official website, the venue and the town when Wikidata has them.
export const SPARQL = `SELECT DISTINCT ?item ?itemLabel ?coord ?website ?venueLabel ?adminLabel WHERE {
  VALUES ?class { wd:Q868557 wd:Q132241 }
  ?item wdt:P31/wdt:P279* ?class ;
        wdt:P17 wd:Q30 ;
        wdt:P625 ?coord .
  OPTIONAL { ?item wdt:P856 ?website . }
  OPTIONAL { ?item wdt:P276 ?venue . }
  OPTIONAL { ?item wdt:P131 ?admin . }
  FILTER NOT EXISTS { ?item wdt:P576 ?dissolved . }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}`;

/**
 * Why a run would not happen: WIKIDATA_IMPORT=false, 0 or no switches it off; otherwise it is on, but only
 * once NWS_USER_AGENT says who we are, since the festival sites we read (and Wikidata) must be able to reach us.
 */
export function skipReason({ enabled = process.env.WIKIDATA_IMPORT, userAgent = process.env.NWS_USER_AGENT } = {}) {
  if (enabled === false || OFF.has(String(enabled ?? '').trim().toLowerCase())) return 'WIKIDATA_IMPORT=false';
  if (!String(userAgent || '').trim() || /example\.com/i.test(userAgent)) return 'NWS_USER_AGENT is unset or still the example.com placeholder; set a real contact before festival sites are read';
  return null;
}

/** The product token robots.txt would name us by: the first word of the User-Agent, before any version or contact. */
export const productToken = (ua = process.env.NWS_USER_AGENT) => (String(ua || '').match(/^[a-z0-9_.-]+/i)?.[0] || 'Fieldwatch').toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

const PRIVATE_TLDS = new Set(['localhost', 'local', 'localdomain', 'internal', 'intranet', 'lan', 'home', 'corp', 'arpa', 'onion', 'invalid']);
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/**
 * Only a public DNS name is ever fetched: no IP literal in any spelling (the last label must be letters),
 * no bracketed IPv6, no localhost, nothing under .local or another private suffix, no bare hostname.
 */
export function publicHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253 || /[^a-z0-9.-]/.test(h)) return false;
  const labels = h.split('.');
  if (labels.length < 2 || !labels.every(l => LABEL.test(l))) return false;
  const tld = labels[labels.length - 1];
  return /^[a-z]{2,63}$/.test(tld) && !PRIVATE_TLDS.has(tld);
}
const canonical = s => { try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) && publicHost(u.hostname) ? u.href : null; } catch { return null; } };
const qnum = qid => Number(qid.slice(1));

/** SPARQL JSON results into candidates { qid, name, latitude, longitude, website, place }; one per item, one per website. */
export function parseCandidates(body) {
  const items = new Map();   // qid -> candidate, in order of first appearance
  for (const b of body?.results?.bindings || []) {
    const qid = String(b.item?.value || '').split('/').pop();
    if (!/^Q\d+$/.test(qid)) continue;
    const website = canonical(b.website?.value);
    const have = items.get(qid);
    if (have) {   // another row for the same item (a second website, venue or town): the shortest site is the homepage
      if (website && (!have.website || website.length < have.website.length || (website.length === have.website.length && website < have.website))) have.website = website;
      continue;
    }
    const name = (b.itemLabel?.value || '').trim();
    if (!name || name === qid) continue;                       // no English label: nothing to call it
    const m = String(b.coord?.value || '').match(/Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
    if (!m) continue;
    const longitude = Number(m[1]), latitude = Number(m[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) continue;
    const place = [b.venueLabel?.value, b.adminLabel?.value].map(s => (s || '').trim()).filter(s => s && !/^Q\d+$/.test(s)).join(', ');
    items.set(qid, { qid, name, latitude, longitude, website, place: place || null });
  }
  // Two items on one site would be one festival twice: the lowest id keeps it, whatever order the endpoint returned.
  const owner = new Map();
  for (const c of items.values()) if (c.website && (!owner.has(c.website) || qnum(c.qid) < qnum(owner.get(c.website).qid))) owner.set(c.website, c);
  return [...items.values()].filter(c => !c.website || owner.get(c.website) === c);
}

/** A robots.txt rule against a path: * matches any run, $ pins the end, otherwise it is a prefix. Linear, so a hostile file cannot stall us. */
export function ruleMatches(pattern, path) {
  const anchored = pattern.endsWith('$');
  const parts = (anchored ? pattern.slice(0, -1) : pattern).split('*');
  const head = parts.shift();
  if (!path.startsWith(head)) return false;
  let pos = head.length;
  const tail = anchored && parts.length ? parts.pop() : null;
  for (const p of parts) { const i = path.indexOf(p, pos); if (i < 0) return false; pos = i + p.length; }
  if (tail !== null) return path.endsWith(tail) && path.length - tail.length >= pos;
  return !anchored || pos === path.length;
}

/**
 * Does robots.txt let us fetch this path? The group naming our product token counts when there is one, else
 * the * group; the longest matching rule wins, Allow on a tie, no rules means yes. Other fields (Sitemap,
 * Crawl-delay) never split a group.
 */
export function robotsAllows(text, path = '/', product = productToken()) {
  const groups = []; let group = null, inRules = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const m = raw.replace(/#.*$/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') {
      if (!group || inRules) { group = { agents: [], rules: [] }; groups.push(group); inRules = false; }
      group.agents.push(value.split('/')[0].trim().toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && group) {
      inRules = true;
      if (value) group.rules.push({ allow: field === 'allow', pattern: value, length: value.length });   // "Disallow:" with nothing after it allows everything
    }
  }
  const mine = groups.filter(g => g.agents.includes(String(product).toLowerCase()));
  const rules = (mine.length ? mine : groups.filter(g => g.agents.includes('*'))).flatMap(g => g.rules);
  const hit = rules.filter(r => ruleMatches(r.pattern, path)).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow))[0];
  return !hit || hit.allow;
}

const typeNames = t => [].concat(t || []).map(x => String(typeof x === 'object' ? x?.['@id'] || '' : x).split(/[/#:]/).pop().toLowerCase());
const geoOf = loc => {
  for (const l of [].concat(loc || [])) {
    const g = l?.geo && !Array.isArray(l.geo) ? l.geo : [].concat(l?.geo || [])[0];
    const lat = Number(g?.latitude), lon = Number(g?.longitude);
    if (Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0)) return { lat, lon };
  }
  return null;
};
const placeOf = loc => {
  for (const l of [].concat(loc || [])) {
    if (!l || typeof l !== 'object') continue;
    const a = l.address && typeof l.address === 'object' ? l.address : {};
    const s = [l.name, a.addressLocality, a.addressRegion].map(x => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).join(', ');
    if (s) return s;
  }
  return null;
};
/** A schema.org date as an ISO stamp: a bare date is the whole day (afternoon start, small-hours end), anything unreadable is null. */
const stamp = (s, endOfDay = false) => {
  if (typeof s !== 'string' || Number.isNaN(Date.parse(s))) return null;
  const t = s.trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(t) ? (endOfDay ? dayEnd(t) : dayStart(t)) : iso(new Date(t));
};

/** The bodies of the page's JSON-LD script blocks, by one linear walk of the text; a <script> that never closes ends the scan. */
function* ldBlocks(html) {
  const low = html.toLowerCase();
  for (let at = 0; ;) {
    const open = low.indexOf('<script', at);
    if (open < 0) return;
    const gt = low.indexOf('>', open);
    if (gt < 0) return;
    const close = low.indexOf('</script', gt + 1);
    if (close < 0) return;
    const tag = low.slice(open, gt + 1);
    if (/^<script[\s>]/.test(tag) && /type\s*=\s*["']?application\/ld\+json/.test(tag)) yield html.slice(gt + 1, close);
    at = close + 8;
  }
}

/** Every JSON-LD node in the page, @graph arrays and subEvents included. */
function* nodes(html) {
  const walk = function* (v, depth) {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) yield* walk(x, depth + 1); return; }
    yield v;
    for (const k of ['@graph', 'subEvent', 'itemListElement', 'mainEntity', 'item']) if (v[k]) yield* walk(v[k], depth + 1);
  };
  for (const block of ldBlocks(html)) {
    let parsed;
    try { parsed = JSON.parse(block.replace(/^\s*(<!--|\/\*\s*<!\[CDATA\[\s*\*\/)/, '').replace(/(-->|\/\*\s*\]\]>\s*\*\/)\s*$/, '').trim()); } catch { continue; }
    yield* walk(parsed, 0);
  }
}

const NOT_ON = /cancel|postpon|movedonline/;
/**
 * The events a page's JSON-LD announces that fall in the next twelve months (or are on now):
 * { start, end, name?, lat?, lon?, place? }. A bare date is a whole day; no end means the same day.
 */
export function eventsFrom(html, now = Date.now()) {
  const out = [], seen = new Set();
  for (const n of nodes(String(html || ''))) {
    if (!typeNames(n['@type']).some(t => EVENT_TYPES.has(t))) continue;
    if (typeNames(n.eventStatus).some(t => NOT_ON.test(t))) continue;                   // cancelled, postponed or moved online; a string or an { "@id" }
    if (typeNames(n.eventAttendanceMode).some(t => t.startsWith('online'))) continue;   // a stream is not a place
    const start = stamp(n.startDate);
    if (!start) continue;
    let end = stamp(n.endDate, true);
    if (!end || Date.parse(end) < Date.parse(start)) end = dayEnd(start);   // no end, or nonsense: the same day, taken from the normalised start
    if (Date.parse(end) < now || Date.parse(start) > now + WINDOW_DAYS * DAY) continue;   // last year's page, or the edition after next
    const geo = geoOf(n.location), place = placeOf(n.location), name = typeof n.name === 'string' ? n.name.trim().slice(0, 120) : '';
    const key = `${start}|${end}|${geo?.lat ?? ''}|${geo?.lon ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end, ...(name ? { name } : {}), ...(geo ? { lat: geo.lat, lon: geo.lon } : {}), ...(place ? { place } : {}) });
  }
  return out.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)).slice(0, MAX_EVENTS);
}

async function readUpTo(res, max) {
  if (!res.body?.getReader) return String(await res.text()).slice(0, max);
  const reader = res.body.getReader(), chunks = []; let size = 0;
  try { while (size < max) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); size += value.byteLength; } }
  finally { try { await reader.cancel(); } catch {} }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}
const drop = async res => { try { await res.body?.cancel(); } catch {} };

const REDIRECT = new Set([301, 302, 303, 307, 308]);
const guard = (u, why) => { if (!/^https?:$/.test(u.protocol) || !publicHost(u.hostname)) throw new Error(why); };
/**
 * One request with redirects followed by hand: at most MAX_HOPS, only to http(s) on a public DNS name (checked
 * before every hop, the first included), and `allowed(url)` asked before each hop when given. Returns
 * { res, url, calls }, or { calls, robots: true } when `allowed` said no.
 */
async function fetchFollowing(fetchImpl, url, { timeoutMs, accept, userAgent, allowed = null }) {
  let u = new URL(url), calls = 0;
  guard(u, 'not a public host');
  for (let hop = 0; ; hop++) {
    const res = await fetchImpl(u, { headers: { 'User-Agent': userAgent, Accept: accept }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    calls++;
    if (!REDIRECT.has(res.status)) return { res, url: u, calls };
    await drop(res);
    const location = res.headers.get('location');
    if (!location) throw new Error(`HTTP ${res.status} without a Location`);
    if (hop >= MAX_HOPS) throw new Error('too many redirects');
    let next; try { next = new URL(location, u); } catch { throw new Error('unreadable redirect'); }
    next.hash = '';
    guard(next, 'redirect to a private address');   // before anything is asked of the new host, robots.txt included
    if (allowed && !(await allowed(next))) return { calls, robots: true };
    u = next;
  }
}

/**
 * One site: robots.txt, then the homepage's JSON-LD, robots.txt read again for every origin a redirect leads to.
 * Returns { calls, events, robots }; throws when the site could not be read, a robots.txt that answers 5xx
 * included (the site keeps its last answer and is asked again later).
 */
export async function checkSite(website, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = SITE_TIMEOUT_MS, userAgent = process.env.NWS_USER_AGENT || 'Fieldwatch' } = {}) {
  let calls = 0;
  const opts = { timeoutMs, userAgent }, robotsByOrigin = new Map();
  const allowed = async u => {
    if (!robotsByOrigin.has(u.origin)) {
      const r = await fetchFollowing(fetchImpl, new URL('/robots.txt', u.origin), { ...opts, accept: 'text/plain' });
      calls += r.calls;
      if (r.res.status >= 500) { await drop(r.res); throw new Error(`robots.txt HTTP ${r.res.status}`); }
      if (r.res.ok) robotsByOrigin.set(u.origin, await readUpTo(r.res, 200_000));
      else { await drop(r.res); robotsByOrigin.set(u.origin, ''); }   // no robots.txt: no rules
    }
    return robotsAllows(robotsByOrigin.get(u.origin), u.pathname + u.search, productToken(userAgent));
  };
  const site = new URL(website);
  guard(site, 'not a public host');
  if (!(await allowed(site))) return { calls, events: [], robots: true };
  const page = await fetchFollowing(fetchImpl, site, { ...opts, accept: 'text/html,application/xhtml+xml', allowed });
  calls += page.calls;
  if (page.robots) return { calls, events: [], robots: true };
  if (!page.res.ok) { await drop(page.res); throw new Error(`HTTP ${page.res.status}`); }
  return { calls, events: eventsFrom(await readUpTo(page.res, MAX_BODY), now), robots: false };
}

/**
 * Listings for groupListings, one per event in the first fortnight the page announces: a homepage that also
 * lists next spring's edition, or a season of shows, gives one festival, not a record spanning months. A block
 * named after the festival carries Wikidata's label and folds with its per-day siblings; a differently named
 * block on the same page (a pre-party, a winter ball) keeps its own name and is its own record. The key is
 * that name and the item, so two festivals on one site, or two items with one label, never fold.
 */
export function listingsFor(c, events) {
  const starts = events.map(ev => Date.parse(ev.start)).filter(Number.isFinite);
  if (!starts.length) return [];
  const cutoff = Math.min(...starts) + CLUSTER_DAYS * DAY;
  const label = normalizeName(c.name);
  return events.filter(ev => Date.parse(ev.start) <= cutoff).map(ev => {
    const near = ev.lat !== undefined && distanceKm({ latitude: c.latitude, longitude: c.longitude }, { latitude: ev.lat, longitude: ev.lon }) <= GEO_KM;
    const n = normalizeName(ev.name || '');
    const own = n && !n.includes(label) && !(n.length >= 3 && label.includes(n)) ? displayName(ev.name) : '';
    const name = own || c.name;
    return { key: listingKey(name, c.qid), name, place: c.place || ev.place || 'United States', lat: near ? ev.lat : c.latitude, lon: near ? ev.lon : c.longitude, start: ev.start, end: ev.end, url: c.website, qid: c.qid };
  });
}

/** One festival per group, its id carrying the item (wd-q123-riverfest-2026) so two Riverfests never share one; deduped by id. */
export function festivalsFrom(listings, today) {
  const byQid = new Map();
  for (const l of listings) if (l?.qid) (byQid.get(l.qid) || byQid.set(l.qid, []).get(l.qid)).push(l);
  const out = [], ids = new Set();
  for (const [qid, group] of byQid) {
    for (const f of groupListings(group, { origin: 'wikidata', prefix: `wd-${qid.toLowerCase()}`, today })) {
      if (ids.has(f.id)) continue;
      ids.add(f.id); out.push({ ...f, wikidata: qid });
    }
  }
  return out;
}

const readCache = () => { try { const v = JSON.parse(q.setting(CACHE_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

export async function importWikidata({ enabled = process.env.WIKIDATA_IMPORT, userAgent = process.env.NWS_USER_AGENT, fetchImpl = globalThis.fetch, now = Date.now(),
  pauseMs = Number(process.env.WIKIDATA_PAUSE_MS ?? 400), maxSites = Number(process.env.WIKIDATA_MAX_SITES ?? 250),
  cacheDays = Number(process.env.WIKIDATA_CACHE_DAYS ?? 6), timeoutMs = SITE_TIMEOUT_MS, log = console } = {}) {
  const skipped = skipReason({ enabled, userAgent });
  if (skipped) return { skipped };
  let calls = 0, errors = 0, sitesChecked = 0, candidates = [], queried = false, lastError = null;
  try {
    const u = new URL(SPARQL_ENDPOINT);
    u.searchParams.set('query', SPARQL); u.searchParams.set('format', 'json');
    const res = await fetchImpl(u, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': userAgent }, signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS) });
    calls++;
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    candidates = parseCandidates(await res.json());
    queried = true;
  } catch (e) { errors++; lastError = errorText(e); log.error(`wikidata: ${lastError}`); }

  // Per-site memory: { [website]: { checkedAt, ok, events?, robots?, error? } }. A hit keeps its events so the
  // festival is still produced (and not pruned) on the days the site is not fetched.
  const cache = readCache(), listings = [], at = iso(new Date(now));
  const fresh = e => e && Number.isFinite(Date.parse(e.checkedAt)) && now - Date.parse(e.checkedAt) < cacheDays * DAY;
  // Sites never seen first, then the ones checked longest ago: the tail of a long result is reached before the head comes round again.
  const checked = c => { const t = Date.parse(cache[c.website]?.checkedAt); return Number.isFinite(t) ? t : -1; };
  const sites = candidates.filter(c => c.website).sort((a, b) => checked(a) - checked(b));
  for (const c of sites) {
    let entry = cache[c.website];
    if (!fresh(entry) && sitesChecked < maxSites) {
      if (sitesChecked && pauseMs) await sleep(pauseMs);
      sitesChecked++;
      try {
        const r = await checkSite(c.website, { fetchImpl, now, timeoutMs, userAgent });
        calls += r.calls;
        entry = { checkedAt: at, ok: r.events.length > 0, ...(r.events.length ? { events: r.events } : {}), ...(r.robots ? { robots: true } : {}) };
      } catch (e) {
        // A site that is down today keeps what it said last time; it is asked again when that expires.
        errors++; lastError = `${c.website}: ${errorText(e)}`; log.error(`wikidata ${lastError}`);
        entry = { ...(entry || { ok: false }), checkedAt: at, error: String(e.message).slice(0, 120) };
      }
      cache[c.website] = entry;
    }
    if (entry?.ok) listings.push(...listingsFor(c, entry.events || []));
  }
  if (queried) { const known = new Set(sites.map(c => c.website)); for (const k of Object.keys(cache)) if (!known.has(k)) delete cache[k]; }
  try { q.setSetting(CACHE_KEY, JSON.stringify(cache)); } catch (e) { errors++; log.error(`wikidata cache: ${e.message}`); }

  const found = festivalsFrom(listings, at.slice(0, 10));
  // Only a failed query blocks prune-on-absence: a site that is down kept its last answer, and is no reason to
  // keep a listing that vanished from a site that answered. The report still counts every error.
  return { calls, errors, ...(lastError && { lastError }), candidates: candidates.length, sitesChecked, ...applyImport({ origin: 'wikidata', found, now, errors: queried ? 0 : 1 }) };
}
