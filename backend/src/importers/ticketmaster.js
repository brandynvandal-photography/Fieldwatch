// Ticketmaster Discovery API: most mid-sized and large US festivals, plus everything sold through
// Front Gate (Live Nation's festival ticketing: ACL, Bonnaroo, Aftershock) and Universe (its
// self-serve ticketing, where small independents turn up). A free key from developer.ticketmaster.com
// allows 5,000 calls a day; one run here uses around 150. Per-day listings fold into one festival
// (common.js), add-ons are dropped, and anything already listed from another source is left alone.
import { ADD_ON, CAMPING, CANCELED, FESTY, VENUE_NAMED_FESTIVAL, applyImport, dayEnd, dayStart, displayName, fetchRetry, groupListings, listingKey, normalizeName, plainlyNotFestival, errorText } from './common.js';
import { iso } from '../util.js';

export { normalizeName };
const API = 'https://app.ticketmaster.com/discovery/v2/events.json';
const WINDOW_DAYS = 30, WINDOWS = 12, PAGE = 200, MAX_PAGES = 5;   // the API refuses to page past 1,000 results per query
const REQUEST_TIMEOUT_MS = 20_000, GIVE_UP_AFTER = 6;   // a host that is down or refusing us is not asked 36 times
const DAY = 86_400_000;

/**
 * One listing reduced to what matters, or null if it is not a festival we can place on a map.
 * A trusted listing (one Front Gate sells) skips the is-it-a-festival check: "Electric Forest" has
 * no "fest" in its name and Ticketmaster often lists the festival itself as its only attraction.
 */
export function candidate(ev, { trusted = false, campingAt = null } = {}) {
  if (!ev || ev.test) return null;
  const name = ev.name || '';
  if (ADD_ON.test(name)) {   // a pass or a parking add-on is not a festival, but a camping pass says the festival has camping
    const v = ev._embedded?.venues?.[0];
    if (campingAt && CAMPING.test(name) && v) campingAt.add(v.id ? String(v.id) : `${Number(v.location?.latitude).toFixed(2)},${Number(v.location?.longitude).toFixed(2)}`);
    return null;
  }
  if (!name || CANCELED.test(name)) return null;
  if (/^(cancell?ed|postponed)$/i.test(ev.dates?.status?.code || '')) return null;
  if (!trusted && plainlyNotFestival(name)) return null;   // a tour, a benefit concert or a promoter's show styled "festival"
  const c = (ev.classifications || []).find(x => x.primary) || (ev.classifications || [])[0] || {};
  const segment = c.segment?.name || '';
  if (segment && !/music/i.test(segment)) return null;
  const styled = /festival/i.test(`${c.type?.name || ''} ${c.subType?.name || ''}`);
  const lineup = ev._embedded?.attractions?.length || 0;
  if (!trusted && !(styled || (FESTY.test(name) && !VENUE_NAMED_FESTIVAL.test(name)) || lineup >= 4)) return null;
  const v = ev._embedded?.venues?.[0];
  const lat = Number(v?.location?.latitude), lon = Number(v?.location?.longitude);
  if (!v || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const start = ev.dates?.start?.dateTime || (ev.dates?.start?.localDate ? dayStart(ev.dates.start.localDate) : null);
  if (!start || Number.isNaN(Date.parse(start))) return null;
  const end = ev.dates?.end?.dateTime || (ev.dates?.end?.localDate ? dayEnd(ev.dates.end.localDate) : null);
  return {
    key: listingKey(name, v.id, lat, lon),
    name: displayName(name), place: [v.name, v.city?.name, v.state?.stateCode].filter(Boolean).join(', '),
    lat, lon, start, end: end && !Number.isNaN(Date.parse(end)) ? end : null, url: ev.url || null,
  };
}

export const festivalsFrom = (events, today, trustedIds = new Set()) =>
  (campingAt => groupListings(events.map(ev => candidate(ev, { trusted: trustedIds.has(ev?.id), campingAt })), { origin: 'ticketmaster', prefix: 'tm', today, campingAt }))(new Set());

/** Which ticket sites the listings came from, so the first real run shows what each net caught. */
const hosts = found => found.reduce((m, f) => { try { const h = new URL(f.source).hostname.replace(/^www\./, ''); m[h] = (m[h] || 0) + 1; } catch {} return m; }, {});

function describe(u) { return `${u.pathname}?${[...u.searchParams].filter(([k]) => k !== 'apikey').map(kv => kv.join('=')).join('&')}`; }

async function* pages(params, key, fetchImpl, pauseMs, log) {
  for (let page = 0; page < MAX_PAGES; page++) {
    const u = new URL(API);
    for (const [k, v] of Object.entries({ ...params, size: PAGE, page, apikey: key })) u.searchParams.set(k, v);
    // Five calls a second is the limit; a 429 is waited out rather than counted against the run.
    const res = await fetchRetry(fetchImpl, u, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }, { log });
    if (!res.ok) throw new Error(`Ticketmaster ${res.status} for ${describe(u)}`);   // the key is never in a log line
    const body = await res.json();
    yield body._embedded?.events || [];
    if (page + 1 >= (body.page?.totalPages || 0)) return;
    if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
  }
}

export async function importTicketmaster({ key = process.env.TICKETMASTER_KEY, fetchImpl = globalThis.fetch, now = Date.now(),
  pauseMs = Number(process.env.TICKETMASTER_PAUSE_MS ?? 400), log = console } = {}) {
  if (!key) return { skipped: 'TICKETMASTER_KEY not set' };
  const events = new Map(), trusted = new Set();
  let calls = 0, errors = 0, lastError = null, streak = 0, gaveUp = false;
  windows: for (let w = 0; w < WINDOWS; w++) {
    const range = { countryCode: 'US', startDateTime: iso(new Date(now + w * WINDOW_DAYS * DAY)), endDateTime: iso(new Date(now + (w + 1) * WINDOW_DAYS * DAY)), sort: 'date,asc' };
    // Three nets: music events with "festival" in their text, anything Ticketmaster itself styles a
    // festival, and everything Front Gate sells (the first two already span every source, including Universe).
    const nets = [
      { ...range, classificationName: 'Music', keyword: 'festival' },
      { ...range, classificationName: 'Festival' },
      { ...range, classificationName: 'Music', source: 'frontgate' },
    ];
    for (const params of nets) {
      try {
        for await (const batch of pages(params, key, fetchImpl, pauseMs, log)) {
          calls++; streak = 0;
          for (const ev of batch) if (ev?.id) { events.set(ev.id, ev); if (params.source === 'frontgate') trusted.add(ev.id); }
        }
      } catch (e) {
        errors++; lastError = errorText(e); log.error(`ticketmaster: ${lastError}`);
        if (++streak >= GIVE_UP_AFTER) { gaveUp = true; log.error(`ticketmaster: ${streak} failures in a row, giving up on this run`); break windows; }
      }
    }
  }
  const found = festivalsFrom([...events.values()], iso(new Date(now)).slice(0, 10), trusted);
  return { calls, errors, ...(lastError && { lastError }), ...(gaveUp && { gaveUp: true }), events: events.size, frontgate: trusted.size, hosts: hosts(found), ...applyImport({ origin: 'ticketmaster', found, now, errors }) };
}
