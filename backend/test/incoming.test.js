// What is coming: the forecast window a heads-up is about, the wording of the notification, and what to do with the time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hourly, grid } from './fixtures/nws.js';
import { TIER, THRESHOLDS, alertHazard, allocate, campFor, condense, deadlines, dirWords, flagText, groundWords, gustOdds, headline, headsUpAlert, heatFlag, incoming, keepGeometry, lineWords, mudTier, mudWords, prep, reaches, spreadGrid, sunTimes, timing, wbgtF, windLine, zonesOf } from '../src/incoming.js';

// The fixtures as the poller sees them: 48 hours from 18:00Z, thunder 40% from hour 3 and 60% at hours 6-7, gusts peaking at 34 mph, heat index 96.
const periods = hourly.properties.periods.map(x => ({ startTime: x.startTime, temperature: x.temperature, shortForecast: x.shortForecast, windSpeed: x.windSpeed, precipChance: x.probabilityOfPrecipitation?.value ?? null }));
const g = spreadGrid({ heatIndex: grid.properties.heatIndex, windGust: grid.properties.windGust, probabilityOfThunder: grid.properties.probabilityOfThunder, quantitativePrecipitation: grid.properties.quantitativePrecipitation,
  temperature: grid.properties.temperature, relativeHumidity: grid.properties.relativeHumidity, windSpeed: grid.properties.windSpeed, skyCover: grid.properties.skyCover,
  windDirection: grid.properties.windDirection, apparentTemperature: grid.properties.apparentTemperature }, periods);
const at = (h, m = 0) => Date.UTC(2026, 9, 23, 18 + h, m);
const TZ = 'America/New_York';
const festival = { id: 'hulaween-2026', name: 'Suwannee Hulaween', location: 'Live Oak, FL' };
const CAMP = { camping: true };
const PREP_DAY_WIND = ['Stay clear of stages, towers and banners', 'Tie down or bag hats and light things', 'Know where the shelter is'];

test('the first stretch of the next twelve hours over a threshold is the window: storms from hour 3, two and a half hours out', () => {
  const inc = incoming({ hourly: periods, grid: g, now: at(0, 30) });
  assert.equal(inc.hazard, 'storms'); assert.equal(inc.source, 'forecast');
  assert.equal(inc.startsAt, new Date(at(3)).toISOString()); assert.equal(inc.minutes, 150);
  assert.equal(inc.endsAt, new Date(at(12)).toISOString(), 'thunder stays at or over 30% through hour 11');
  assert.equal(inc.peak.thunder, 60); assert.equal(Math.round(inc.peak.gust), 34); assert.equal(inc.peak.precip, 40);
  assert.deepEqual(inc.wind, { line: 30, crossed: ['canopies'], odds: 'possible' }, 'gusts of 34 mph are past the canopy line, the line when nothing else is known to be standing, but only just: possible, not likely');
  assert.equal(inc.peak.dir, 'SW'); assert.equal(inc.peak.wind, 10); assert.equal(inc.peak.feels, 71, 'the window knows where the wind comes from and the coldest it feels in it');
  assert.equal(inc.next, undefined, 'nothing after the storms in these twelve hours');
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
  const warning = { ...begun, id: 'w2', event: 'Severe Thunderstorm Warning' };
  assert.equal(incoming({ hourly: periods, grid: g, alerts: [warning], now: at(0, 30) }), null, 'a warning already in effect says it all: no heads-up for the same storms');
  assert.equal(incoming({ hourly: periods, grid: g, alerts: [{ ...warning, event: 'Flood Warning' }], now: at(0, 30) }).source, 'forecast', 'a warning for something else leaves the storms heads-up alone');
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
  assert.equal(wind.hazard, 'wind'); assert.equal(headline(wind, TZ), 'Gusts to 45 mph from the SW past the canopy line expected around 6:00 PM', 'the canopy line is 30 mph, crossed at hour 4, and the wind has a side');
  assert.equal(wind.wind.odds, 'likely', 'fifteen past the line is likely');
  assert.ok(campFor(wind, 'camping').includes('Park a vehicle on the SW side as a windbreak'), 'the windbreak goes on the side the wind comes from');
  const marginal = incoming({ hourly: periods, grid: { ...windy, gust: { ...g.gust, [Math.floor(at(5) / 3_600_000)]: 33 }, dir: {} }, now: at(0, 30) });
  assert.equal(headline(marginal, TZ), 'Gusts to 33 mph, maybe past the canopy line, expected around 6:00 PM', 'just over the line: maybe, and no side when the grid has none');
  assert.ok(campFor(marginal, 'camping').includes('Park a vehicle upwind as a windbreak'));
  const stage = incoming({ hourly: periods, grid: windy, ground: { structures: ['stage'] }, now: at(0, 30) });
  assert.equal(headline(stage, TZ), 'Gusts to 45 mph from the SW, maybe past the stage hold line, expected around 7:00 PM', 'only a stage standing: the 40 mph line, crossed an hour later, and by five: maybe');
  const both = incoming({ hourly: periods, grid: windy, ground: { structures: ['inflatables', 'stage'] }, now: at(0, 30) });
  assert.equal(headline(both, TZ), 'Gusts to 45 mph from the SW past the inflatables and stage hold lines expected around 4:00 PM', 'inflatables come down at 20 mph');
  assert.deepEqual(campFor(both, 'crew').slice(0, 2), ['Clear the stage deck and drop the scrim and banners', 'Deflate and tie down the inflatables'], 'what is standing comes first on the list, for crew');
  assert.deepEqual(campFor(both, 'day'), PREP_DAY_WIND, 'a day visitor cannot touch the stage; their list is their own');
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
  assert.match(prep('storms', 400).timing, /Check back in an hour/);
  assert.match(prep('tornado', 150).shelter, /not safe from a tornado/);
  assert.ok(prep('wind', 60).camp.some(s => /canopies/.test(s)));
  const inc = incoming({ hourly: periods, grid: g, now: at(0, 30) });
  const a = headsUpAlert(festival, inc, TZ, at(0, 30), CAMP);
  assert.equal(a.id, `headsup-hulaween-2026-${Math.floor(at(3) / 3_600_000)}`, 'one id per festival and starting hour, so a repeat updates rather than duplicates');
  assert.equal(a.event, 'Storms expected around 5:00 PM'); assert.equal(a.channel, 'headsup'); assert.equal(a.severity, 'moderate');
  assert.equal(a.headline, 'Stake every loop, tie guy lines, weigh the legs by 4:35 PM. The forecast has a 60% chance of thunder, gusts to 34 mph, maybe past the canopy line and 0.6 in of rain.', 'the first thing to do and when, then the forecast');
  assert.match(a.body, /^Stake every loop, tie guy lines, weigh the legs by 4:35 PM\. The forecast has a 60% chance of thunder, gusts to 34 mph, maybe past the canopy line and 0\.6 in of rain\. Secure camp now.*Tents, canopies and stages are not shelter\.$/);
  const wet = headsUpAlert(festival, { ...inc, hazard: 'rain', peak: { thunder: null, gust: 41, precip: 95, heat: null }, wind: { line: 30, crossed: ['canopies'], odds: 'likely' } }, TZ, at(0, 30), CAMP);
  assert.match(wet.body, /^Bins and bags off the floor by 4:40 PM\. The forecast has gusts to 41 mph past the canopy line and a 95% chance of rain\. /, 'a sentence whatever leads it, not "rain 95%."');
  const three = headsUpAlert(festival, { ...inc, peak: { thunder: 60, gust: 45, precip: 70, heat: null }, wind: { line: 30, crossed: ['canopies'], odds: 'likely' } }, TZ, at(0, 30), CAMP);
  const day = headsUpAlert(festival, inc, TZ, at(0, 30));
  assert.equal(day.setup, 'day'); assert.match(day.headline, /^Charge the phone, fill water by 4:40 PM\. /, 'nobody knows if people camp here: no tent talk');
  assert.ok(!day.instruction.includes('canop') && !day.instruction.includes('tent'), 'a day visitor\'s list has no canopies or tents');
  assert.equal(a.setup, 'camping');
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
  const learned = mudTier({ soil: 'A', learned: { threshold: 0.4, samples: 3 } }, 0.5);
  assert.equal(learned.tier, 'soft'); assert.equal(learned.threshold, 0.4); assert.equal(learned.learned, true, 'what the ground did in the rain beats the soil table');
  assert.equal(groundWords({ surface: 'grass', soil: 'D', low: true }), 'grass over clay, low ground'); assert.equal(groundWords({ surface: 'pavement', soil: 'D' }), 'blacktop'); assert.equal(groundWords({}), 'grass');
  const inc = incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {} }, ground: { soil: 'D', past: { in24: 1.1, in48: 1.1 } }, now: at(0, 30) });
  assert.equal(inc.hazard, 'rain'); assert.equal(inc.mud.tier, 'deep'); assert.equal(headline(inc, TZ), 'Deep mud expected around 8:00 PM');
  assert.equal(mudWords(inc, { soil: 'D' }), 'Fields will not hold vehicles: 0.5 in of rain on grass over clay after 0.7 in already down.');
  assert.deepEqual(campFor(inc, 'camping'), TIER.deep.camping); assert.deepEqual(campFor(inc, 'day'), TIER.deep.day);
  assert.equal(TIER.soft.camping[0], 'Move the car to hard ground while it still can. A stuck car waits for the ground to dry', 'most people cannot move the car; the line says so');
  const storm = incoming({ hourly: periods, grid: g, ground: { soil: 'D' }, now: at(0, 30) });
  assert.equal(storm.hazard, 'storms'); assert.equal(storm.mud.tier, 'soft');
  assert.deepEqual(campFor(storm, 'camping').slice(0, 2), ['Move the car to hard ground while it still can. A stuck car waits for the ground to dry', 'Drop pop-up canopies and flags'], 'storms on soft ground: the car call first, then the storm list');
  assert.deepEqual(campFor(storm, 'day').slice(0, 2), ['Leave before it starts or wait it out', 'Know where the shelter is and how long the walk takes'], 'a day visitor hears about the lot, not the tent');
  const alert = headsUpAlert(festival, inc, TZ, at(0, 30), { soil: 'D', camping: true });
  assert.equal(alert.event, 'Deep mud expected around 8:00 PM');
  assert.match(headsUpAlert(festival, inc, TZ, at(0, 30), { soil: 'D' }).headline, /^Leave before it starts if you need to be anywhere by 6:20 PM\. /, 'a lot with no in and out: leave or stay, not move the car');
  assert.equal(alert.headline, 'Whatever must leave goes before it starts by 6:20 PM. Fields will not hold vehicles: 0.5 in of rain on grass over clay after 0.7 in already down.', 'the rain rides in the mud sentence, the first deadline comes first');
  assert.equal(alert.mud, 'deep');
});

test('deadlines: each task starts its length plus ten minutes before the arrival, the longest first; past its time it is now', () => {
  const start = new Date(at(3)).toISOString(), now = at(0, 30);
  const car = 'Move the car to hard ground while it still can. A stuck car waits for the ground to dry';
  const plan = deadlines(start, ['Drop pop-up canopies and flags', car, 'Stake every loop, tie guy lines, weigh the legs', 'Know the route to high ground'], now);
  assert.deepEqual(plan.map(d => [d.task.split(' ')[0], d.minutes, new Date(d.startBy).toISOString().slice(11, 16), d.late]), [['Move', 60, '19:50', false], ['Stake', 15, '20:35', false], ['Drop', 5, '20:45', false], ['Know', 0, '20:50', false]]);
  const late = deadlines(start, [car, 'Drop pop-up canopies and flags'], at(2, 30));
  assert.equal(late[0].late, true); assert.equal(late[0].startBy, new Date(at(2, 30)).toISOString(), 'the car should have moved already: now'); assert.equal(late[1].late, false);
});

test('heat by exertion: an estimated wet-bulb globe temperature earns a flag, and red or black is a hazard whatever the heat index', () => {
  assert.equal(wbgtF(null, 50), null); assert.equal(wbgtF(80, null), null);
  const sun = wbgtF(93, 45, 0, 0), shade = wbgtF(85, 60, 8, 50);
  assert.ok(sun >= 85 && sun < 88, `93° and 45% in full sun is a red flag day: ${sun}`); assert.equal(heatFlag(sun), 'red');
  assert.ok(shade < 82, `85° and 60% under half cloud with a breeze is green: ${shade}`); assert.equal(heatFlag(shade), 'green');
  assert.ok(wbgtF(96, 55, 3, 10) >= 88, 'black at 96° and 55%'); assert.ok(wbgtF(93, 45, 0, 0) > wbgtF(93, 45, 15, 0), 'wind cools the globe'); assert.ok(wbgtF(93, 45, 0, 0) > wbgtF(93, 45, 0, 90), 'so does cloud');
  assert.match(flagText('red'), /^Red flag: work 30, rest 30/); assert.match(flagText('black'), /stop heavy work/); assert.equal(flagText(null), '');
  const inc = incoming({ hourly: periods, grid: g, now: at(0, 30) });
  assert.equal(inc.flag, 'green', 'the fixture evening is green'); assert.ok(inc.peak.wbgt < 82);
  // A clear, calm 90° afternoon at 55%: the heat index stays under 100, the wet-bulb globe says red.
  const hot = { ...g, thunder: {}, rain: {}, gust: {}, temp: Object.fromEntries(Object.keys(g.temp).map(k => [k, 90])), rh: Object.fromEntries(Object.keys(g.rh).map(k => [k, 55])), wind: {}, sky: {} };
  const red = incoming({ hourly: periods, grid: hot, now: at(0, 30) });
  assert.equal(red.hazard, 'heat'); assert.equal(red.flag, 'red'); assert.ok(red.peak.heat < THRESHOLDS.heatF, 'the heat index alone would not have called it'); assert.ok(red.peak.wbgt >= 85);
  assert.equal(headline(red, TZ), 'Red flag heat expected now', 'from the first hour');
  const a = headsUpAlert(festival, red, TZ, at(0, 30));
  assert.equal(a.flag, 'red'); assert.match(a.headline, /red flag heat for anyone working or dancing\.$/); assert.match(a.body, /Red flag: work 30, rest 30 in shade\. Water every 15 minutes\./);
  assert.equal(campFor(red, 'camping')[0], 'A tarp over the tent for shade'); assert.equal(campFor(red)[0], 'Water every twenty minutes');
});

test('rain already on the radar pulls the start of a window earlier, or is a window of its own when the forecast has none', () => {
  const nowcast = { at: new Date(at(0, 20)).toISOString(), tracked: true, minutes: 40, speedKmh: 40, headingDeg: 45, heading: 'NE', raining: false };
  const moved = incoming({ hourly: periods, grid: g, nowcast, now: at(0, 30) });
  assert.equal(moved.hazard, 'storms'); assert.equal(moved.source, 'forecast'); assert.equal(moved.minutes, 40, 'the storm window starts when the radar says, not at the forecast hour'); assert.equal(moved.nowcast.heading, 'NE');
  const alone = incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {}, rain: {} }, nowcast, now: at(0, 30) });
  assert.equal(alone.source, 'radar'); assert.equal(alone.hazard, 'rain'); assert.equal(alone.minutes, 40);
  assert.equal(headline(alone, TZ), 'Rain on the radar about 40 min out');
  const a = headsUpAlert(festival, alone, TZ, at(0, 30));
  assert.match(a.headline, /^Rain shell and a bag for the phone by 2:55 PM\. On the radar moving NE at 25 mph\.$/, 'the radar line rides with the first task');
  assert.equal(incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {}, rain: {} }, nowcast: { ...nowcast, minutes: 150 }, now: at(0, 30) }), null, 'more than two hours out is the forecast\'s to call');
  assert.equal(incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {}, rain: {} }, nowcast: { ...nowcast, minutes: null }, now: at(0, 30) }), null, 'nothing coming this way');
  const later = incoming({ hourly: periods, grid: g, nowcast: { ...nowcast, minutes: 200 }, now: at(0, 30) });
  assert.equal(later.minutes, 150, 'a radar arrival after the forecast start changes nothing');
});

test('indoors: storms still count (people come and go), wind, heat and rain do not, and the advice is the building', () => {
  const inc = incoming({ hourly: periods, grid: g, ground: { indoor: true }, now: at(0, 30) });
  assert.equal(inc.hazard, 'storms'); assert.equal(inc.indoor, true); assert.equal(inc.mud, undefined, 'no mud indoors');
  assert.deepEqual(campFor(inc, 'camping'), ['Stay inside until it passes', 'Keep the line and the lot clear while it is overhead', 'Charge the phone'], 'the same list for everyone inside');
  const a = headsUpAlert(festival, inc, TZ, at(0, 30), { indoor: true });
  assert.match(a.body, /Inside is shelter\. The line and the lot outside are not\. A car is\./);
  assert.ok(!/canop|tent|camp/i.test(a.instruction), `nothing about tents or canopies: ${a.instruction}`);
  const calm = { ...g, thunder: {} };
  assert.equal(incoming({ hourly: periods, grid: calm, ground: { indoor: true }, now: at(0, 30) }), null, 'gusts of 34 mph and rain are nothing to a building');
  assert.ok(incoming({ hourly: periods, grid: calm, ground: {}, now: at(0, 30) }), 'outdoors the same forecast is a heads-up');
  assert.equal(prep('storms', 120, true).shelter, 'Inside is shelter. The line and the lot outside are not. A car is.');
});

test('a cold night, rain that floods, the next window, the sun, and the line for a window that comes while people sleep', () => {
  // Feels-like under 40° from hour 8: a cold night with its own list, after the storms in priority, never indoors.
  const chilly = { ...g, feels: Object.fromEntries(Object.keys(g.feels).map(k => [k, k >= String(Math.floor(at(8) / 3_600_000)) ? 36 : 70])) };
  const cold = incoming({ hourly: periods, grid: { ...chilly, thunder: {}, rain: {}, gust: {} }, now: at(0, 30) });
  assert.equal(cold.hazard, 'cold'); assert.equal(cold.peak.feels, 36); assert.equal(headline(cold, TZ), 'Cold to 36° expected around 10:00 PM');
  assert.deepEqual(campFor(cold, 'camping').slice(0, 2), ['Dry layers and a hat before you turn in', 'A pad or anything between you and the ground']);
  assert.match(headsUpAlert(festival, cold, TZ, at(0, 30), CAMP).headline, /^Dry the sleeping gear now, not later by \d+:\d\d PM\. The forecast has a night that feels like 36°\.$/);
  assert.equal(incoming({ hourly: periods, grid: { ...chilly, thunder: {}, rain: {}, gust: {} }, ground: { indoor: true }, now: at(0, 30) }), null, 'inside, the night is not cold');
  const withStorms = incoming({ hourly: periods, grid: chilly, now: at(0, 30) });
  assert.equal(withStorms.hazard, 'storms', 'storms first'); assert.deepEqual(withStorms.next, undefined, 'the storm window runs into the cold hours: one window, not two');
  assert.equal(alertHazard('Freeze Warning'), 'cold'); assert.equal(alertHazard('Cold Weather Advisory'), 'cold'); assert.equal(alertHazard('Winter Storm Warning'), 'rain');
  // Half an inch in an hour floods; so does a third of an inch an hour onto low ground; a quarter over three hours does not.
  const pour = { ...g, thunder: {}, gust: {}, rain: { ...g.rain, [Math.floor(at(4) / 3_600_000)]: 0.6 } };
  const flood = incoming({ hourly: periods, grid: pour, now: at(0, 30) });
  assert.equal(flood.hazard, 'flood'); assert.equal(headline(flood, TZ), 'Flash flooding possible around 6:00 PM', 'the hour of the half inch, named for what it is'); assert.equal(flood.peak.rateInHr, 0.6);
  assert.match(headsUpAlert(festival, flood, TZ, at(0, 30), CAMP).headline, /The forecast has 0\.6 in of rain an hour\./);
  const low = incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {}, rain: { ...g.rain, [Math.floor(at(4) / 3_600_000)]: 0.35 } }, ground: { low: true }, now: at(0, 30) });
  assert.equal(low.hazard, 'flood', 'low ground floods on less'); assert.equal(incoming({ hourly: periods, grid: { ...g, thunder: {}, gust: {} }, now: at(0, 30) }).hazard, 'rain', 'the fixture\'s rain is rain, not a flood');
  // Two stretches: storms at hour 3, then wind again at hour 10 after a calm hour. The first is the window; the second is named.
  const twice = { ...g, thunder: Object.fromEntries(Object.entries(g.thunder).map(([k, v]) => [k, k >= String(Math.floor(at(8) / 3_600_000)) ? 0 : v])), gust: { ...g.gust, [Math.floor(at(8) / 3_600_000)]: 10, [Math.floor(at(10) / 3_600_000)]: 45, [Math.floor(at(11) / 3_600_000)]: 45 }, rain: {} };
  const first = incoming({ hourly: periods, grid: twice, now: at(0, 30) });
  assert.equal(first.hazard, 'storms'); assert.equal(first.endsAt, new Date(at(8)).toISOString()); assert.deepEqual(first.next, { hazard: 'wind', startsAt: new Date(at(10)).toISOString() });
  // The sun over Live Oak on the fixture's day: up around 7:40 AM, down around 6:50 PM Eastern.
  const sun = sunTimes(30.404, -82.9395, at(0));
  assert.ok(sun.sunrise > Date.UTC(2026, 9, 23, 11, 25) && sun.sunrise < Date.UTC(2026, 9, 23, 11, 55), new Date(sun.sunrise).toISOString());
  assert.ok(sun.sunset > Date.UTC(2026, 9, 23, 22, 35) && sun.sunset < Date.UTC(2026, 9, 23, 23, 5), new Date(sun.sunset).toISOString());
  assert.equal(sunTimes(89, 0, Date.UTC(2026, 11, 21)).polar, 'night'); assert.equal(sunTimes(89, 0, Date.UTC(2026, 5, 21)).polar, 'day');
  const late = sunTimes(30.404, -82.9395, Date.UTC(2026, 9, 24, 6)), early = sunTimes(30.404, -82.9395, Date.UTC(2026, 9, 24, 11, 50));
  assert.ok(Date.UTC(2026, 9, 24, 6) < late.sunrise && late.sunrise < Date.UTC(2026, 9, 24, 11, 55), 'two in the morning is before that morning\'s sunrise: night');
  assert.ok(early.sunrise < Date.UTC(2026, 9, 24, 11, 50) && Date.UTC(2026, 9, 24, 11, 50) < early.sunset, 'ten to eight is after it: day');
  assert.equal(gustOdds(45, 10, 30), 'likely'); assert.equal(gustOdds(34, 10, 30), 'possible'); assert.equal(gustOdds(32, 31, 30), 'likely', 'sustained past the line'); assert.equal(gustOdds(25, 10, 30), null); assert.equal(gustOdds(null, 10, 30), null);
  assert.equal(dirWords(225), 'SW'); assert.equal(dirWords(0), 'N'); assert.equal(dirWords(359), 'N'); assert.equal(dirWords(-90), 'W'); assert.equal(dirWords(null), null);
  // Storms at 2 AM, three hours out: the list is done before anyone turns in; the same storms at 2 PM get the usual line.
  assert.equal(timing('storms', 180, 23), 'Secure camp before you turn in. Charge phones, fill water and know the way to shelter in the dark.');
  assert.equal(timing('storms', 180, 14), 'Secure camp now. Charge phones, fill water and pick your shelter.');
  assert.equal(timing('storms', 30, 23), 'Finish securing camp in the next few minutes. Head for shelter with fifteen to spare.', 'half an hour out, the hour does not matter');
  assert.equal(timing('rain', 150, 1), 'Finish the camp list before you turn in. The ground goes first.');
  assert.equal(timing('cold', 150), 'Dry the sleeping gear while there is light. Layers and a hat for the night.');
  assert.equal(prep('storms', 150, false, 23).timing, timing('storms', 150, 23));
});

test('the shared zone logic: which zones a point names, whether a polygon reaches the grounds, one message per warning, and a polygon worth keeping', () => {
  assert.deepEqual(zonesOf({ county: 'https://api.weather.gov/zones/county/FLC121', forecastZone: 'https://api.weather.gov/zones/forecast/FLZ024', fireWeatherZone: 'https://api.weather.gov/zones/fire/FLZ024' }), ['FLC121', 'FLZ024']);
  assert.deepEqual(zonesOf({}), []); assert.deepEqual(zonesOf(null), []);
  const box = { type: 'Polygon', coordinates: [[[-83.2, 30.2], [-82.7, 30.2], [-82.7, 30.5], [-83.2, 30.5], [-83.2, 30.2]]] };
  assert.equal(reaches(box, 30.404, -82.9395), true, 'the grounds inside the polygon'); assert.equal(reaches(box, 31, -82.9395), false, 'well outside');
  assert.equal(reaches(box, 30.513, -82.9395), true, 'a kilometer past the edge still counts: the square around the grounds reaches in');
  assert.equal(reaches(null, 30.4, -82.9), true, 'a zone-wide alert always does');
  const ft = (id, over = {}) => ({ properties: { id, event: 'Flood Advisory', sent: '2026-10-23T14:00:00-04:00', ends: '2026-10-23T18:00:00-04:00', ...over }, geometry: null });
  const list = [ft('a'), ft('b', { sent: '2026-10-23T15:00:00-04:00', references: [{ identifier: 'a' }] }), ft('c', { event: 'Heat Advisory', geocode: { UGC: ['FLZ099'] } }), ft('d', { event: 'Heat Advisory', geocode: { UGC: ['FLZ024'] } }), ft('e', { messageType: 'Cancel', event: 'Wind Advisory' })];
  assert.deepEqual(condense(list, ['FLZ024']).map(f => f.properties.id), ['b', 'd'], 'the update replaces its message, the other zone\'s segment and the cancel are out, one of each event and end stays');
  assert.equal(keepGeometry(box), box); assert.equal(keepGeometry({ type: 'Point', coordinates: [0, 0] }), null); assert.equal(keepGeometry(null), null);
  assert.equal(keepGeometry({ type: 'Polygon', coordinates: [Array.from({ length: 3000 }, (_, i) => [i / 100, i / 100])] }), null, 'a huge polygon stays with the service');
});
