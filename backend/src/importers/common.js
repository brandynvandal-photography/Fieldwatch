// What every ticket-site importer shares: turning a pile of listings ("Aftershock - Friday",
// "Aftershock 3 Day Pass", "Aftershock Parking") into festivals, and writing them into the table
// without stepping on another source's record.
import { q } from '../db.js';
import { normalizeFestival, sameFestival, slug } from '../festivals.js';
import { iso } from '../util.js';

const DAY = 86_400_000;
export const ADD_ON = /\b(parking|shuttle|camping|campsite|campground|locker|merch|payment plan|layaway|upgrade|add[- ]?on|glamping|rv pass|car pass|bus pass)\b/i;
export const VENUE_NAMED_FESTIVAL = /\bfestival (pier|hall|park|theat\w*|grounds|stage|field|plaza|centre|center)\b/i;
export const FESTY = /\bfest(ival)?s?\b|fest$/i;
const NOISE = /\b(20\d\d|(mon|tues|wednes|thurs|fri|satur|sun)day|weekend \d|day \d|\d[- ]?day|(one|two|three|four|single|multi)[- ]day|pass(es)?|vip|ga|general admission|admission|ticket(s)?|presale|early bird|tier \d|late night|after ?party|official|only)\b/gi;
const SUFFIX = /\s*[-:|–—(]\s*(?:(?:mon|tues|wednes|thurs|fri|satur|sun)day|weekend \d|day \d|\d[- ]?day|(?:one|two|three|four|single|multi)[- ]day|vip|ga\b|general admission|pass(?:es)?|presale|early bird|tier \d|late night|after ?party)[^-:|–—(]*\)?\s*$/i;

/** What two listings of the same festival share once the day and ticket words are gone. */
export const normalizeName = n => String(n).replace(/[-:|–—(),.!&+/'"]+/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
export const displayName = n => { let s = String(n).trim(); for (let i = 0; i < 3; i++) s = s.replace(SUFFIX, '').trim(); return s.replace(/\s+20\d\d$/, '').replace(/[-:|–—,]+$/, '').trim(); };
/** A listing with only a date starts mid-afternoon UTC and runs into the small hours after that day. */
export const dayStart = d => `${String(d).slice(0, 10)}T16:00:00Z`;
export const dayEnd = d => iso(new Date(Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`) + 32 * 3_600_000));
export const listingKey = (name, venueId, lat, lon) => `${normalizeName(name)}|${venueId || `${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}`}`;

const STATES = new Set(('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY').split(' '));
const STATE_NAMES = new Set(['alabama', 'alaska', 'arizona', 'arkansas', 'california', 'colorado', 'connecticut', 'delaware', 'district of columbia', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'kansas', 'kentucky', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'new hampshire', 'new jersey', 'new mexico', 'new york', 'north carolina', 'north dakota', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhode island', 'south carolina', 'south dakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'washington', 'west virginia', 'wisconsin', 'wyoming']);
/** The weather service only covers the US, so a listing elsewhere is no use here. */
export const usState = s => { const t = String(s || '').trim(); return STATES.has(t.toUpperCase()) || STATE_NAMES.has(t.toLowerCase()); };

/**
 * Listings ({ key, name, place, lat, lon, start, end, url }) grouped into festivals:
 * earliest start, latest end, the shortest name in the group, one record per group.
 */
export function groupListings(listings, { origin, prefix, today = iso().slice(0, 10) }) {
  const groups = new Map();
  for (const c of listings) { if (!c) continue; (groups.get(c.key) || groups.set(c.key, []).get(c.key)).push(c); }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const first = g[0];
    const name = g.map(x => x.name).filter(Boolean).sort((a, b) => a.length - b.length)[0];
    if (!name) continue;
    const endDate = iso(new Date(Math.max(...g.map(x => Date.parse(x.end || dayEnd(x.start))))));
    const { festival } = normalizeFestival(
      { name, location: first.place, latitude: first.lat, longitude: first.lon, startDate: first.start, endDate, source: first.url, website: first.url, verifiedOn: today },
      { origin, status: 'published', id: `${prefix}-${slug(name)}-${first.start.slice(0, 4)}` });
    if (festival) out.push(festival);
  }
  return out;
}

/**
 * Writes one source's festivals: skips any that another source already lists (same grounds on
 * overlapping dates, or the same name), keeps what an admin set by hand on an existing import,
 * and prunes this source's own records that vanished before they started (cancelled) or ended
 * a month ago. A run with fetch errors never prunes on absence; it only knows what it fetched.
 */
export function applyImport({ origin, found, now = Date.now(), errors = 0 }) {
  const existing = q.allFestivals();
  const others = existing.filter(f => f.origin !== origin);
  const before = new Map(existing.filter(f => f.origin === origin).map(f => [f.id, f]));
  let added = 0, updated = 0, duplicates = 0, pruned = 0;
  const seen = new Set();
  for (const f of found) {
    if (others.some(o => sameFestival(o, f))) { duplicates++; continue; }
    seen.add(f.id);
    const old = before.get(f.id);
    if (old) { q.upsertFestival({ ...f, featured: old.featured, county: old.county || f.county, feeds: old.feeds, site: old.site, isPartner: old.isPartner, status: old.status }); updated++; }
    else { q.upsertFestival(f); added++; }
  }
  for (const [id, f] of before) {
    const gone = !seen.has(id), unstarted = Date.parse(f.startDate) > now, longOver = Date.parse(f.endDate) < now - 30 * DAY;
    if ((gone && unstarted && errors === 0) || longOver) { q.deleteFestival(id); pruned++; }
  }
  return { festivals: found.length, added, updated, duplicates, pruned };
}
