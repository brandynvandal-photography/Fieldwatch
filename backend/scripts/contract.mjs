#!/usr/bin/env node
// The outside services this app reads, checked for the shapes it parses: node backend/scripts/contract.mjs [https://backend]
// Each line is one check; the exit code is the number that failed. Run nightly by .github/workflows/contract.yml and by hand
// before a weekend. No keys: everything here is public.
import { hourPrefix, parseListing } from '../src/lightning.js';

const UA = `Fieldwatch/contract (+https://brandynvandal-photography.github.io/Fieldwatch/)`;
const POINT = [30.404, -82.9395];   // Live Oak, FL: the seed's first festival
const checks = [], fails = [];
const check = (name, fn) => checks.push({ name, fn });
async function get(url, accept = 'application/geo+json') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: accept }, signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}
const json = async url => (await get(url)).json();
const must = (cond, what) => { if (!cond) throw new Error(what); };

let point = null;
check('NWS /points names the forecast, the grid, the zone and the clock', async () => {
  point = (await json(`https://api.weather.gov/points/${POINT[0]},${POINT[1]}`)).properties;
  for (const k of ['forecastHourly', 'forecastGridData', 'forecast', 'timeZone', 'county', 'forecastZone']) must(point[k], `no ${k}`);
});
check('NWS hourly periods carry a temperature, words and a chance of rain', async () => {
  const p = (await json(point.forecastHourly)).properties.periods;
  must(Array.isArray(p) && p.length >= 24, `${p?.length} periods`);
  must(typeof p[0].temperature === 'number' && typeof p[0].shortForecast === 'string' && 'probabilityOfPrecipitation' in p[0], 'period shape');
});
check('NWS grid carries the series the model reads', async () => {
  const g = (await json(point.forecastGridData)).properties;
  for (const k of ['heatIndex', 'windGust', 'probabilityOfThunder', 'quantitativePrecipitation', 'temperature', 'relativeHumidity', 'windSpeed', 'skyCover', 'windDirection', 'apparentTemperature']) must(Array.isArray(g[k]?.values), `no ${k}.values`);
  must(/^[^/]+\/P/.test(g.temperature.values[0]?.validTime || ''), 'validTime is an ISO interval');
});
check('NWS alerts answer a feature collection by zone and by point', async () => {
  const z = await json(`https://api.weather.gov/alerts/active?zone=${encodeURIComponent(String(point.forecastZone).split('/').pop())}`);
  must(z.type === 'FeatureCollection' && Array.isArray(z.features), 'zone shape');
  const p = await json(`https://api.weather.gov/alerts/active?point=${POINT[0]},${POINT[1]}`);
  must(p.type === 'FeatureCollection', 'point shape');
});
check('a GOES-East lightning bucket lists the current hour', async () => {
  const r = await get(`https://noaa-goes19.s3.amazonaws.com/?list-type=2&prefix=${encodeURIComponent(hourPrefix(Date.now() - 15 * 60_000))}`, '*/*');
  const keys = parseListing(await r.text());
  must(keys.length > 0, 'no files in the last hour'); must(keys.every(k => /GLM-L2-LCFA/.test(k)), 'unexpected keys');
});
check('the radar archive answers a frame as a PNG', async () => {
  const t = new Date(Math.floor((Date.now() - 20 * 60_000) / 300_000) * 300_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const p = new URLSearchParams({ SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetMap', LAYERS: 'nexrad-n0q-wmst', STYLES: '', SRS: 'EPSG:3857', BBOX: '-9400000,3400000,-9080000,3720000', WIDTH: '64', HEIGHT: '64', FORMAT: 'image/png', TRANSPARENT: 'true', TIME: t });
  const r = await get(`https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?${p}`, 'image/png');
  const b = Buffer.from(await r.arrayBuffer());
  must(b.length > 8 && b.readUInt32BE(0) === 0x89504e47, `not a PNG (${r.headers.get('content-type')})`);
});
const base = (process.argv[2] || process.env.FIELDWATCH_URL || '').replace(/\/$/, '');
if (base) check(`the backend at ${base} is ok`, async () => {
  const h = await json(`${base}/health`);
  must(h.ok === true, `problems: ${(h.problems || []).join('; ')}`);
});

for (const c of checks) {
  try { await c.fn(); console.log(`ok   ${c.name}`); }
  catch (e) { fails.push(c.name); console.log(`FAIL ${c.name}: ${e.message}`); }
}
console.log(`${checks.length - fails.length} of ${checks.length} ok`);
process.exit(fails.length);
