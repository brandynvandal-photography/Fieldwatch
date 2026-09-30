// The ground under a festival, as far as free data says: how much rain fell in the last two days (the Iowa Environmental
// Mesonet's daily point analysis, radar-derived, CONUS), and what the festival record itself carries about the surface.
// Read every three hours per festival while it is on; the model in incoming.js turns it into mud tiers.
import { iso } from './util.js';

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
  return { ...(f.ground || {}), past, ...(pastError && !past ? { pastError } : {}), at: iso(now) };
}
export const groundStatus = () => ({ cached: cache.size, errors: [...cache.values()].filter(c => c.pastError).length });
