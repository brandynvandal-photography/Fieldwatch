// Ticketmaster Discovery API: most mid-sized and large US festivals, and everything sold through
// Front Gate. A free key from developer.ticketmaster.com allows 5,000 calls a day; one run here
// uses around a hundred. Per-day listings ("Aftershock - Friday", "- 3 Day Pass") fold into one
// festival, add-ons (parking, camping) are dropped, and anything already listed from another
// source is left alone so a curated record is never overwritten by a ticket page.
import { q } from '../db.js';
import { normalizeFestival, sameFestival, slug } from '../festivals.js';
import { iso } from '../util.js';

const API = 'https://app.ticketmaster.com/discovery/v2/events.json';
const WINDOW_DAYS = 30, WINDOWS = 12, PAGE = 200, MAX_PAGES = 5;   // the API refuses to page past 1,000 results per query
const DAY = 86_400_000;

const ADD_ON = /\b(parking|shuttle|camping|campsite|campground|locker|merch|payment plan|layaway|upgrade|add[- ]?on|glamping|rv pass|car pass|bus pass)\b/i;
const VENUE_NAMED_FESTIVAL = /\bfestival (pier|hall|park|theat\w*|grounds|stage|field|plaza|centre|center)\b/i;
const FESTY = /\bfest(ival)?s?\b|fest$/i;
const NOISE = /\b(20\d\d|(mon|tues|wednes|thurs|fri|satur|sun)day|weekend \d|day \d|\d[- ]?day|(one|two|three|four|single|multi)[- ]day|pass(es)?|vip|ga|general admission|admission|ticket(s)?|presale|early bird|tier \d|late night|after ?party|official|only)\b/gi;
const SUFFIX = /\s*[-:|–—(]\s*(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|weekend \d|day \d|\d[- ]?day|(?:one|two|three|four|single|multi)[- ]day|vip|ga\b|general admission|pass(?:es)?|presale|early bird|tier \d|late night|after ?party)[^-:|–—(]*\)?\s*$/i;

/** What two listings of the same festival share once the day and ticket words are gone. */
export const normalizeName = n => String(n).replace(/[-:|–—(),.!&+/'"]+/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
const displayName = n => { let s = String(n).trim(); for (let i = 0; i < 3; i++) s = s.replace(SUFFIX, '').trim(); return s.replace(/\s+20\d\d$/, '').replace(/[-:|–—,]+$/, '').trim(); };
const dayEnd = isoDate => iso(new Date(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) + 32 * 3_600_000));

/** One listing reduced to what matters, or null if it is not a festival we can place on a map. */
export function candidate(ev) {
  if (!ev || ev.test) return null;
  const name = ev.name || '';
  if (!name || ADD_ON.test(name)) return null;
  const c = (ev.classifications || []).find(x => x.primary) || (ev.classifications || [])[0] || {};
  const segment = c.segment?.name || '';
  if (segment && !/music/i.test(segment)) return null;
  const styled = /festival/i.test(`${c.type?.name || ''} ${c.subType?.name || ''}`);
  const lineup = ev._embedded?.attractions?.length || 0;
  if (!(styled || (FESTY.test(name) && !VENUE_NAMED_FESTIVAL.test(name)) || lineup >= 4)) return null;
  const v = ev._embedded?.venues?.[0];
  const lat = Number(v?.location?.latitude), lon = Number(v?.location?.longitude);
  if (!v || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const start = ev.dates?.start?.dateTime || (ev.dates?.start?.localDate ? `${ev.dates.start.localDate}T16:00:00Z` : null);
  if (!start || Number.isNaN(Date.parse(start))) return null;
  const end = ev.dates?.end?.dateTime || (ev.dates?.end?.localDate ? dayEnd(ev.dates.end.localDate) : null);
  return {
    key: `${normalizeName(name)}|${v.id || `${lat.toFixed(2)},${lon.toFixed(2)}`}`,
    name: displayName(name), place: [v.name, v.city?.name, v.state?.stateCode].filter(Boolean).join(', '),
    lat, lon, start, end: end && !Number.isNaN(Date.parse(end)) ? end : null, url: ev.url || null,
  };
}

/** Listings grouped into festivals: earliest start, latest end, the shortest name in the group. */
export function festivalsFrom(events, today = iso().slice(0, 10)) {
  const groups = new Map();
  for (const ev of events) { const c = candidate(ev); if (!c) continue; (groups.get(c.key) || groups.set(c.key, []).get(c.key)).push(c); }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const first = g[0];
    const name = g.map(x => x.name).filter(Boolean).sort((a, b) => a.length - b.length)[0];
    const endDate = iso(new Date(Math.max(...g.map(x => Date.parse(x.end || dayEnd(x.start))))));
    const { festival } = normalizeFestival(
      { name, location: first.place, latitude: first.lat, longitude: first.lon, startDate: first.start, endDate, source: first.url, website: first.url, verifiedOn: today },
      { origin: 'ticketmaster', status: 'published', id: `tm-${slug(name)}-${first.start.slice(0, 4)}` });
    if (festival) out.push(festival);
  }
  return out;
}

function describe(u) { return `${u.pathname}?${[...u.searchParams].filter(([k]) => k !== 'apikey').map(kv => kv.join('=')).join('&')}`; }

async function* pages(params, key, fetchImpl, pauseMs) {
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(API);
    for (const [k, v] of Object.entries({ ...params, size: PAGE, page, apikey: key })) u.searchParams.set(k, v);
    const res = await fetchImpl(u, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Ticketmaster ${res.status} for ${describe(u)}`);   // the key is never in a log line
    const body = await res.json();
    yield body._embedded?.events || [];
    if (page + 1 >= (body.page?.totalPages || 0)) return;
    if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
  }
}

export async function importTicketmaster({ key = process.env.TICKETMASTER_KEY, fetchImpl = globalThis.fetch, now = Date.now(),
  pauseMs = Number(process.env.TICKETMASTER_PAUSE_MS ?? 250), log = console } = {}) {
  if (!key) return { skipped: 'TICKETMASTER_KEY not set' };
  const events = new Map();
  let calls = 0, errors = 0;
  for (let w = 0; w < WINDOWS; w++) {
    const range = { countryCode: 'US', startDateTime: iso(new Date(now + w * WINDOW_DAYS * DAY)), endDateTime: iso(new Date(now + (w + 1) * WINDOW_DAYS * DAY)), sort: 'date,asc' };
    // Two nets: music events with "festival" in their text, and anything Ticketmaster itself styles a festival.
    for (const params of [{ ...range, classificationName: 'Music', keyword: 'festival' }, { ...range, classificationName: 'Festival' }]) {
      try { for await (const batch of pages(params, key, fetchImpl, pauseMs)) { calls++; for (const ev of batch) if (ev?.id) events.set(ev.id, ev); } }
      catch (e) { errors++; log.error(`ticketmaster: ${e.message}`); }
    }
  }
  const found = festivalsFrom([...events.values()], iso(new Date(now)).slice(0, 10));
  const existing = q.allFestivals();
  const others = existing.filter(f => f.origin !== 'ticketmaster');
  const before = new Map(existing.filter(f => f.origin === 'ticketmaster').map(f => [f.id, f]));
  let added = 0, updated = 0, duplicates = 0, pruned = 0;
  const seen = new Set();
  for (const f of found) {
    if (others.some(o => sameFestival(o, f))) { duplicates++; continue; }
    seen.add(f.id);
    const old = before.get(f.id);
    // What an admin set by hand on an imported festival stays set.
    if (old) { q.upsertFestival({ ...f, featured: old.featured, county: old.county || f.county, feeds: old.feeds, site: old.site, isPartner: old.isPartner, status: old.status }); updated++; }
    else { q.upsertFestival(f); added++; }
  }
  for (const [id, f] of before) {
    const gone = !seen.has(id), unstarted = Date.parse(f.startDate) > now, longOver = Date.parse(f.endDate) < now - 30 * DAY;
    // A listing that vanished before it started was cancelled or renamed; skip that call on a run with fetch errors.
    if ((gone && unstarted && errors === 0) || longOver) { q.deleteFestival(id); pruned++; }
  }
  return { calls, errors, events: events.size, festivals: found.length, added, updated, duplicates, pruned };
}
