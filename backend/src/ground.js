// The ground under a festival, as far as free data says: what the surface is (OpenStreetMap land use under the
// coordinate or within 250 m of it, else the National Land Cover Database's 30 m cell), how the soil drains (the USDA soil survey's hydrologic group), how much rain fell in the last two days
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
// ---- indoors or out: a club, a hall or an arena is its own shelter, so the lightning protocol and the field advice stand down there ----
const INDOOR_AMENITY = ['nightclub', 'bar', 'pub', 'theatre', 'cinema', 'arena', 'community_centre', 'conference_centre', 'exhibition_centre', 'casino', 'concert_hall', 'music_venue'];
const INDOOR_LEISURE = ['sports_centre', 'ice_rink', 'bowling_alley', 'dance'];
// A building tag with no walls to speak of: a stadium or a grandstand is open to the sky, a pavilion or a bandstand is a roof on posts.
const OPEN_AIR = ['no', 'roof', 'shed', 'grandstand', 'stadium', 'pavilion', 'bandstand', 'carport', 'tent'];
const INDOOR_WORDS = /\b(night ?club|club|arena|theat(?:re|er)|hall|ballroom|auditorium|convention cent(?:er|re)|coliseum|dome|casino|lounge|bar|warehouse|tavern|saloon|brewery|cinema|church|indoors?)\b/i;
const OUTDOOR_WORDS = /\b(park|fairgrounds?|ranch|farm|fields?|speedway|campground|grounds|beach|lake|forest|meadow|amphitheat(?:re|er)|raceway|downtown|streets?|plaza|lawn|island|mountain|resort|woods|valley|river|bay|shore|airfield|airport|orchard|vineyard|winery|estate|outdoors?)\b/i;
/**
 * One feature's tags, read for a roof: a building, a club, a hall, an arena says indoors; an amphitheater, or an events
 * venue with no building (as often a field as a hall), does not; null when the tags say nothing.
 */
export function indoorFromTags(tags = {}) {
  if (tags.indoor === 'no' || /amphi|open_air/.test(tags['theatre:type'] || '')) return null;
  return (tags.building && !OPEN_AIR.includes(tags.building)) || INDOOR_AMENITY.includes(tags.amenity) || INDOOR_LEISURE.includes(tags.leisure) || tags.indoor === 'yes' ? true : null;
}
/** What a venue's name says: a nightclub or a hall is indoors, a park or fairgrounds is not; the building's word wins when both appear. */
export const indoorFromWords = text => (INDOOR_WORDS.test(text || '') ? true : OUTDOOR_WORDS.test(text || '') ? false : null);
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
const AROUND_M = 250;
export async function surfaceFromOSM(lat, lon, { fetchImpl = globalThis.fetch } = {}) {
  const la = Number(lat).toFixed(5), lo = Number(lon).toFixed(5);
  const ask = async ql => {
    const res = await fetchImpl(OVERPASS, { method: 'POST', headers: { 'User-Agent': UA, 'content-type': 'application/x-www-form-urlencoded' }, body: `data=${encodeURIComponent(ql)}` });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    return (await res.json())?.elements || [];
  };
  // The most telling feature wins: a surface tag, then a use (parking, pitch), then land cover. Boundaries and places say nothing.
  const rank = t => (t.surface ? 0 : t.amenity || t.leisure || t.aeroway || t.highway ? 1 : 2);
  const tagText = t => ['surface', 'amenity', 'leisure', 'landuse', 'natural', 'aeroway', 'highway'].filter(k => t[k]).map(k => `${k}=${t[k]}`).join(', ');
  const roofText = t => ['building', 'amenity', 'leisure', 'indoor'].filter(k => t[k]).map(k => `${k}=${t[k]}`).join(', ');
  // Under the point first: every area that contains it.
  const under = await ask(`[out:json][timeout:10];is_in(${la},${lo});out tags;`);
  let camping = under.some(e => campingFromTags(e.tags || {}));
  // Indoors when a building, a club or a hall sits under the point and no campground does (the lodge or the showers on a
  // campground are buildings on the grounds, not the venue); outdoors when the ground under it is mapped as land; else unknown.
  const roof = camping ? null : under.find(e => indoorFromTags(e.tags || {}) === true);
  const indoor = roof ? true : camping || under.some(e => surfaceFromTags(e.tags || {})) ? false : null, indoorTag = roof ? roofText(roof.tags) : null;
  const hits = under.map(e => ({ tags: e.tags || {}, read: surfaceFromTags(e.tags || {}) })).filter(h => h.read).sort((a, b) => rank(a.tags) - rank(b.tags));
  if (hits.length) { const [surface, low] = hits[0].read; return { surface, low, camping, indoor, indoorTag, source: 'OpenStreetMap', tag: tagText(hits[0].tags) }; }
  // Nothing under it says: the nearest mapped ground within 250 m (a field whose outline stops short of the pin, the lot beside it).
  const near = await ask(`[out:json][timeout:10];nwr(around:${AROUND_M},${la},${lo})[~"^(surface|landuse|leisure|natural|amenity|aeroway|tourism)$"~"."];out tags center;`);
  const at = e => e.center || (e.lat != null ? { lat: e.lat, lon: e.lon } : null);
  const meters = e => { const c = at(e); if (!c) return AROUND_M; const dy = (c.lat - lat) * 111195, dx = (c.lon - lon) * 111195 * Math.cos(lat * Math.PI / 180); return Math.hypot(dx, dy); };
  camping = camping || near.some(e => campingFromTags(e.tags || {}));
  const close = near.map(e => ({ tags: e.tags || {}, read: surfaceFromTags(e.tags || {}), m: meters(e) })).filter(h => h.read).sort((a, b) => a.m - b.m || rank(a.tags) - rank(b.tags));
  if (close.length) { const [surface, low] = close[0].read; return { surface, low, camping, indoor, indoorTag, source: 'OpenStreetMap', tag: `${tagText(close[0].tags)}, ${Math.round(close[0].m)} m away` }; }
  return camping || indoor != null ? { surface: null, low: false, camping, indoor, indoorTag, source: 'OpenStreetMap', tag: indoorTag || 'tourism=camp_site' } : null;
}

// ---- the land cover: the National Land Cover Database at the point (MRLC's map service, 30 m cells), when OpenStreetMap has nothing ----
const NLCD = process.env.NLCD_URL || 'https://www.mrlc.gov/geoserver/mrlc_display/NLCD_2021_Land_Cover_L48/wms';
const NLCD_LAYER = process.env.NLCD_LAYER || 'NLCD_2021_Land_Cover_L48';
/** NLCD classes as ground: [surface, low, name]. Water and ice (11, 12) say nothing about a field. */
export const NLCD_CLASS = {
  21: ['grass', false, 'Developed, open space'], 22: ['mixed', false, 'Developed, low intensity'], 23: ['pavement', false, 'Developed, medium intensity'], 24: ['pavement', false, 'Developed, high intensity'],
  31: ['dirt', false, 'Barren land'], 41: ['dirt', false, 'Deciduous forest'], 42: ['dirt', false, 'Evergreen forest'], 43: ['dirt', false, 'Mixed forest'], 51: ['dirt', false, 'Dwarf scrub'], 52: ['dirt', false, 'Shrub/scrub'],
  71: ['grass', false, 'Grassland/herbaceous'], 72: ['grass', false, 'Sedge/herbaceous'], 73: ['grass', false, 'Lichens'], 74: ['grass', false, 'Moss'], 81: ['grass', false, 'Pasture/hay'], 82: ['dirt', false, 'Cultivated crops'],
  90: ['dirt', true, 'Woody wetlands'], 95: ['grass', true, 'Emergent herbaceous wetlands'],
};
/** One WMS GetFeatureInfo at the point: the class of the 30 m cell under it, read as ground; null for water or ice. */
export async function coverFromNLCD(lat, lon, { fetchImpl = globalThis.fetch } = {}) {
  const d = 0.0005, la = Number(lat), lo = Number(lon);   // a 3 by 3 pixel window about 110 m across, the point in its middle pixel
  const p = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetFeatureInfo', LAYERS: NLCD_LAYER, QUERY_LAYERS: NLCD_LAYER, SRS: 'EPSG:4326',
    BBOX: `${(lo - d).toFixed(5)},${(la - d).toFixed(5)},${(lo + d).toFixed(5)},${(la + d).toFixed(5)}`, WIDTH: '3', HEIGHT: '3', X: '1', Y: '1', INFO_FORMAT: 'application/json', FEATURE_COUNT: '1' });
  const res = await fetchImpl(`${NLCD}?${p}`, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Land cover ${res.status}`);
  const props = (await res.json())?.features?.[0]?.properties || {};
  const raw = props.GRAY_INDEX ?? props.PALETTE_INDEX ?? Object.values(props).find(v => v !== '' && Number.isFinite(Number(v)));
  const code = Number(raw);
  if (raw == null || !Number.isFinite(code)) throw new Error('Land cover answered with no class');
  const c = NLCD_CLASS[code];
  return c ? { surface: c[0], low: c[1], source: `NLCD land cover: ${c[2]}`, code } : null;
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
  try { const s = await surfaceFromOSM(f.latitude, f.longitude, { fetchImpl }); if (s) Object.assign(found, ...(s.indoor != null ? [{ indoor: s.indoor, indoorSource: s.indoor ? `${s.source}: ${s.indoorTag}` : `${s.source}: ${s.tag}` }] : []), ...(s.surface ? [{ surface: s.surface, surfaceSource: `${s.source}: ${s.tag}` }] : []), ...(s.low ? [{ low: true }] : []), ...(s.camping ? [{ camping: true, campingSource: 'OpenStreetMap: a campground under the grounds' }] : [])); }
  catch (e) { errors.push(`surface: ${errorText(e)}`); }
  if (!found.surface) { try { const c = await coverFromNLCD(f.latitude, f.longitude, { fetchImpl }); if (c) Object.assign(found, { surface: c.surface, surfaceSource: c.source }, ...(c.low ? [{ low: true }] : [])); }
    catch (e) { errors.push(`cover: ${errorText(e)}`); } }
  try { const s = await soilFromUSDA(f.latitude, f.longitude, { fetchImpl }); if (s) Object.assign(found, { soil: s.soil, soilName: s.soilName, drainage: s.drainage, soilSource: s.source, ...(s.low ? { low: true } : {}) }); }
  catch (e) { errors.push(`soil: ${errorText(e)}`); }
  found.lookupError = errors.length ? errors.join('; ') : null;   // null, not missing, so a clean run clears an old error on the record
  const ground = { ...(f.ground || {}), ...found };
  if (save) save({ ...f, ground });
  return ground;
}
/** A record's ground as the model uses it: the staff override over the lookups over the defaults. */
export function effectiveGround(f) {
  const g = f?.ground || {}, o = g.override || {};
  const camping = o.camping ?? g.camping ?? (f?.camping === true || f?.camping === false ? f.camping : null);
  const said = f?.indoor === true || f?.indoor === false ? f.indoor : indoorFromWords(`${f?.name || ''} ${f?.location || ''}`);
  // Indoors only when nothing says otherwise. Mapped open ground under the pin, a park, a farm or a mountain in the listing, or
  // people camping here each say outdoors, and each beats a building under the pin: an imported pin often sits on the lodge or
  // the box office of grounds open to the sky, and out is the safe side, where the lightning codes run. Staff keep the last word.
  const open = g.indoor === false ? g.indoorSource || 'lookup' : said === false ? 'the listing' : camping === true ? 'people camp here' : null;
  const indoor = o.indoor ?? (open ? false : g.indoor ?? said);
  const indoorSource = o.indoor != null ? 'staff' : open ? open : g.indoor != null ? g.indoorSource || 'lookup' : said != null ? 'the listing' : 'unknown';
  return { surface: o.surface || g.surface || 'grass', soil: o.soil || g.soil || 'B', low: o.low ?? g.low ?? false, structures: Array.isArray(o.structures) ? o.structures : ['canopies'],
    camping, campingSource: o.camping != null ? 'staff' : g.camping != null ? g.campingSource || 'lookup' : f?.camping === true || f?.camping === false ? 'the listing' : 'unknown',
    indoor, indoorSource,
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
  if (body.indoor != null) o.indoor = body.indoor === true || body.indoor === 'true';
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
  const stale = g => Boolean(g?.lookedUpAt) && (!g.surface || !g.soil || g.lookupError) && Date.parse(g.lookedUpAt) < now - DAY;   // found nothing, or hit an error: try again after a day
  const f = festivals.find(x => (!x.ground?.lookedUpAt || stale(x.ground)) && (attempted.get(x.id) || 0) < now - 6 * HOUR);
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
