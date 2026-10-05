// National Weather Service API. Free, no key, but it wants a User-Agent with a contact (site.js: the app's page unless NWS_USER_AGENT says otherwise).
import { USER_AGENT as UA } from './site.js';

// The service drops to 503 or hangs for seconds at a time: every call has a timeout and one retry on a network error
// or a 5xx, so a hiccup never stalls the poll loop or reads as a change in the weather.
const TIMEOUT_MS = Number(process.env.NWS_TIMEOUT_MS || 10_000), RETRY_MS = Number(process.env.NWS_RETRY_MS ?? 1000);
export const nwsStats = { calls: 0, retries: 0 };
import { condense, reaches, zonesOf, keepGeometry } from './incoming.js';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function nws(url, attempt = 0) {
  nwsStats.calls++;
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) { const e = new Error(`NWS ${res.status} for ${url}`); e.transient = res.status >= 500; throw e; }
    return res.json();
  } catch (e) {
    const transient = e.transient || e.name === 'TimeoutError' || e.name === 'AbortError' || Boolean(e.cause);
    if (attempt === 0 && transient) { nwsStats.retries++; await sleep(RETRY_MS); return nws(url, 1); }
    throw e;
  }
}

const fmt = n => Number(n).toFixed(4);

export function normalizeAlert(feature) {
  const p = feature.properties;
  return {
    id: p.id,
    event: p.event,
    headline: p.headline ?? null,
    body: p.description ?? '',
    instruction: p.instruction ?? null,
    severity: String(p.severity || 'Unknown').toLowerCase(),
    area: p.areaDesc ?? '',
    source: p.senderName ?? 'National Weather Service',
    issuedAt: p.effective,
    onset: p.onset ?? null,
    expiresAt: p.ends ?? p.expires ?? null,
    channel: 'weather',
    relayCount: 0,
    replaces: (p.references || []).map(r => r.identifier || '').filter(Boolean),   // the messages this one updates: the same warning, worded again
    geometry: keepGeometry(feature.geometry),   // the polygon, when there is one small enough, for the radar square
  };
}

export async function activeAlerts(lat, lon) {
  const fc = await nws(`https://api.weather.gov/alerts/active?point=${fmt(lat)},${fmt(lon)}`);
  return condense(fc.features || []).map(normalizeAlert);
}

export { condense, reaches };

/**
 * The alerts that apply to a festival's grounds, not just one point on them: everything active for the point's county and
 * forecast zones, then a polygon warning only where its polygon reaches the grounds, a zone-wide alert as it is. A storm
 * warning whose edge crosses the grounds is caught; one across the county that misses them is not. The point query stands in
 * when the zones are unknown.
 */
export async function alertsFor(lat, lon) {
  let zones = [];
  try { zones = zonesOf(await point(lat, lon)); } catch {}
  if (!zones.length) return activeAlerts(lat, lon);
  const fc = await nws(`https://api.weather.gov/alerts/active?zone=${zones.join(',')}`);
  return condense((fc.features || []).filter(ft => reaches(ft.geometry, lat, lon)), zones).map(normalizeAlert);
}
/**
 * The same for every festival that is on, in as few calls as there are chunks of forty zones: one answer from the service,
 * handed to each festival by the zones its messages name and, for a polygon, whether it reaches the grounds. A festival
 * whose zones are not known gets null, and the caller asks for it by point.
 */
export async function alertsForAll(festivals) {
  const zonesBy = new Map(), all = new Set();
  for (const f of festivals) { try { const z = zonesOf(await point(f.latitude, f.longitude)); if (z.length) { zonesBy.set(f.id, z); z.forEach(x => all.add(x)); } } catch {} }
  const list = [...all], features = [], seen = new Set();
  for (let i = 0; i < list.length; i += 40) {
    const fc = await nws(`https://api.weather.gov/alerts/active?zone=${list.slice(i, i + 40).join(',')}`);
    for (const ft of fc.features || []) { const id = ft.properties && ft.properties.id; if (id && !seen.has(id)) { seen.add(id); features.push(ft); } }
  }
  const byFestival = new Map();
  for (const f of festivals) {
    const zones = zonesBy.get(f.id);
    if (!zones) { byFestival.set(f.id, null); continue; }
    const mine = features.filter(ft => { const ugc = (ft.properties.geocode && ft.properties.geocode.UGC) || []; return (!ugc.length || ugc.some(z => zones.includes(z))) && reaches(ft.geometry, f.latitude, f.longitude); });
    byFestival.set(f.id, condense(mine, zones).map(normalizeAlert));
  }
  return { byFestival, calls: Math.ceil(list.length / 40), zones: list.length };
}

// /points rarely changes, so cache it for the life of the process.
const points = new Map();
export async function point(lat, lon) {
  const key = `${fmt(lat)},${fmt(lon)}`;
  if (!points.has(key)) points.set(key, (await nws(`https://api.weather.gov/points/${key}`)).properties);
  return points.get(key);
}

/** The grid behind the forecast: heat index, gusts and the chance of thunder, as NWS serves them (intervals, metric). */
export async function gridpoint(lat, lon) {
  const p = await point(lat, lon);
  const g = (await nws(p.forecastGridData)).properties;
  return { heatIndex: g.heatIndex, windGust: g.windGust, probabilityOfThunder: g.probabilityOfThunder, quantitativePrecipitation: g.quantitativePrecipitation,
    temperature: g.temperature, relativeHumidity: g.relativeHumidity, windSpeed: g.windSpeed, skyCover: g.skyCover, windDirection: g.windDirection, apparentTemperature: g.apparentTemperature, snowfallAmount: g.snowfallAmount };
}

export async function hourly(lat, lon) {
  const p = await point(lat, lon);
  const f = await nws(p.forecastHourly);
  return f.properties.periods.slice(0, 36).map(x => ({
    startTime: x.startTime,
    temperature: x.temperature,
    shortForecast: x.shortForecast,
    windSpeed: x.windSpeed,
    precipChance: x.probabilityOfPrecipitation?.value ?? null,
  }));
}
