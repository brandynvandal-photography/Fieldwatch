// What is coming: the forecast window a heads-up is about, the wording of the notification, and what to do with the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourly, grid } from './fixtures/nws.js';
import { TIER, THRESHOLDS, alertHazard, allocate, campFor, deadlines, groundWords, headline, headsUpAlert, incoming, lineWords, mudTier, mudWords, prep, spreadGrid, windLine } from '../src/incoming.js';

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
  assert.equal(inc.peak.thunder, 60); assert.equal(Math.round(inc.peak.gust), 34); assert.equal(inc.peak.precip, 40);
  assert.deepEqual(inc.wind, { line: 30, crossed: ['canopies'] }, 'gusts of 34 mph are past the canopy line, the line when nothing else is known to be standing');
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
  const hot = { ...g, thunder: {}, rain: {}, gust: {}, heat: Object.fromEntries(Object.keys(g.heat).map(k => [k, 96])) };
  assert.equal(incoming({ hourly: periods, grid: hot, now: at(0, 30) }), null, `a heat index of 96 is under the ${THRESHOLDS.heatF} line`);
  hot.heat[Math.floor(at(2) / 3_600_000)] = 103;
  const heat = incoming({ hourly: periods, grid: hot, now: at(0, 30) });
  assert.equal(heat.hazard, 'heat'); assert.equal(heat.minutes, 90); assert.equal(headline(heat, TZ), 'Heat index near 103° expected around 4:00 PM');
  const windy = { ...g, thunder: {}, rain: {}, gust: { ...g.gust, [Math.floor(at(5) / 3_600_000)]: 45 } };
  const wind = incoming({ hourly: periods, grid: windy, now: at(0, 30) });
  assert.equal(wind.hazard, 'wind'); assert.equal(headline(wind, TZ), 'Gusts to 45 mph, past the canopy line, expected around 6:00 PM', 'the canopy line is 30 mph, crossed at hour 4');
  const stage = incoming({ hourly: periods, grid: windy, ground: { structures: ['stage'] }, now: at(0, 30) });
  assert.equal(headline(stage, TZ), 'Gusts to 45 mph, past the stage hold line, expected around 7:00 PM', 'only a stage standing: the 40 mph line, crossed an hour later');
  const both = incoming({ hourly: periods, grid: windy, ground: { structures: ['inflatables', 'stage'] }, now: at(0, 30) });
  assert.equal(headline(both, TZ), 'Gusts to 45 mph, past the inflatables and stage hold lines, expected around 4:00 PM', 'inflatables come down at 20 mph');
  assert.deepEqual(campFor(both).slice(0, 2), ['Stage: clear the deck, drop the scrim and the banners', 'Deflate and tie down the inflatables'], 'what is standing comes first on the list');
  assert.equal(windLine({}), 30); assert.equal(windLine({ structures: [] }), 30); assert.equal(windLine({ structures: ['stage'] }), 40); assert.equal(lineWords(['canopies']), 'the canopy line'); assert.equal(lineWords([]), '');
  const wet = periods.map((p, i) => ({ ...p, precipChance: i >= 4 ? 70 : 10 }));
  const chance = incoming({ hourly: wet, grid: { ...g, thunder: {}, rain: {}, gust: {} }, now: at(0, 30) });
  assert.equal(chance.hazard, 'rain'); assert.equal(headline(chance, TZ), 'Heavy rain expected around 6:00 PM'); assert.equal(chance.peak.rainIn, null, 'no amount on the grid: the chance of rain decides');
  const amount = incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {} }, now: at(0, 30) });
  assert.equal(amount.hazard, 'rain'); assert.equal(headline(amount, TZ), 'Rain expected around 8:00 PM', 'with an amount, the rain starts where the half inch does, not where the chance says; half an inch on average soil is rain, not mud');
  assert.equal(amount.mud.tier, 'wet');
  assert.equal(amount.peak.rainIn, 0.5); assert.equal(amount.peak.precip, 40, 'a 40% chance is no longer a veto when the grid says half an inch');
  const drizzle = { ...g, thunder: {}, gust: {}, rain: Object.fromEntries(Object.entries(g.rain).map(([k, v]) => [k, v / 5])) };
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
  assert.equal(a.headline, 'Stake every loop, tie guy lines, weigh the legs by 4:35 PM. The forecast has a 60% chance of thunder, gusts to 34 mph past the canopy line and 0.6 in of rain.', 'the first thing to do and when, then the forecast');
  assert.match(a.body, /^Stake every loop, tie guy lines, weigh the legs by 4:35 PM\. The forecast has a 60% chance of thunder, gusts to 34 mph past the canopy line and 0\.6 in of rain\. Secure camp now.*Tents, canopies and stages are not shelter\.$/);
  const wet = headsUpAlert(festival, { ...inc, hazard: 'rain', peak: { thunder: null, gust: 41, precip: 95, heat: null } }, TZ, at(0, 30));
  assert.match(wet.body, /^Bins and bags off the floor by 4:40 PM\. The forecast has gusts to 41 mph past the canopy line and a 95% chance of rain\. /, 'a sentence whatever leads it, not "rain 95%."');
  const three = headsUpAlert(festival, { ...inc, peak: { thunder: 60, gust: 45, precip: 70, heat: null } }, TZ, at(0, 30));
  assert.match(three.headline, /^Stake every loop, tie guy lines, weigh the legs by 4:35 PM\. The forecast has a 60% chance of thunder, gusts to 45 mph past the canopy line and a 70% chance of rain\.$/);
  assert.equal(a.instruction, 'Stake every loop, tie guy lines, weigh the legs by 4:35 PM. Unplug and bag electronics by 4:40 PM. Move poles and chairs away from where people sit by 4:40 PM. Drop pop-up canopies and flags by 4:45 PM.', 'every task with its start-by time, the longest first');
  assert.equal(a.mud, 'wet'); assert.equal(a.plan.length, 4); assert.equal(a.plan[0].startBy, new Date(at(3) - 25 * 60000).toISOString());
  assert.equal(a.onset, inc.startsAt); assert.equal(a.expiresAt, inc.endsAt); assert.equal(a.hazard, 'storms'); assert.equal(a.minutes, 150);
  assert.equal(a.issuedAt, new Date(at(0, 30)).toISOString()); assert.equal(a.area, 'Live Oak, FL'); assert.equal(a.source, 'Fieldwatch forecast watch');
});

test('mud: what the rain does to this ground, by soil and surface, with what already fell counted', () => {
  const t = (ground, ahead, rate = 0) => mudTier(ground, ahead, rate).tier;
  assert.equal(t({}, 0.5), 'wet', 'half an inch on average soil: wet, not muddy'); assert.equal(t({}, 0.8), 'soft'); assert.equal(t({}, 1.6), 'deep');
  assert.equal(t({ soil: 'A' }, 1.2), 'wet', 'sand drains'); assert.equal(t({ soil: 'A' }, 1.6), 'soft');
  assert.equal(t({ soil: 'D' }, 0.3), 'soft', 'clay goes at a third of an inch'); assert.equal(t({ soil: 'D' }, 0.6), 'deep');
  assert.equal(t({ soil: 'C', surface: 'dirt' }, 0.3), 'soft', 'bare dirt sooner than grass'); assert.equal(t({ soil: 'C', surface: 'gravel' }, 1.0), 'wet', 'gravel later');
  assert.equal(t({ surface: 'pavement' }, 0.05), 'wet'); assert.equal(t({ surface: 'pavement' }, 0.4), 'slick'); assert.equal(t({ surface: 'pavement' }, 1.2), 'runoff'); assert.equal(t({ surface: 'pavement' }, 0.4, 0.35), 'runoff', 'a hard rate runs off whatever the total');
  assert.equal(t({ surface: 'sand' }, 2), 'wet', 'sand never makes mud'); assert.equal(t({ surface: 'sand', low: true }, 1.2), 'water');
  assert.equal(t({ low: true }, 1.1), 'water', 'low ground floods before it turns to mud'); assert.equal(t({ low: true }, 0.4), 'wet');
  const wetWeek = mudTier({ soil: 'B', past: { in24: 1.0, in48: 1.5 } }, 0.3);
  assert.equal(wetWeek.past, 0.75, 'yesterday at six tenths, the day before at three tenths'); assert.equal(wetWeek.effective, 1.05); assert.equal(wetWeek.tier, 'soft'); assert.equal(wetWeek.threshold, 0.75);
  assert.equal(groundWords({ surface: 'grass', soil: 'D', low: true }), 'grass over clay, low ground'); assert.equal(groundWords({ surface: 'pavement', soil: 'D' }), 'blacktop'); assert.equal(groundWords({}), 'grass');
  const inc = incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {} }, ground: { soil: 'D', past: { in24: 1.1, in48: 1.1 } }, now: at(0, 30) });
  assert.equal(inc.hazard, 'rain'); assert.equal(inc.mud.tier, 'deep'); assert.equal(headline(inc, TZ), 'Deep mud expected around 8:00 PM');
  assert.equal(mudWords(inc, { soil: 'D' }), 'Fields will not hold vehicles: 0.5 in of rain on grass over clay, after 0.7 in already down.');
  assert.deepEqual(campFor(inc), TIER.deep.camp);
  const storm = incoming({ hourly: periods, grid: g, ground: { soil: 'D' }, now: at(0, 30) });
  assert.equal(storm.hazard, 'storms'); assert.equal(storm.mud.tier, 'soft');
  assert.deepEqual(campFor(storm).slice(0, 2), ['Move the car to hard ground', 'Drop pop-up canopies and flags'], 'storms on soft ground: the car first, then the storm list');
  const alert = headsUpAlert(festival, inc, TZ, at(0, 30), { soil: 'D' });
  assert.equal(alert.event, 'Deep mud expected around 8:00 PM');
  assert.equal(alert.headline, 'Anything that must leave, leaves before it starts by 6:20 PM. Fields will not hold vehicles: 0.5 in of rain on grass over clay, after 0.7 in already down.', 'the rain rides in the mud sentence, the first deadline comes first');
  assert.equal(alert.mud, 'deep');
});

test('deadlines: each task starts its length plus ten minutes before the arrival, the longest first; past its time it is now', () => {
  const start = new Date(at(3)).toISOString(), now = at(0, 30);
  const plan = deadlines(start, ['Drop pop-up canopies and flags', 'Move the car to hard ground', 'Stake every loop, tie guy lines, weigh the legs', 'Know the route to high ground'], now);
  assert.deepEqual(plan.map(d => [d.task.split(' ')[0], d.minutes, new Date(d.startBy).toISOString().slice(11, 16), d.late]), [['Move', 60, '19:50', false], ['Stake', 15, '20:35', false], ['Drop', 5, '20:45', false], ['Know', 0, '20:50', false]]);
  const late = deadlines(start, ['Move the car to hard ground', 'Drop pop-up canopies and flags'], at(2, 30));
  assert.equal(late[0].late, true); assert.equal(late[0].startBy, new Date(at(2, 30)).toISOString(), 'the car should have moved already: now'); assert.equal(late[1].late, false);
});
