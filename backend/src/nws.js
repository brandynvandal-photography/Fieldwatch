// National Weather Service API. Free, no key, but it wants a User-Agent with a contact (site.js: the app's page unless NWS_USER_AGENT says otherwise).
import { USER_AGENT as UA } from './site.js';

async function nws(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/geo+json' } });
  if (!res.ok) throw new Error(`NWS ${res.status} for ${url}`);
  return res.json();
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
  };
}

export async function activeAlerts(lat, lon) {
  const fc = await nws(`https://api.weather.gov/alerts/active?point=${fmt(lat)},${fmt(lon)}`);
  return condense(fc.features || []).map(normalizeAlert);
}

/**
 * One message per warning. The weather service lists a warning once per update it has sent and once per zone segment it
 * covers, and a county query brings in every segment in the county. An update replaces what it references; a zone-wide
 * segment counts only where it names the grounds' own zone or county; and what still says the same thing twice (one event,
 * one end) is one message, the newest. A phone reading three Extreme Heat Warnings learns nothing from the second.
 */
export function condense(features, zones = []) {
  const ids = new Set(features.map(ft => ft.properties.id));
  const superseded = new Set(features.flatMap(ft => (ft.properties.references || []).map(r => r.identifier)).filter(id => ids.has(id)));
  const sentAt = ft => Date.parse(ft.properties.sent || ft.properties.effective || '') || 0;
  const out = [], seen = new Set();
  for (const ft of features.slice().sort((a, b) => sentAt(b) - sentAt(a))) {
    const p = ft.properties, ugc = (p.geocode && p.geocode.UGC) || [];
    if (superseded.has(p.id) || p.messageType === 'Cancel') continue;
    if (!ft.geometry && zones.length && ugc.length && !zones.some(z => ugc.includes(z))) continue;
    const key = `${p.event}|${p.ends || p.expires || ''}`;
    if (seen.has(key)) continue;
    seen.add(key); out.push(ft);
  }
  return out;
}

/** Does this alert's polygon reach the grounds: a 3 km square around the point, tested at nine points, and the polygon's own corners inside it. Zone-wide alerts (no polygon) always do. */
export function reaches(geometry, lat, lon, km = 1.5) {
  if (!geometry) return true;
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (!polys) return true;
  const dLat = km / 111.195, dLon = km / (111.195 * Math.cos(lat * Math.PI / 180));
  const samples = []; for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) samples.push([lon + j * dLon, lat + i * dLat]);
  const inRing = (ring, x, y) => { let inside = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const [xi, yi] = ring[i], [xj, yj] = ring[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside; } return inside; };
  for (const poly of polys) {
    const ring = poly?.[0] || [];
    if (samples.some(([x, y]) => inRing(ring, x, y))) return true;
    if (ring.some(([x, y]) => Math.abs(x - lon) <= dLon && Math.abs(y - lat) <= dLat)) return true;
  }
  return false;
}
/**
 * The alerts that apply to a festival's grounds, not just one point on them: everything active for the point's county and
 * forecast zones, then a polygon warning only where its polygon reaches the grounds, a zone-wide alert as it is. A storm
 * warning whose edge crosses the grounds is caught; one across the county that misses them is not. The point query stands in
 * when the zones are unknown.
 */
export async function alertsFor(lat, lon) {
  let zones = [];
  try { const p = await point(lat, lon); zones = [...new Set([p.county, p.forecastZone, p.fireWeatherZone].map(u => String(u || '').split('/').pop()).filter(z => /^[A-Z]{2}[CZ]\d{3}$/.test(z)))]; } catch {}
  if (!zones.length) return activeAlerts(lat, lon);
  const fc = await nws(`https://api.weather.gov/alerts/active?zone=${zones.join(',')}`);
  return condense((fc.features || []).filter(ft => reaches(ft.geometry, lat, lon)), zones).map(normalizeAlert);
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
    temperature: g.temperature, relativeHumidity: g.relativeHumidity, windSpeed: g.windSpeed, skyCover: g.skyCover };
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
