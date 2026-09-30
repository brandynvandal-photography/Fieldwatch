// National Weather Service API. Free, no key, but it wants a User-Agent with a contact.
const UA = process.env.NWS_USER_AGENT || 'Fieldwatch/0.1 (you@example.com)';

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
  };
}

export async function activeAlerts(lat, lon) {
  const fc = await nws(`https://api.weather.gov/alerts/active?point=${fmt(lat)},${fmt(lon)}`);
  return (fc.features || []).map(normalizeAlert);
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
  return { heatIndex: g.heatIndex, windGust: g.windGust, probabilityOfThunder: g.probabilityOfThunder };
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
