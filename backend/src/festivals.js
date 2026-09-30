// One festival record: the shape every source must produce and every client expects.
// Curated JSON, Ticketmaster, a feed URL and a stranger's phone all pass through normalizeFestival.
import { iso } from './util.js';
import { sameCore } from './names.js';

export const slug = s => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);

export const validIso = s => (s && !Number.isNaN(Date.parse(s)) ? iso(new Date(s)) : null);

const BARE_DATE = /^\s*(\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4})\s*$/;
const HOUR = 3_600_000, DAY = 24 * HOUR;
// A date with no time means the whole day: gates at noon UTC, and "last day" runs into the small hours after it.
const dayStart = d => iso(new Date(Date.parse(bareToIso(d)) + 12 * HOUR));
const dayEnd = d => iso(new Date(Date.parse(bareToIso(d)) + 32 * HOUR));
const bareToIso = d => { const m = String(d).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/); return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}T00:00:00Z` : `${String(d).trim()}T00:00:00Z`; };

const text = (v, max = 120) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const bool = v => (typeof v === 'string' ? /^(true|yes|y|1)$/i.test(v.trim()) : Boolean(v));
const num = (v, limit) => { const n = typeof v === 'string' ? Number(v) : v; return Number.isFinite(n) && Math.abs(n) <= limit ? Math.round(n * 1e5) / 1e5 : null; };
const url = v => {
  const s = text(v, 300); if (!s) return null;
  try { const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`); return u.hostname.includes('.') ? u.href : null; } catch { return null; }
};

/**
 * Validates and fills in a festival. Returns { festival } or { error }.
 * `base` is an existing record whose id and bookkeeping (origin, status) survive an edit;
 * `origin`, `status` and `id` describe a new one. Callers set status themselves when it changes.
 */
export function normalizeFestival(input = {}, { base = null, origin = 'curated', status = 'published', id = null } = {}) {
  const f = { ...(base || {}), ...(input || {}) };
  const name = text(f.name), location = text(f.location);
  if (!name) return { error: 'name required' };
  if (!location) return { error: 'location required' };
  const latitude = num(f.latitude, 90), longitude = num(f.longitude, 180);
  if (latitude === null) return { error: 'latitude must be a number in range' };
  if (longitude === null) return { error: 'longitude must be a number in range' };
  if (!inNwsArea(latitude, longitude)) return { error: 'outside the National Weather Service area (the US and its territories), so no alerts are possible' };
  const startDate = BARE_DATE.test(f.startDate) ? dayStart(f.startDate) : validIso(f.startDate);
  const endDate = BARE_DATE.test(f.endDate) ? dayEnd(f.endDate) : validIso(f.endDate);
  if (!startDate) return { error: 'startDate must be ISO 8601' };
  if (!endDate) return { error: 'endDate must be ISO 8601' };
  if (Date.parse(endDate) < Date.parse(startDate)) return { error: 'endDate is before startDate' };
  const from = base?.origin || origin;
  const out = {
    id: base?.id || id || f.id || `${slug(name)}-${startDate.slice(0, 4)}`,
    name, location, latitude, longitude, startDate, endDate,
    county: text(f.county, 80) || '',
    isPartner: bool(f.isPartner), feeds: Array.isArray(f.feeds) ? f.feeds : [], site: Array.isArray(f.site) ? f.site : [],
    origin: from, status: base?.status || status,
    featured: f.featured === undefined || f.featured === '' ? from === 'curated' : bool(f.featured),
  };
  for (const k of ['source', 'website']) { const u = url(f[k]); if (u) out[k] = u; }
  // When the grounds open to early entry, vendors and build crews, if the festival says. Otherwise LEAD_DAYS before gates.
  const opens = BARE_DATE.test(f.groundsOpen) ? dayStart(f.groundsOpen) : validIso(f.groundsOpen);
  if (opens && Date.parse(opens) <= Date.parse(startDate)) out.groundsOpen = opens;
  if (f.verifiedOn) out.verifiedOn = String(f.verifiedOn).slice(0, 10);
  const note = text(f.note, 300); if (note) out.note = note;
  if (f.submittedAt) out.submittedAt = f.submittedAt;
  if (f.ground && typeof f.ground === 'object') out.ground = f.ground;   // what the lookups found and what staff set (ground.js)
  return { festival: out };
}

// A festival is shown, polled and watched only while it is on: from the grounds opening (a week out
// for early entry, vendors and build crews, unless it says otherwise) until the day after it ends.
// No sense in a platform for alerts about a place nobody is at yet.
export const LEAD_DAYS = Number(process.env.LEAD_DAYS || 7);
export const TAIL_DAYS = Number(process.env.TAIL_DAYS || 1);
export const opensAt = f => (f.groundsOpen && Date.parse(f.groundsOpen)) || Date.parse(f.startDate) - LEAD_DAYS * DAY;
export const closesAt = f => Date.parse(f.endDate) + TAIL_DAYS * DAY;
export const isLive = (f, now = Date.now()) => now >= opensAt(f) && now <= closesAt(f);

export function distanceKm(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLon = rad(b.longitude - a.longitude);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const overlap = (a, b) => Date.parse(a.startDate) <= Date.parse(b.endDate) + 24 * HOUR && Date.parse(b.startDate) <= Date.parse(a.endDate) + 24 * HOUR;
/** Same grounds on overlapping dates, or the same name: one festival listed twice. */
export const sameFestival = (a, b) => overlap(a, b) && (distanceKm(a, b) < 3 || slug(a.name) === slug(b.name) || sameNamedNearby(a, b));
/** Overlapping dates, the same name once day and pass words are gone, within the sprawl of one set of grounds. */
export const sameNamedNearby = (a, b) => overlap(a, b) && distanceKm(a, b) < 8 && sameCore(a.name, b.name);

// The National Weather Service covers the fifty states, DC and the territories; a festival elsewhere can get no alerts here.
const NWS_AREAS = [[24.3, 49.6, -125.1, -66.8], [51, 71.6, -180, -129], [51, 55, 170, 180], [18.8, 22.5, -160.5, -154.6], [17.5, 18.7, -68, -64.4], [13.1, 13.8, 144.5, 145.1], [14, 20.6, 144.8, 146.2], [-14.6, -13.9, -171.2, -168.1]];
export const inNwsArea = (lat, lon) => NWS_AREAS.some(([s, n, w, e]) => lat >= s && lat <= n && lon >= w && lon <= e);
