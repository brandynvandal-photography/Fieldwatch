// SeatGeek Platform API: a free client id (seatgeek.com/account/develop) and a music_festival
// taxonomy, which reaches a lot of ticketing Ticketmaster does not carry, including smaller
// independents. Listings fold into festivals exactly as Ticketmaster's do (common.js).
import { ADD_ON, applyImport, dayEnd, dayStart, displayName, groupListings, listingKey } from './common.js';
import { iso } from '../util.js';

const API = 'https://api.seatgeek.com/2/events';
const PER_PAGE = 100, MAX_PAGES = 60, DAY = 86_400_000;

// SeatGeek stamps UTC times without a zone marker.
const utc = s => (s && !/Z$|[+-]\d\d:\d\d$/.test(s) ? `${s}Z` : s);

/** One listing reduced to what matters, or null if it is not a festival we can place on a map. */
export function candidate(ev) {
  if (!ev) return null;
  const name = ev.title || ev.short_title || '';
  if (!name || ADD_ON.test(name) || ev.date_tbd) return null;
  const festival = ev.type === 'music_festival' || (ev.taxonomies || []).some(t => t.name === 'music_festival');
  if (!festival) return null;
  const v = ev.venue;
  const lat = Number(v?.location?.lat), lon = Number(v?.location?.lon);
  if (!v || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  if (v.country && v.country !== 'US') return null;
  const day = (ev.datetime_local || ev.datetime_utc || '').slice(0, 10);
  const start = ev.time_tbd ? (day ? dayStart(day) : null) : utc(ev.datetime_utc);
  if (!start || Number.isNaN(Date.parse(start))) return null;
  const end = ev.enddatetime_utc ? utc(ev.enddatetime_utc) : null;
  return {
    key: listingKey(name, v.id, lat, lon),
    name: displayName(name), place: [v.name, v.city, v.state].filter(Boolean).join(', '),
    lat, lon, start, end: end && !Number.isNaN(Date.parse(end)) ? end : null, url: ev.url || null,
  };
}

export const festivalsFrom = (events, today) => groupListings(events.map(candidate), { origin: 'seatgeek', prefix: 'sg', today });

function describe(u) { return `${u.pathname}?${[...u.searchParams].filter(([k]) => k !== 'client_id').map(kv => kv.join('=')).join('&')}`; }

export async function importSeatGeek({ clientId = process.env.SEATGEEK_CLIENT_ID, fetchImpl = globalThis.fetch, now = Date.now(),
  pauseMs = Number(process.env.SEATGEEK_PAUSE_MS ?? 250), log = console } = {}) {
  if (!clientId) return { skipped: 'SEATGEEK_CLIENT_ID not set' };
  const events = new Map();
  let calls = 0, errors = 0;
  try {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const u = new URL(API);
      for (const [k, v] of Object.entries({ 'taxonomies.name': 'music_festival', 'venue.country': 'US', 'datetime_utc.gte': iso(new Date(now)).slice(0, 10),
        'datetime_utc.lte': iso(new Date(now + 365 * DAY)).slice(0, 10), sort: 'datetime_utc.asc', per_page: PER_PAGE, page, client_id: clientId })) u.searchParams.set(k, v);
      const res = await fetchImpl(u, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`SeatGeek ${res.status} for ${describe(u)}`);   // the id is never in a log line
      const body = await res.json();
      calls++;
      for (const ev of body.events || []) if (ev?.id) events.set(ev.id, ev);
      const total = body.meta?.total ?? 0;
      if (!(body.events || []).length || page * PER_PAGE >= total) break;
      if (pauseMs) await new Promise(r => setTimeout(r, pauseMs));
    }
  } catch (e) { errors++; log.error(`seatgeek: ${e.message}`); }
  const found = festivalsFrom([...events.values()], iso(new Date(now)).slice(0, 10));
  return { calls, errors, events: events.size, ...applyImport({ origin: 'seatgeek', found, now, errors }) };
}
