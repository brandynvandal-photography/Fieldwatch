// Alerts for the whole grounds: the zone query, the polygon test, and the point query as the fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertFeature, points } from './fixtures/nws.js';

process.env.NWS_USER_AGENT = 'Fieldwatch/test (test@example.com)';
const calls = [];
let answer = () => ({ features: [] }), pointsOk = true;
globalThis.fetch = async url => { url = String(url); calls.push(url); if (url.includes('/points/')) return pointsOk ? Response.json(points) : new Response('no', { status: 500 }); return Response.json(answer(url)); };
const { alertsFor, reaches } = await import('../src/nws.js');

const lat = 30.404, lon = -82.9395, ring = pts => ({ type: 'Polygon', coordinates: [pts.map(([y, x]) => [x, y])] });
test('a polygon reaches the grounds when it covers any of a 3 km square around them, or has a corner inside it', () => {
  assert.equal(reaches(null, lat, lon), true, 'a zone-wide alert always applies');
  assert.equal(reaches(ring([[30.3, -83.1], [30.5, -83.1], [30.5, -82.8], [30.3, -82.8]]), lat, lon), true, 'the grounds inside the polygon');
  assert.equal(reaches(ring([[30.41, -83.1], [30.6, -83.1], [30.6, -82.8], [30.41, -82.8]]), lat, lon), true, 'the polygon edge 700 m north of the pin still crosses the square');
  assert.equal(reaches(ring([[30.5, -83.1], [30.6, -83.1], [30.6, -82.8], [30.5, -82.8]]), lat, lon), false, 'ten km north misses');
  assert.equal(reaches(ring([[30.400, -82.9400], [30.400, -82.9300], [30.395, -82.9300], [30.395, -82.9400]]), lat, lon), true, 'a small polygon with a corner on the grounds');
  assert.equal(reaches({ type: 'MultiPolygon', coordinates: [[[[-83.1, 30.5], [-83.1, 30.6], [-82.8, 30.6], [-82.8, 30.5]]], [[[-83.1, 30.3], [-83.1, 30.5], [-82.8, 30.5], [-82.8, 30.3]]]] }, lat, lon), true, 'any part of a multipolygon');
});

test('the zone query keeps zone-wide alerts and the polygons that reach the grounds, drops the rest, and falls back to the point', async () => {
  const far = alertFeature({ id: 'far', event: 'Severe Thunderstorm Warning' }), near = alertFeature({ id: 'near', event: 'Tornado Warning' }), zone = alertFeature({ id: 'zone', event: 'Flood Watch' });
  far.geometry = ring([[30.5, -83.1], [30.6, -83.1], [30.6, -82.8], [30.5, -82.8]]);
  near.geometry = ring([[30.41, -83.1], [30.6, -83.1], [30.6, -82.8], [30.41, -82.8]]);
  answer = () => ({ features: [far, near, zone] });
  calls.length = 0;
  const got = await alertsFor(lat, lon);
  assert.deepEqual(got.map(a => a.id), ['near', 'zone'], 'the warning across the county misses the grounds and is left out');
  assert.ok(calls.some(u => u.endsWith('/alerts/active?zone=FLC121,FLZ024')), `county and forecast zones in one query: ${calls}`);
  pointsOk = false; calls.length = 0;
  answer = url => ({ features: url.includes('point=') ? [zone] : [] });
  assert.deepEqual((await alertsFor(31, -84)).map(a => a.id), ['zone'], 'no zones known: the point query');
  assert.ok(calls.some(u => u.includes('/alerts/active?point=31.0000,-84.0000')));
});
