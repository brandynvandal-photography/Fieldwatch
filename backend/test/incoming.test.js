// What is coming: the forecast window a heads-up is about, the wording of the notification, and what to do with the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourly, grid } from './fixtures/nws.js';
import { THRESHOLDS, alertHazard, allocate, headline, headsUpAlert, incoming, prep, spreadGrid } from '../src/incoming.js';

// The fixtures as the poller sees them: 48 hours from 18:00Z, thunder 40% from hour 3 and 60% at hours 6-7, gusts peaking at 34 mph, heat index 96.
const periods = hourly.properties.periods.map(x => ({ startTime: x.startTime, temperature: x.temperature, shortForecast: x.shortForecast, windSpeed: x.windSpeed, precipChance: x.probabilityOfPrecipitation?.value ?? null }));
const g = spreadGrid({ heatIndex: grid.properties.heatIndex, windGust: grid.properties.windGust, probabilityOfThunder: grid.properties.probabilityOfThunder, quantitativePrecipitation: grid.properties.quantitativePrecipitation }, periods);
const at = (h, m = 0) => Date.UTC(2026, 9, 23, 18 + h, m);
const TZ = 'America/New_York';
const festival = { id: 'hulaween-2026', name: 'Suwannee Hulaween', location: 'Live Oak, FL' };

test('the first stretch of the next twelve hours over a threshold is the window: storms from hour 3, two and a half hours out', () => {
  const inc = incoming({ hourly: periods, grid: g, now: at(0, 30) });
  assert.equal(inc.hazard, 'storms'); assert.equal(inc.source, 'forecast');
  assert.equal(inc.startsAt, new Date(at(3)).toISOString()); assert.equal(inc.minutes, 150);
  assert.equal(inc.endsAt, new Date(at(12)).toISOString(), 'thunder stays at or over 30% through hour 11');
  assert.equal(inc.peak.thunder, 60); assert.equal(Math.round(inc.peak.gust), 34, 'gusts of 34 mph are under the 35 mph line'); assert.equal(inc.peak.precip, 40);
  assert.equal(inc.peak.rainIn, 0.55, 'the rain in the window, in inches, from the grid amount'); assert.equal(inc.peak.rateInHr, 0.08);
  assert.equal(headline(inc, TZ), 'Storms expected around 5:00 PM');
});

test('grid rain is shared out to the hours by the chance of rain when every hour has one, evenly otherwise', () => {
  const series = { values: [{ validTime: `${new Date(at(0)).toISOString()}/PT3H`, value: 25.4 }] };
  const even = allocate(series, periods.slice(0, 3).map(p => ({ ...p, precipChance: null })));
  assert.deepEqual(Object.values(even).map(v => Math.round(v * 1000) / 1000), [0.333, 0.333, 0.333], 'an inch over three hours with no chances: a third each');
  const skewed = allocate(series, [{ startTime: new Date(at(0)).toISOString(), precipChance: 20 }, { startTime: new Date(at(1)).toISOString(), precipChance: 60 }, { startTime: new Date(at(2)).toISOString(), precipChance: 20 }]);
  assert.deepEqual(Object.values(skewed).map(v => Math.round(v * 100) / 100), [0.2, 0.6, 0.2], 'the wettest hour by chance gets the most of the amount');
  assert.deepEqual(allocate({ values: [{ validTime: 'nonsense/PT6H', value: 5 }] }, periods), {}, 'a value with no start is dropped');
});

test('inside the window the countdown is zero and the wording says now', () => {
  const inc = incoming({ hourly: periods, grid: g, now: at(4) });
  assert.equal(inc.minutes, 0); assert.equal(inc.hazard, 'storms');
  assert.equal(headline(inc, TZ), 'Storms expected now');
});

test('a watch or warning that has not begun wins when it comes first; a heads-up already stored is not a watch', () => {
  const watch = { id: 'w1', event: 'Severe Thunderstorm Watch', onset: new Date(at(2)).toISOString(), expiresAt: new Date(at(9)).toISOString(), channel: 'weather' };
  const inc = incoming({ hourly: periods, grid: g, alerts: [watch], now: at(0, 30) });
  assert.equal(inc.source, 'alert'); assert.equal(inc.event, 'Severe Thunderstorm Watch'); assert.equal(inc.minutes, 90); assert.equal(inc.endsAt, watch.expiresAt);
  assert.equal(headline(inc, TZ), 'Severe Thunderstorm Watch begins 4:00 PM');
  const ours = { id: 'headsup-x', event: 'Storms expected around 4:00 PM', onset: new Date(at(2)).toISOString(), channel: 'headsup' };
  assert.equal(incoming({ hourly: periods, grid: g, alerts: [ours], now: at(0, 30) }).source, 'forecast');
  const begun = { ...watch, onset: new Date(at(0)).toISOString() };
  assert.equal(incoming({ hourly: periods, grid: g, alerts: [begun], now: at(0, 30) }).source, 'forecast', 'a watch already in effect is on the sky, not on the way');
  assert.equal(alertHazard('Flash Flood Warning'), 'flood'); assert.equal(alertHazard('High Wind Watch'), 'wind'); assert.equal(alertHazard('Rip Current Statement'), null);
});

test('heat, wind and rain have their own lines; a dry, calm forecast has nothing on the way', () => {
  const hot = { ...g, thunder: {}, rain: {}, heat: Object.fromEntries(Object.keys(g.heat).map(k => [k, 96])) };
  assert.equal(incoming({ hourly: periods, grid: hot, now: at(0, 30) }), null, `a heat index of 96 is under the ${THRESHOLDS.heatF} line`);
  hot.heat[Math.floor(at(2) / 3_600_000)] = 103;
  const heat = incoming({ hourly: periods, grid: hot, now: at(0, 30) });
  assert.equal(heat.hazard, 'heat'); assert.equal(heat.minutes, 90); assert.equal(headline(heat, TZ), 'Heat index near 103° expected around 4:00 PM');
  const windy = { ...g, thunder: {}, gust: { ...g.gust, [Math.floor(at(5) / 3_600_000)]: 45 } };
  const wind = incoming({ hourly: periods, grid: windy, now: at(0, 30) });
  assert.equal(wind.hazard, 'wind'); assert.equal(headline(wind, TZ), 'Gusts to 45 mph expected around 7:00 PM');
  const wet = periods.map((p, i) => ({ ...p, precipChance: i >= 4 ? 70 : 10 }));
  const chance = incoming({ hourly: wet, grid: { ...g, thunder: {}, rain: {} }, now: at(0, 30) });
  assert.equal(chance.hazard, 'rain'); assert.equal(headline(chance, TZ), 'Heavy rain expected around 6:00 PM'); assert.equal(chance.peak.rainIn, null, 'no amount on the grid: the chance of rain decides');
  const amount = incoming({ hourly: periods, grid: { ...g, thunder: {} }, now: at(0, 30) });
  assert.equal(amount.hazard, 'rain'); assert.equal(headline(amount, TZ), 'Heavy rain expected around 8:00 PM', 'with an amount, the rain starts where the half inch does, not where the chance says');
  assert.equal(amount.peak.rainIn, 0.5); assert.equal(amount.peak.precip, 40, 'a 40% chance is no longer a veto when the grid says half an inch');
  const drizzle = { ...g, thunder: {}, rain: Object.fromEntries(Object.entries(g.rain).map(([k, v]) => [k, v / 5])) };
  assert.equal(incoming({ hourly: periods, grid: drizzle, now: at(0, 30) }), null, 'a tenth of an inch spread over six hours is not worth a heads-up');
  assert.equal(incoming({ hourly: periods, grid: {}, now: at(0, 30) }), null, 'no grid, precip 40%: nothing');
  assert.equal(incoming({ hourly: periods, grid: g, now: at(20) }), null, 'past the storms, thunder is 0 for a day');
});

test('what to do depends on the time there is; the heads-up reads like an alert and carries the camp list', () => {
  assert.match(prep('storms', 10).timing, /^Go to shelter now/);
  assert.match(prep('storms', 45).timing, /^Finish securing camp/);
  assert.match(prep('storms', 150).timing, /^Secure camp now/);
  assert.match(prep('storms', 400).timing, /check back in an hour/);
  assert.match(prep('tornado', 150).shelter, /not safe from a tornado/);
  assert.ok(prep('wind', 60).camp.some(s => /canopies/.test(s)));
  const inc = incoming({ hourly: periods, grid: g, now: at(0, 30) });
  const a = headsUpAlert(festival, inc, TZ, at(0, 30));
  assert.equal(a.id, `headsup-hulaween-2026-${Math.floor(at(3) / 3_600_000)}`, 'one id per festival and starting hour, so a repeat updates rather than duplicates');
  assert.equal(a.event, 'Storms expected around 5:00 PM'); assert.equal(a.channel, 'headsup'); assert.equal(a.severity, 'moderate');
  assert.equal(a.headline, 'The forecast has a 60% chance of thunder and 0.6 in of rain. Secure camp now, charge phones, fill water, and decide where you will shelter.');
  assert.match(a.body, /^The forecast has a 60% chance of thunder and 0\.6 in of rain\. Secure camp now.*Tents, canopies and stages are not shelter\.$/);
  const wet = headsUpAlert(festival, { ...inc, hazard: 'rain', peak: { thunder: null, gust: 41, precip: 95, heat: null } }, TZ, at(0, 30));
  assert.match(wet.body, /^The forecast has gusts to 41 mph and a 95% chance of rain\. Secure camp now/, 'a sentence whatever leads it, not "rain 95%."');
  const three = headsUpAlert(festival, { ...inc, peak: { thunder: 60, gust: 45, precip: 70, heat: null } }, TZ, at(0, 30));
  assert.match(three.headline, /^The forecast has a 60% chance of thunder, gusts to 45 mph and a 70% chance of rain\. /);
  assert.match(a.instruction, /^Drop pop-up canopies and flags\. Stake every loop/);
  assert.equal(a.onset, inc.startsAt); assert.equal(a.expiresAt, inc.endsAt); assert.equal(a.hazard, 'storms'); assert.equal(a.minutes, 150);
  assert.equal(a.issuedAt, new Date(at(0, 30)).toISOString()); assert.equal(a.area, 'Live Oak, FL'); assert.equal(a.source, 'Fieldwatch forecast watch');
});
