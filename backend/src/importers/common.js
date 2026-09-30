// What every ticket-site importer shares: turning a pile of listings ("Aftershock - Friday",
// "Aftershock 3 Day Pass", "Aftershock Parking") into festivals, and writing them into the table
// without stepping on another source's record.
import { db, q } from '../db.js';
import { normalizeFestival, sameFestival, sameNamedNearby, slug } from '../festivals.js';
import { ADD_ON, CANCELLED, FESTIVAL_WORD, NOT_A_FESTIVAL, cleanName, looksLikeFestival, normalizeName } from '../names.js';
import { iso } from '../util.js';
export { ADD_ON, CANCELLED, FESTIVAL_WORD, NOT_A_FESTIVAL, cleanName, looksLikeFestival, normalizeName };

/** What went wrong, with the cause Node's fetch hides behind "fetch failed" (ENOTFOUND, ECONNREFUSED, a TLS error). */
export const errorText = e => { const c = e?.cause; return `${e?.message || e}${c ? ` (${c.code || c.message || c})` : ''}`; };

const DAY = 86_400_000, HOUR = 3_600_000;
export const VENUE_NAMED_FESTIVAL = /\bfestival (pier|hall|park|theat\w*|grounds|stage|field|plaza|centre|center)\b/i;
export const FESTY = /\bfest(ival)?s?\b|fest$/i;
/** The festival's own name, as the app shows it: no day, pass, lineup or year. */
export const displayName = n => cleanName(n);
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
    // A listing that ends within two hours of starting was given a placeholder end; the day is the festival's.
    const endDate = iso(new Date(Math.max(...g.map(x => Date.parse(x.end && Date.parse(x.end) - Date.parse(x.start) > 2 * HOUR ? x.end : dayEnd(x.start))))));
    const { festival } = normalizeFestival(
      { name, location: first.place, latitude: first.lat, longitude: first.lon, startDate: first.start, endDate, source: first.url, website: first.url, verifiedOn: today },
      { origin, status: 'published', id: `${prefix}-${slug(name)}-${first.start.slice(0, 4)}` });
    if (!festival) continue;
    // "Country In The Park" and "Country In The Park 2", same weekend, same grounds: one festival, the longer stay.
    const twin = out.find(f => sameNamedNearby(f, festival));
    if (twin) { twin.startDate = Date.parse(festival.startDate) < Date.parse(twin.startDate) ? festival.startDate : twin.startDate; twin.endDate = Date.parse(festival.endDate) > Date.parse(twin.endDate) ? festival.endDate : twin.endDate; }
    else out.push(festival);
  }
  return out;
}

/**
 * Writes one source's festivals: skips any that another source already lists (same grounds on
 * overlapping dates, or the same name), keeps what an admin set by hand on an existing import,
 * and prunes this source's own records that vanished before they started (cancelled) or ended
 * a month ago. A run with fetch errors never prunes on absence; it only knows what it fetched.
 */
export const applyImport = db.transaction(({ origin, found, now = Date.now(), errors = 0 }) => {
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
});
