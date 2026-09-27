import { q } from './db.js';
import { hourly } from './nws.js';
import { INCIDENT_WINDOW_MS } from './incidents.js';
import { iso } from './util.js';

// Forecasts change slowly; don't hit NWS for every download.
const forecastCache = new Map();
const FORECAST_TTL = 15 * 60_000;

export async function forecastFor(f) {
  const hit = forecastCache.get(f.id);
  if (hit && Date.now() - hit.at < FORECAST_TTL) return hit.periods;
  try {
    const periods = await hourly(f.latitude, f.longitude);
    forecastCache.set(f.id, { at: Date.now(), periods });
    return periods;
  } catch (e) {
    console.error(`[${f.id}] forecast failed:`, e.message);
    return hit?.periods ?? [];
  }
}

/** Everything the phone needs to work offline for this festival. Mirrors FestivalPack in Swift. */
export async function buildPack(f) {
  return {
    festival: f,
    alerts: q.activeAlerts(f.id),
    posts: q.posts(f.id),
    hourly: await forecastFor(f),
    incidents: q.publishedIncidents(f.id, Date.now() - INCIDENT_WINDOW_MS),
    generatedAt: iso(),
  };
}
