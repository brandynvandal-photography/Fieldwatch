// Local Storm Reports from the weather service's offices, as the Iowa Environmental Mesonet republishes them (GeoJSON, no
// key): hail, wind damage, flooding, a funnel, measured and placed by the people who saw it. The ones within forty miles of
// the grounds in the last three hours, newest first, with the distance and the side, cached ten minutes per festival.
import { point } from './nws.js';
import { milesBetween } from './lightning.js';
import { USER_AGENT as UA } from './site.js';
import { iso } from './util.js';

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const cache = new Map();
export const resetStormReports = () => cache.clear();
export async function stormReportsFor(f, { now = Date.now(), fetchImpl = globalThis.fetch, hours = 3, miles = 40 } = {}) {
  const c = cache.get(f.id);
  if (c && now - c.at < 10 * 60_000) return c.reports;
  const p = await point(f.latitude, f.longitude), wfo = String(p.cwa || p.gridId || '').toUpperCase();
  const url = `https://mesonet.agron.iastate.edu/geojson/lsr.php?inc_ap=yes&sts=${encodeURIComponent(iso(now - hours * 3_600_000))}&ets=${encodeURIComponent(iso(now + 60_000))}&wfos=${encodeURIComponent(wfo)}`;
  const r = await fetchImpl(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`IEM LSR ${r.status}`);
  const fc = await r.json();
  const reports = (fc.features || []).map(ft => {
    const [lon, lat] = (ft.geometry && ft.geometry.coordinates) || [NaN, NaN], pr = ft.properties || {};
    const mi = milesBetween(f.latitude, f.longitude, lat, lon);
    const bearing = (Math.atan2(Math.sin((lon - f.longitude) * Math.PI / 180) * Math.cos(lat * Math.PI / 180), Math.cos(f.latitude * Math.PI / 180) * Math.sin(lat * Math.PI / 180) - Math.sin(f.latitude * Math.PI / 180) * Math.cos(lat * Math.PI / 180) * Math.cos((lon - f.longitude) * Math.PI / 180)) * 180 / Math.PI + 360) % 360;
    const mag = pr.magnitude === '' || pr.magnitude == null ? null : Number(pr.magnitude);
    return { kind: String(pr.typetext || pr.type || 'report'), magnitude: Number.isFinite(mag) ? mag : null, unit: pr.unit || null, place: String(pr.city || pr.county || ''), at: pr.valid || null,
      latitude: lat, longitude: lon, mi: Math.round(mi * 10) / 10, heading: COMPASS[Math.round(bearing / 45) % 8], remark: String(pr.remark || '').replace(/\s+/g, ' ').slice(0, 160) };
  }).filter(x => Number.isFinite(x.mi) && x.mi <= miles).sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0)).slice(0, 20);
  cache.set(f.id, { at: now, reports });
  return reports;
}
