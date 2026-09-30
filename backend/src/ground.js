// The ground under a festival, as far as free data says: what the surface is (OpenStreetMap land use under the
// coordinate), how the soil drains (the USDA soil survey's hydrologic group), how much rain fell in the last two days
// (the Iowa Environmental Mesonet's daily point analysis, radar-derived, CONUS), and what staff say when they know
// better. The lookups are written onto the festival record once; the rain is read every three hours while it is on.
// The model in incoming.js turns it all into mud tiers and wind lines.
import { iso } from './util.js';
import { mudTier } from './incoming.js';

const HOUR = 3_600_000, DAY = 24 * HOUR, TTL = 3 * HOUR;
const UA = process.env.NWS_USER_AGENT || 'Fieldwatch/0.1 (you@example.com)';
const IEMRE = process.env.IEMRE_URL || 'https://mesonet.agron.iastate.edu/iemre';
const errorText = e => `${e?.message || e}${e?.cause?.code ? ` (${e.cause.code})` : ''}`;
const ymd = t => new Date(t).toISOString().slice(0, 10);

/** Rain at a point over the last two days, in inches: { in24, in48, days: [{ date, in }] } or null when the analysis is out of reach. */
export async function pastRain(lat, lon, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const url = `${IEMRE}/multiday/${ymd(now - 2 * DAY)}/${ymd(now)}/${Number(lat).toFixed(4)}/${Number(lon).toFixed(4)}/json`;
  const res = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`IEMRE ${res.status}`);
  const body = await res.json();
  const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
  const days = rows.map(r => ({ date: String(r.date || r.valid || '').slice(0, 10), in: Number(r.daily_precip_in ?? r.precip_in ?? r.precipitation_in ?? NaN) })).filter(d => d.date && Number.isFinite(d.in));
  if (!days.length) throw new Error('IEMRE answered with no days');
  const since = t => days.filter(d => Date.parse(`${d.date}T00:00:00Z`) >= t - DAY).reduce((s, d) => s + d.in, 0);
  const r = v => Math.round(v * 100) / 100;
  return { in24: r(since(now - DAY)), in48: r(since(now - 2 * DAY)), days, at: iso(now), source: 'IEM daily analysis' };
}

// ---- the surface: OpenStreetMap land use under the coordinate, a public Overpass instance, one query per festival ever ----
const OVERPASS = process.env.OVERPASS_URL || 'https://overpass-api.de/api/interpreter';
export const SURFACES = ['grass', 'dirt', 'sand', 'gravel', 'pavement', 'mixed'];
export const SOILS = ['A', 'B', 'C', 'D'];   // USDA hydrologic groups: A drains fast (sand), D barely drains (clay)
export const STRUCTURES = ['canopies', 'inflatables', 'stage'];
const SURFACE_TAG = { asphalt: 'pavement', concrete: 'pavement', paved: 'pavement', paving_stones: 'pavement', sett: 'pavement', gravel: 'gravel', fine_gravel: 'gravel', compacted: 'gravel', pebblestone: 'gravel',
  grass: 'grass', sand: 'sand', dirt: 'dirt', earth: 'dirt', ground: 'dirt', mud: 'dirt', unpaved: 'dirt', woodchips: 'dirt' };
/** One area's tags, read for what the ground is: [surface, low] or null when the tags say nothing about the ground. */
/** A campground under the point says people camp here. */
export const campingFromTags = (tags = {}) => tags.tourism === 'camp_site' || tags.tourism === 'caravan_site' || Boolean(tags.camp_site);
export function surfaceFromTags(tags = {}) {
  if (tags.surface && SURFACE_TAG[tags.surface]) return [SURFACE_TAG[tags.surface], false];
  if (tags.amenity === 'parking' || tags.aeroway || tags.highway || ['retail', 'commercial', 'industrial'].includes(tags.landuse)) return ['pavement', false];
  if (tags.natural === 'wetland') return ['grass', true];
  if (['sand', 'beach', 'dune'].includes(tags.natural)) return ['sand', false];
  if (['grassland', 'heath'].includes(tags.natural) || ['grass', 'meadow', 'recreation_ground', 'farmland', 'farmyard', 'orchard', 'village_green', 'cemetery', 'greenfield'].includes(tags.landuse)
    || ['pitch', 'park', 'golf_course', 'stadium', 'recreation_ground', 'garden', 'nature_reserve'].includes(tags.leisure)) return ['grass', false];
  if (['scrub', 'wood'].includes(tags.natural) || ['forest', 'quarry'].includes(tags.landuse)) return ['dirt', false];
  return null;
}
export async function surfaceFromOSM(lat, lon, { fetchImpl = globalThis.fetch } = {}) {
  const res = await fetchImpl(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(`[out:json][timeout:10];is_in(${Number(lat).toFixed(5)},${Number(lon).toFixed(5)});out tags;`)}` });
  if (!res.ok) throw new Error(`Overpass ${res.status}`);
  const body = await res.json();
  // The most telling area wins: a surface tag, then a use (parking, pitch), then land cover. Boundaries and places say nothing.
  const rank = t => (t.surface ? 0 : t.amenity || t.leisure || t.aeroway || t.highway ? 1 : 2);
  const elements = body?.elements || [], camping = elements.some(e => campingFromTags(e.tags || {}));
  const hits = elements.map(e => ({ tags: e.tags || {}, read: surfaceFromTags(e.tags || {}) })).filter(h => h.read).sort((a, b) => rank(a.tags) - rank(b.tags));
  if (!hits.length) return camping ? { surface: null, low: false, camping, source: 'OpenStreetMap', tag: 'tourism=camp_site' } : null;
  const [surface, low] = hits[0].read, t = hits[0].tags;
  return { surface, low, camping, source: 'OpenStreetMap', tag: ['surface', 'amenity', 'leisure', 'landuse', 'natural', 'aeroway', 'highway'].filter(k => t[k]).map(k => `${k}=${t[k]}`).join(', ') };
}

// ---- the soil: the USDA soil survey's map unit at the point, its hydrologic group and drainage class ----
const SDA = process.env.SDA_URL || 'https://sdmdataaccess.sc.egov.usda.gov/Tabular/post.rest';
export async function soilFromUSDA(lat, lon, { fetchImpl = globalThis.fetch } = {}) {
  const query = `SELECT TOP 1 mu.mukey, mu.muname, c.compname, c.hydgrp, c.drainagecl, c.comppct_r FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${Number(lon).toFixed(5)} ${Number(lat).toFixed(5)})') AS i INNER JOIN mapunit mu ON mu.mukey = i.mukey INNER JOIN component c ON c.mukey = mu.mukey ORDER BY c.comppct_r DESC`;
  const res = await fetchImpl(SDA, { method: 'POST', headers: { 'User-Agent': UA, 'content-type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ format: 'JSON+COLUMNNAME', query }) });
  if (!res.ok) throw new Error(`Soil survey ${res.status}`);
  const rows = (await res.json())?.Table || [];
  const cols = ['mukey', 'muname', 'compname', 'hydgrp', 'drainagecl', 'comppct_r'];
  const data = rows.filter(r => Array.isArray(r) && !(String(r[0]).toLowerCase() === 'mukey'));
  if (!data.length) return null;
  const r = Object.fromEntries(cols.map((c, i) => [c, data[0][i]]));
  // A dual group (A/D) is the wetter letter unless someone drained the field, which a festival field rarely is.
  const grp = String(r.hydgrp || '').trim().toUpperCase(), soil = SOILS.find(l => l === grp.slice(-1)) || null;
  const drainage = String(r.drainagecl || '').trim() || null;
  return { soil, drainage, low: /poorly/i.test(drainage || ''), soilName: String(r.muname || r.compname || '').trim() || null, source: 'USDA soil survey' };
}

/** Both lookups, written onto the festival record (the staff override, if any, is kept beside them). */
export async function lookupGround(f, { now = Date.now(), fetchImpl = globalThis.fetch, save = null } = {}) {
  const found = { lookedUpAt: iso(now) }, errors = [];
  try { const s = await surfaceFromOSM(f.latitude, f.longitude, { fetchImpl }); if (s) Object.assign(found, ...(s.surface ? [{ surface: s.surface, surfaceSource: `${s.source}: ${s.tag}` }] : []), ...(s.low ? [{ low: true }] : []), ...(s.camping ? [{ camping: true, campingSource: 'OpenStreetMap: a campground under the grounds' }] : [])); }
  catch (e) { errors.push(`surface: ${errorText(e)}`); }
  try { const s = await soilFromUSDA(f.latitude, f.longitude, { fetchImpl }); if (s) Object.assign(found, { soil: s.soil, soilName: s.soilName, drainage: s.drainage, soilSource: s.source, ...(s.low ? { low: true } : {}) }); }
  catch (e) { errors.push(`soil: ${errorText(e)}`); }
  if (errors.length) found.lookupError = errors.join('; ');
  const ground = { ...(f.ground || {}), ...found };
  if (save) save({ ...f, ground });
  return ground;
}
/** A record's ground as the model uses it: the staff override over the lookups over the defaults. */
export function effectiveGround(f) {
  const g = f?.ground || {}, o = g.override || {};
  const camping = o.camping ?? g.camping ?? (f?.camping === true || f?.camping === false ? f.camping : null);
  return { surface: o.surface || g.surface || 'grass', soil: o.soil || g.soil || 'B', low: o.low ?? g.low ?? false, structures: Array.isArray(o.structures) ? o.structures : ['canopies'],
    camping, campingSource: o.camping != null ? 'staff' : g.camping != null ? g.campingSource || 'lookup' : f?.camping === true || f?.camping === false ? 'the listing' : 'unknown',
    surfaceSource: o.surface ? 'staff' : g.surface ? g.surfaceSource || 'lookup' : 'assumed', soilSource: o.soil ? 'staff' : g.soil ? g.soilSource || 'lookup' : 'assumed',
    soilName: g.soilName || null, drainage: g.drainage || null, lookedUpAt: g.lookedUpAt || null, lookupError: g.lookupError || null, override: g.override || null, learned: g.learned || null };
}
/** A staff override, checked: only the fields and values the model knows. */
export function validOverride(body = {}) {
  const o = {};
  if (body.surface != null && body.surface !== '') { if (!SURFACES.includes(body.surface)) return { error: `surface must be one of ${SURFACES.join(', ')}` }; o.surface = body.surface; }
  if (body.soil != null && body.soil !== '') { if (!SOILS.includes(body.soil)) return { error: `soil must be one of ${SOILS.join(', ')}` }; o.soil = body.soil; }
  if (body.low != null) o.low = Boolean(body.low);
  if (body.camping != null) o.camping = body.camping === true || body.camping === 'true';
  if (body.structures != null) { if (!Array.isArray(body.structures) || body.structures.some(s => !STRUCTURES.includes(s))) return { error: `structures must be some of ${STRUCTURES.join(', ')}` }; o.structures = body.structures; }
  if (body.note != null) o.note = String(body.note).slice(0, 200);
  return { override: { ...o, at: iso() } };
}

// ---- reports from the field: one tap says what the ground is doing, and the venue learns how much rain it takes ----
export const GROUND_STATES = ['fine', 'soft', 'mud', 'water'];
const WET_STATES = ['soft', 'mud', 'water'];
/**
 * The rain this ground takes before it goes soft, from what people reported: the least effective rain at which anyone
 * reported soft, mud or water, nudged up past any report of fine ground at more. Null until a wet report with rain behind it.
 */
export function learnedThreshold(reports, now = Date.now()) {
  const rows = reports.filter(r => r && r.effective > 0.05 && GROUND_STATES.includes(r.state));
  const wet = rows.filter(r => WET_STATES.includes(r.state)).map(r => r.effective).sort((a, b) => a - b);
  if (!wet.length) return null;
  const fineMax = Math.max(0, ...rows.filter(r => r.state === 'fine').map(r => r.effective));
  let threshold = wet[0];
  if (fineMax >= threshold) { const above = wet.find(e => e > fineMax); threshold = above != null ? (fineMax + above) / 2 : fineMax + 0.1; }
  return { threshold: Math.round(threshold * 100) / 100, samples: rows.length, at: iso(now) };
}
/** Stores a report with the rain the model counts right now, and refreshes the venue's learned threshold on the record. */
export async function reportGround(f, state, { now = Date.now(), fetchImpl = globalThis.fetch, q, save } = {}) {
  if (!GROUND_STATES.includes(state)) return { error: `state must be one of ${GROUND_STATES.join(', ')}` };
  const g = await groundFor(f, { now, fetchImpl });
  const m = mudTier(g, 0, 0);
  q.insertGroundReport(f.id, state, m.effective, m.tier);
  const learned = learnedThreshold(q.groundReports(f.id, now - 60 * DAY), now);
  const ground = { ...(f.ground || {}), ...(learned ? { learned } : {}) };
  if (learned && save) save({ ...f, ground });
  return { ok: true, state, effective: m.effective, learned };
}
/** The last report and how many came in the last six hours, for the card. */
export function reportSummary(q, festivalId, now = Date.now()) {
  const rows = q.groundReports(festivalId, now - 6 * HOUR);
  return rows.length ? { last: { state: rows[0].state, at: rows[0].at }, recent: rows.length } : null;
}

const attempted = new Map();
/** A live festival without a lookup gets one, at most one festival per call and one try per festival per six hours (public services, fair use). */
export async function ensureGround(festivals, { now = Date.now(), fetchImpl = globalThis.fetch, save } = {}) {
  const f = festivals.find(x => !x.ground?.lookedUpAt && (attempted.get(x.id) || 0) < now - 6 * HOUR);
  if (!f) return null;
  attempted.set(f.id, now);
  const g = await lookupGround(f, { now, fetchImpl, save });
  console.log(`[${f.id}] ground: ${g.surface || 'surface unknown'}${g.soil ? `, soil ${g.soil} (${g.soilName})` : ''}${g.lookupError ? ` (${g.lookupError})` : ''}`);
  return g;
}

const cache = new Map();
/**
 * What the model knows about this festival's ground: the record's own surface fields, and the recent rain, fetched at most
 * every three hours and kept when a fetch fails so a hiccup never blanks it.
 */
export async function groundFor(f, { now = Date.now(), fetchImpl = globalThis.fetch } = {}) {
  const hit = cache.get(f.id);
  let past = hit?.past ?? null, pastError = hit?.pastError ?? null;
  if (!hit || now - hit.at > TTL) {
    try { past = await pastRain(f.latitude, f.longitude, { now, fetchImpl }); pastError = null; }
    catch (e) { pastError = errorText(e); if (!hit) console.error(`[${f.id}] past rain unavailable: ${pastError}`); }
    cache.set(f.id, { at: now, past, pastError });
  }
  return { ...effectiveGround(f), past, ...(pastError && !past ? { pastError } : {}), at: iso(now) };
}
export const groundStatus = () => ({ cached: cache.size, errors: [...cache.values()].filter(c => c.pastError).length });
