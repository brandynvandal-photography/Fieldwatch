// Edmtrain: electronic events across the US with a festival flag and venue coordinates, behind
// a client key from edmtrain.com/developer-api. Their API terms: show each event's link exactly
// as the API gave it (it is stored as the record's source and website), never resell the data,
// never share the key. One request returns every upcoming festival.
import { ADD_ON, applyImport, dayEnd, dayStart, displayName, groupListings, listingKey, usState } from './common.js';
import { iso } from '../util.js';

const API = 'https://edmtrain.com/api/events';
const DAY = 86_400_000;

/** One listing reduced to what matters, or null if it is not a US festival we can place on a map. */
export function candidate(ev) {
  if (!ev || ev.festivalInd === false || ev.livestreamInd) return null;
  const name = ev.name || '';
  if (!name || ADD_ON.test(name)) return null;
  const v = ev.venue;
  const lat = Number(v?.latitude), lon = Number(v?.longitude);
  if (!v || !Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const stateInLocation = String(v.location || '').split(',').pop();
  if (!usState(v.state) && !usState(stateInLocation)) return null;
  if (!ev.date || Number.isNaN(Date.parse(ev.date))) return null;
  return {
    key: listingKey(name, v.id, lat, lon),
    name: displayName(name), place: [v.name, v.location].filter(Boolean).join(', '),
    lat, lon, start: dayStart(ev.date), end: dayEnd(ev.date), url: ev.link || null,
  };
}

export const festivalsFrom = (events, today) => groupListings(events.map(candidate), { origin: 'edmtrain', prefix: 'edm', today });

export async function importEdmtrain({ key = process.env.EDMTRAIN_KEY, fetchImpl = globalThis.fetch, now = Date.now(), log = console } = {}) {
  if (!key) return { skipped: 'EDMTRAIN_KEY not set' };
  let events = [], errors = 0, calls = 0;
  try {
    const u = new URL(API);
    for (const [k, v] of Object.entries({ festivalInd: 'true', startDate: iso(new Date(now)).slice(0, 10), endDate: iso(new Date(now + 365 * DAY)).slice(0, 10), client: key })) u.searchParams.set(k, v);
    const res = await fetchImpl(u, { headers: { Accept: 'application/json' } });
    calls++;
    if (!res.ok) throw new Error(`Edmtrain ${res.status}`);   // the key is never in a log line
    const body = await res.json();
    if (body.success === false) throw new Error(`Edmtrain: ${body.message || 'request refused'}`);
    events = Array.isArray(body.data) ? body.data : [];
  } catch (e) { errors++; log.error(`edmtrain: ${e.message}`); }
  const found = festivalsFrom(events, iso(new Date(now)).slice(0, 10));
  return { calls, errors, events: events.length, ...applyImport({ origin: 'edmtrain', found, now, errors }) };
}
