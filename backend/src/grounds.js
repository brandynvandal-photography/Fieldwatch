// Known grounds: the places festivals happen, each with the pin on the grounds themselves, the county, whether people camp,
// whether it is a building. A ticket site's pin is often the box office, the lodge or the town, so a listing within a short
// walk of known grounds, or a bit further when it names them, takes the grounds' pin and facts. data/grounds.json is
// curated like festivals.json; verifiedOn is null until someone has dropped the pin on a map.
import { readFileSync } from 'node:fs';
import { distanceKm } from './festivals.js';
import { sameCore } from './names.js';

let list = null;
export const grounds = () => (list ||= JSON.parse(readFileSync(new URL('../data/grounds.json', import.meta.url), 'utf8')));
export const resetGrounds = () => { list = null; };

const CLOSE_KM = 1, NAMED_KM = 3;
/** The known grounds a listing is on: within a kilometer of the pin, or within three when the listing names them. */
export function groundsFor(f) {
  let best = null;
  for (const g of grounds()) {
    const km = distanceKm(f, g);
    if (km > NAMED_KM) continue;
    const named = sameCore(String(f.location || ''), g.name) || String(f.location || '').toLowerCase().includes(g.name.toLowerCase());
    if (km <= CLOSE_KM || named) { if (!best || km < best.km) best = { g, km }; }
  }
  return best ? best.g : null;
}
/** The listing moved onto its grounds: the grounds' pin, name and county, and what the grounds say about camping and a roof unless the listing already says. */
export function snapToGrounds(f) {
  const g = f && Number.isFinite(f.latitude) && Number.isFinite(f.longitude) ? groundsFor(f) : null;
  if (!g) return f;
  const out = { ...f, latitude: g.latitude, longitude: g.longitude, location: `${g.name}, ${g.town}`, grounds: g.id };
  if (!out.county && g.county) out.county = g.county;
  if (out.camping !== true && out.camping !== false && (g.camping === true || g.camping === false)) out.camping = g.camping;
  if (out.indoor !== true && out.indoor !== false && (g.indoor === true || g.indoor === false)) out.indoor = g.indoor;
  return out;
}
