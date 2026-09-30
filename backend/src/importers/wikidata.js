// Wikidata, no key: every US festival that has coordinates and an official website, from one
// SPARQL query. Wikidata knows where a festival is but rarely when this year's edition runs, so
// the importer reads each festival's own homepage for schema.org JSON-LD (the Festival, Event or
// MusicEvent blocks sites publish for search engines) and takes the dates from there. Sites are
// fetched politely: robots.txt is honoured, at most WIKIDATA_MAX_SITES a run with a pause between
// them, and each site's result is remembered in the settings table for WIKIDATA_CACHE_DAYS so a
// daily run only touches sites it has not seen lately. Records fold and dedupe like the ticket
// sites' (common.js): a curated festival on the same grounds and dates is never overwritten.
import { q } from '../db.js';
import { distanceKm } from '../festivals.js';
import { applyImport, dayEnd, dayStart, groupListings } from './common.js';
import { iso } from '../util.js';

export const SPARQL_ENDPOINT = 'https://query.wikidata.org/sparql';
export const CACHE_KEY = 'wikidata:sites';
const DAY = 86_400_000;
const MAX_BODY = 1_000_000, SITE_TIMEOUT_MS = 8_000, SPARQL_TIMEOUT_MS = 90_000, GEO_KM = 50, WINDOW_DAYS = 365, MAX_EVENTS = 50;
const EVENT_TYPES = new Set(['festival', 'musicevent', 'event']);

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

const agent = () => process.env.NWS_USER_AGENT || 'Fieldwatch';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const canonical = s => { try { const u = new URL(String(s)); return /^https?:$/.test(u.protocol) && u.hostname.includes('.') ? u.href : null; } catch { return null; } };

/** SPARQL JSON results into candidates { qid, name, latitude, longitude, website, place }; one per item, one per website. */
export function parseCandidates(body) {
  const out = [], seen = new Set(), sites = new Set();
  for (const b of body?.results?.bindings || []) {
    const qid = String(b.item?.value || '').split('/').pop();
    if (!/^Q\d+$/.test(qid) || seen.has(qid)) continue;
    const name = (b.itemLabel?.value || '').trim();
    if (!name || name === qid) continue;                       // no English label: nothing to call it
    const m = String(b.coord?.value || '').match(/Point\(\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\)/i);
    if (!m) continue;
    const longitude = Number(m[1]), latitude = Number(m[2]);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) continue;
    const website = canonical(b.website?.value);
    if (website && sites.has(website)) continue;               // two items sharing a site would be one festival twice
    seen.add(qid); if (website) sites.add(website);
    const place = [b.venueLabel?.value, b.adminLabel?.value].map(s => (s || '').trim()).filter(s => s && !/^Q\d+$/.test(s)).join(', ');
    out.push({ qid, name, latitude, longitude, website, place: place || null });
  }
  return out;
}

/** Does robots.txt let User-agent: * fetch this path? Longest matching rule wins, Allow on a tie, no rules means yes. */
export function robotsAllows(text, path = '/') {
  const rules = []; let applies = false, sawAgent = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const field = m[1].toLowerCase(), value = m[2].trim();
    if (field === 'user-agent') { if (!sawAgent) applies = false; sawAgent = true; if (value === '*') applies = true; continue; }
    sawAgent = false;
    if (!applies || (field !== 'allow' && field !== 'disallow')) continue;
    if (field === 'disallow' && value === '') continue;        // "Disallow:" with nothing after it allows everything
    const pattern = value.replace(/\$$/, '').split('*')[0];    // a wildcard rule matches by its prefix; close enough
    rules.push({ allow: field === 'allow', pattern, length: value.length });
  }
  const hit = rules.filter(r => path.startsWith(r.pattern)).sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow))[0];
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

/** Every JSON-LD node in the page, @graph arrays and subEvents included. */
function* nodes(html) {
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;
  const walk = function* (v, depth) {
    if (!v || typeof v !== 'object' || depth > 6) return;
    if (Array.isArray(v)) { for (const x of v) yield* walk(x, depth + 1); return; }
    yield v;
    for (const k of ['@graph', 'subEvent', 'itemListElement', 'mainEntity', 'item']) if (v[k]) yield* walk(v[k], depth + 1);
  };
  for (const m of html.matchAll(re)) {
    let parsed;
    try { parsed = JSON.parse(m[1].replace(/^\s*(<!--|\/\*\s*<!\[CDATA\[\s*\*\/)/, '').replace(/(-->|\/\*\s*\]\]>\s*\*\/)\s*$/, '').trim()); } catch { continue; }
    yield* walk(parsed, 0);
  }
}

/**
 * The events a page's JSON-LD announces that fall in the next twelve months (or are on now):
 * { start, end, lat, lon, place }. A bare date is a whole day; no end means the same day.
 */
export function eventsFrom(html, now = Date.now()) {
  const out = [], seen = new Set();
  for (const n of nodes(String(html || ''))) {
    if (!typeNames(n['@type']).some(t => EVENT_TYPES.has(t))) continue;
    if (/cancelled|canceled|postponed/i.test(String(n.eventStatus || ''))) continue;
    if (/online/i.test(String(n.eventAttendanceMode || ''))) continue;
    const start = stamp(n.startDate);
    if (!start) continue;
    let end = stamp(n.endDate, true);
    if (!end || Date.parse(end) < Date.parse(start)) end = dayEnd(n.startDate.trim().slice(0, 10));   // no end, or nonsense: the same day
    if (Date.parse(end) < now || Date.parse(start) > now + WINDOW_DAYS * DAY) continue;   // last year's page, or the edition after next
    const geo = geoOf(n.location), place = placeOf(n.location);
    const key = `${start}|${end}|${geo?.lat ?? ''}|${geo?.lon ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ start, end, ...(geo ? { lat: geo.lat, lon: geo.lon } : {}), ...(place ? { place } : {}) });
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

const get = (fetchImpl, url, timeoutMs, accept) => fetchImpl(url, { headers: { 'User-Agent': agent(), Accept: accept }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });

/** One site: robots.txt, then the homepage's JSON-LD. Returns { calls, events, robots }; throws when the site could not be read. */
export async function checkSite(website, { fetchImpl = globalThis.fetch, now = Date.now(), timeoutMs = SITE_TIMEOUT_MS } = {}) {
  const site = new URL(website);
  let calls = 1;
  const robots = await get(fetchImpl, new URL('/robots.txt', site), timeoutMs, 'text/plain');
  if (robots.ok && !robotsAllows(await readUpTo(robots, 200_000), site.pathname || '/')) return { calls, events: [], robots: true };
  const res = await get(fetchImpl, site, timeoutMs, 'text/html,application/xhtml+xml');
  calls++;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { calls, events: eventsFrom(await readUpTo(res, MAX_BODY), now), robots: false };
}

/** Listings for groupListings: one per event on the site, keyed by the item so a site's per-day events fold into one festival. */
export function listingsFor(c, events) {
  return events.map(ev => {
    const near = ev.lat !== undefined && distanceKm({ latitude: c.latitude, longitude: c.longitude }, { latitude: ev.lat, longitude: ev.lon }) <= GEO_KM;
    return { key: `wd:${c.qid}`, name: c.name, place: c.place || ev.place || 'United States', lat: near ? ev.lat : c.latitude, lon: near ? ev.lon : c.longitude, start: ev.start, end: ev.end, url: c.website, qid: c.qid };
  });
}

export function festivalsFrom(listings, today) {
  const qids = new Map(listings.map(l => [l.url, l.qid]));
  return groupListings(listings, { origin: 'wikidata', prefix: 'wd', today }).map(f => ({ ...f, wikidata: qids.get(f.source) || qids.get(f.website) || null }));
}

const readCache = () => { try { const v = JSON.parse(q.setting(CACHE_KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };

export async function importWikidata({ enabled = process.env.WIKIDATA_IMPORT !== 'false', fetchImpl = globalThis.fetch, now = Date.now(),
  pauseMs = Number(process.env.WIKIDATA_PAUSE_MS ?? 400), maxSites = Number(process.env.WIKIDATA_MAX_SITES ?? 250),
  cacheDays = Number(process.env.WIKIDATA_CACHE_DAYS ?? 6), timeoutMs = SITE_TIMEOUT_MS, log = console } = {}) {
  if (!enabled) return { skipped: 'WIKIDATA_IMPORT=false' };
  let calls = 0, errors = 0, sitesChecked = 0, candidates = [], queried = false;
  try {
    const u = new URL(SPARQL_ENDPOINT);
    u.searchParams.set('query', SPARQL); u.searchParams.set('format', 'json');
    const res = await fetchImpl(u, { headers: { Accept: 'application/sparql-results+json', 'User-Agent': agent() }, signal: AbortSignal.timeout(SPARQL_TIMEOUT_MS) });
    calls++;
    if (!res.ok) throw new Error(`SPARQL ${res.status}`);
    candidates = parseCandidates(await res.json());
    queried = true;
  } catch (e) { errors++; log.error(`wikidata: ${e.message}`); }

  // Per-site memory: { [website]: { checkedAt, ok, events?, robots?, error? } }. A hit keeps its events so the
  // festival is still produced (and not pruned) on the days the site is not fetched.
  const cache = readCache(), listings = [], at = iso(new Date(now));
  const fresh = e => e && Number.isFinite(Date.parse(e.checkedAt)) && now - Date.parse(e.checkedAt) < cacheDays * DAY;
  for (const c of candidates) {
    if (!c.website) continue;
    let entry = cache[c.website];
    if (!fresh(entry) && sitesChecked < maxSites) {
      if (sitesChecked && pauseMs) await sleep(pauseMs);
      sitesChecked++;
      try {
        const r = await checkSite(c.website, { fetchImpl, now, timeoutMs });
        calls += r.calls;
        entry = { checkedAt: at, ok: r.events.length > 0, ...(r.events.length ? { events: r.events } : {}), ...(r.robots ? { robots: true } : {}) };
      } catch (e) {
        // A site that is down today keeps what it said last time; it is asked again when that expires.
        errors++; log.error(`wikidata ${c.website}: ${e.message}`);
        entry = { ...(entry || { ok: false }), checkedAt: at, error: String(e.message).slice(0, 120) };
      }
      cache[c.website] = entry;
    }
    if (entry?.ok) listings.push(...listingsFor(c, entry.events || []));
  }
  if (queried) { const sites = new Set(candidates.map(c => c.website)); for (const k of Object.keys(cache)) if (!sites.has(k)) delete cache[k]; }
  try { q.setSetting(CACHE_KEY, JSON.stringify(cache)); } catch (e) { errors++; log.error(`wikidata cache: ${e.message}`); }

  const found = festivalsFrom(listings, at.slice(0, 10));
  return { calls, errors, candidates: candidates.length, sitesChecked, ...applyImport({ origin: 'wikidata', found, now, errors }) };
}
