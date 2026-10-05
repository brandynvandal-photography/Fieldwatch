// ==== shared: start ====
// Fieldwatch's weather logic, byte for byte the same in backend/src/incoming.js and web/index.html: the backend pushes
// from it, the phone draws from it, and backend/test/mirror.test.js fails when the two differ. Pure functions only:
// nothing from the page or the server, no imports.
const HOUR = 3600000;
// Lines the forecast has to cross: chance of thunder (%), gusts (mph), rain in the window (inches) with the chance of
// rain (%) standing in when the grid has no amount, hourly rain that counts as raining (inches), heat index (°F), what it feels
// like at or under which a night is cold (°F), and rain hard enough to flood: in an hour, or over three.
const THRESHOLDS = { thunder: 30, gustMph: 30, precip: 60, rainIn: 0.25, rainInHr: 0.02, heatF: 100, wbgtF: 85, coldF: 40, floodInHr: 0.5, floodIn3h: 1 };
// Gust lines by what is standing: inflatables come down at 20 mph, pop-up canopies fail around 30, stages and rigging hold to 40.
const WIND_LINES = { inflatables: 20, canopies: 30, stage: 40 };
const WIND_LABEL = { inflatables: 'inflatables line', canopies: 'canopy line', stage: 'stage hold line' };
/** The gust that matters here: the lowest line among what is standing (canopies, when nothing is known). */
const windLine = ground => Math.min(...((ground && Array.isArray(ground.structures) && ground.structures.length ? ground.structures : ['canopies']).map(s => WIND_LINES[s] || WIND_LINES.canopies)));
/** "the canopy line", "the inflatables and canopy lines". */
/** How sure the line is to be crossed: the sustained wind past it, or a gust well past it, is likely; a gust just over it is possible. */
const gustOdds = (gust, wind, line) => (gust == null ? null : (wind != null && wind >= line) || gust >= line + 10 ? 'likely' : gust >= line ? 'possible' : null);
/** A wind direction in degrees as the point it comes from: "SW". */
const dirWords = deg => (deg == null || !Number.isFinite(Number(deg)) ? null : ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round((((Number(deg) % 360) + 360) % 360) / 45) % 8]);
/** Sunrise and sunset (ms) on the day of t at a point, from the NOAA sunrise equation: within a few minutes, which is all a night glyph or a bedtime line needs. */
function sunTimes(lat, lon, t) {
  const rad = Math.PI / 180, ms = j => Math.round((j - 2440587.5) * 86400000), phi = lat * rad;
  const day = n => {
    const J = n - lon / 360;   // days since J2000 at this longitude's mean solar noon (longitude east positive)
    const M = ((357.5291 + 0.98560028 * J) % 360) * rad, C = 1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M);
    const lam = ((M / rad + C + 180 + 102.9372) % 360) * rad, transit = 2451545 + J + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * lam);
    const dec = Math.asin(Math.sin(lam) * Math.sin(23.4397 * rad));
    const cosw = (Math.sin(-0.833 * rad) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
    if (cosw >= 1) return { sunrise: null, sunset: null, polar: 'night', transit: ms(transit) };
    if (cosw <= -1) return { sunrise: null, sunset: null, polar: 'day', transit: ms(transit) };
    const w = Math.acos(cosw) / rad / 360;
    return { sunrise: ms(transit - w), sunset: ms(transit + w), transit: ms(transit) };
  };
  // The solar day whose noon is nearest t, so the same evening and the small hours after it share one sunset and one sunrise.
  let n = Math.ceil(t / 86400000 + 2440587.5 - 2451545 + 0.0008), d = day(n);
  if (t - d.transit > 43200000) d = day(n + 1); else if (d.transit - t > 43200000) d = day(n - 1);
  return { sunrise: d.sunrise, sunset: d.sunset, ...(d.polar ? { polar: d.polar } : {}) };
}
const lineWords = crossed => { const l = crossed.map(s => WIND_LABEL[s]).filter(Boolean); return !l.length ? '' : l.length === 1 ? `the ${l[0]}` : `the ${l.slice(0, -1).map(x => x.replace(/ line$/, '')).join(', ')} and ${l[l.length - 1].replace(/ line$/, ' lines')}`; };
const PRIORITY = ['tornado', 'storms', 'hail', 'wind', 'flood', 'rain', 'heat', 'cold'];
// Indoors (a club, a hall, an arena) the building is the shelter: only what can reach inside or the way in and out is a hazard.
const INDOOR_HAZARDS = ['tornado', 'storms', 'flood'];
const ALERT_HAZARD = [[/tornado/i, 'tornado'], [/thunderstorm|lightning/i, 'storms'], [/hail/i, 'hail'], [/wind|gale/i, 'wind'], [/flood/i, 'flood'], [/heat/i, 'heat'], [/freeze|frost|wind chill|cold/i, 'cold'], [/rain|storm/i, 'rain']];
const LABEL = { tornado: 'Tornado', storms: 'Storms', hail: 'Hail', wind: 'Strong wind', flood: 'Flooding', rain: 'Heavy rain', heat: 'Dangerous heat', cold: 'Cold night' };
const DURATION = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;
const hourKey = t => Math.floor(t / HOUR);
/** The hours an ISO interval with a duration covers, keyed by the hour, at most three days of them. */
function intervalHours(validTime) {
  const [start, dur] = String(validTime).split('/'), m = DURATION.exec(dur || 'PT1H') || [];
  const hours = Math.max(1, Number(m[1] || 0) * 24 + Number(m[2] || 0) + (Number(m[3] || 0) ? 1 : 0)), t0 = Date.parse(start), keys = [];
  if (!Number.isNaN(t0)) for (let h = 0; h < hours && h < 72; h++) keys.push(hourKey(t0 + h * HOUR));
  return keys;
}
/** A gridpoint series (an ISO interval with a duration, in metric) spread hour by hour: every hour of the interval holds its value. */
function spread(series, convert = v => v) {
  const out = {};
  for (const v of (series && series.values) || []) { if (v.value == null) continue; for (const k of intervalHours(v.validTime)) out[k] = convert(v.value); }
  return out;
}
/** An amount over an interval (rain, in mm) shared out to its hours, in inches: by each hour's chance of rain when the forecast has one for every hour, evenly otherwise. */
function allocate(series, hourly = []) {
  const chance = {};
  for (const h of hourly) { const t = Date.parse(h.startTime); if (Number.isFinite(t) && h.precipChance != null) chance[hourKey(t)] = Number(h.precipChance); }
  const out = {};
  for (const v of (series && series.values) || []) {
    if (v.value == null) continue;
    const keys = intervalHours(v.validTime), w = keys.map(k => chance[k]), sum = w.every(Number.isFinite) ? w.reduce((a, b) => a + b, 0) : 0;
    keys.forEach((k, i) => { out[k] = (out[k] || 0) + (v.value / 25.4) * (sum > 0 ? w[i] / sum : 1 / keys.length); });
  }
  return out;
}
const cToF = c => c * 9 / 5 + 32, kmhToMph = k => k / 1.609;
/** The grid's hour-by-hour numbers the model reads: heat index (°F), gusts (mph), chance of thunder (%), rain (inches in the hour), what the heat estimate needs, where the wind comes from (degrees) and what it feels like (°F). */
const spreadGrid = (g, hourly = []) => ({ heat: spread(g?.heatIndex, cToF), gust: spread(g?.windGust, kmhToMph), thunder: spread(g?.probabilityOfThunder), rain: allocate(g?.quantitativePrecipitation, hourly),
  temp: spread(g?.temperature, cToF), rh: spread(g?.relativeHumidity), wind: spread(g?.windSpeed, kmhToMph), sky: spread(g?.skyCover), dir: spread(g?.windDirection), feels: spread(g?.apparentTemperature, cToF) });
// Heat by exertion: the heat index is a shade number for someone at rest. An estimated wet-bulb globe temperature (Stull's wet
// bulb, a globe warmed by the sun less cloud and wind, the standard 0.7/0.2/0.1 blend) is what work-rest guidance uses, and it
// earns a flag. Red or black is a heat hazard on its own, whatever the heat index says.
const HEAT_FLAGS = [['black', 88, 'Black flag: stop heavy work. Work 20, rest 40 in shade. Water every 15 minutes.'], ['red', 85, 'Red flag: work 30, rest 30 in shade. Water every 15 minutes.'],
  ['yellow', 82, 'Yellow flag: work 40, rest 20. Water every 20 minutes.'], ['green', 0, 'Green flag: work 50, rest 10. Water every 20 minutes.']];
function wbgtF(tempF, rh, windMph = 0, sky = 0) {
  if (tempF == null || rh == null) return null;
  const t = (tempF - 32) * 5 / 9, h = Math.max(1, Math.min(100, rh));
  const tw = t * Math.atan(0.151977 * Math.sqrt(h + 8.313659)) + Math.atan(t + h) - Math.atan(h - 1.676331) + 0.00391838 * Math.pow(h, 1.5) * Math.atan(0.023101 * h) - 4.686035;
  const tg = t + 12 * (1 - Math.max(0, Math.min(100, sky || 0)) / 100) - Math.min(5, 0.4 * (windMph || 0));
  return Math.round((0.7 * tw + 0.2 * tg + 0.1 * t) * 9 / 5 * 10) / 10 + 32;
}
const heatFlag = w => w == null ? null : HEAT_FLAGS.find(([, at]) => w >= at)[0];
const flagText = flag => (HEAT_FLAGS.find(([f]) => f === flag) || [])[2] || '';
const alertHazard = event => (ALERT_HAZARD.find(([re]) => re.test(event || '')) || [null, null])[1];
/**
 * What is coming: { hazard, startsAt, endsAt, minutes, source: 'forecast' | 'alert', event?, peak } or null. The forecast window
 * is the first run of hours over a line; rain counts by amount when the grid has one (a run must add up to rainIn), by chance
 * when it does not. A watch or warning with an onset still ahead wins when it comes first.
 */
function incoming({ hourly = [], grid = {}, alerts = [], ground = {}, nowcast = null, now = Date.now(), hours = 12 } = {}) {
  const end = now + hours * HOUR, gustLine = windLine(ground), standing = ground && Array.isArray(ground.structures) && ground.structures.length ? ground.structures : ['canopies'];
  const indoor = Boolean(ground && ground.indoor === true);
  const marks = hourly.map(h => ({ t: Date.parse(h.startTime), h })).filter(x => Number.isFinite(x.t) && x.t + HOUR > now && x.t < end).sort((a, b) => a.t - b.t)
    .map(({ t, h }) => {
      const k = hourKey(t), thunder = grid.thunder?.[k] ?? null, gust = grid.gust?.[k] ?? null, heat = grid.heat?.[k] ?? null, precip = h.precipChance ?? null, rain = grid.rain?.[k] ?? null;
      const wind = grid.wind?.[k] ?? null, dir = grid.dir?.[k] ?? null, feels = grid.feels?.[k] ?? null;
      const wbgt = wbgtF(grid.temp?.[k] ?? null, grid.rh?.[k] ?? null, wind ?? 0, grid.sky?.[k] ?? 0);
      const hazards = [];
      if (thunder >= THRESHOLDS.thunder) hazards.push('storms');
      if (!indoor && gust >= gustLine) hazards.push('wind');
      if (!indoor && (heat >= THRESHOLDS.heatF || wbgt >= THRESHOLDS.wbgtF)) hazards.push('heat');
      if (!indoor && feels != null && feels <= THRESHOLDS.coldF) hazards.push('cold');   // a wet tent on a cold night is how people get hurt
      return { t, hazards, thunder, gust, heat, wbgt, precip, rain, wind, dir, feels, wet: rain != null ? rain >= THRESHOLDS.rainInHr : precip >= THRESHOLDS.precip };
    });
  // A run of wet hours is rain when it adds up: a drizzle that never reaches rainIn is not worth a heads-up.
  for (let i = 0; !indoor && i < marks.length; i++) {
    if (!marks[i].wet) continue;
    let j = i; while (j + 1 < marks.length && marks[j + 1].wet && marks[j + 1].t - marks[j].t <= HOUR) j++;
    const run = marks.slice(i, j + 1), known = run.some(m => m.rain != null), total = run.reduce((s, m) => s + (m.rain || 0), 0);
    if (!known || total >= THRESHOLDS.rainIn) for (const m of run) m.hazards.push('rain');
    i = j;
  }
  // Rain hard enough to flood: half an inch in an hour, an inch over three, or a third of an inch an hour onto low ground.
  for (let i = 0; !indoor && i < marks.length; i++) {
    const r = marks[i].rain; if (r == null) continue;
    const three = r + ((marks[i - 1] && marks[i - 1].rain) || 0) + ((marks[i - 2] && marks[i - 2].rain) || 0);
    if (r >= THRESHOLDS.floodInHr || three >= THRESHOLDS.floodIn3h || (ground && ground.low && r >= 0.3)) marks[i].hazards.push('flood');
  }
  let forecast = null;
  const i = marks.findIndex(m => m.hazards.length);
  if (i >= 0) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1].hazards.length && marks[j + 1].t - marks[j].t <= HOUR) j++;
    const win = marks.slice(i, j + 1), all = new Set(win.flatMap(m => m.hazards));
    const peakOf = key => win.reduce((b, m) => (m[key] != null && (b == null || m[key] > b) ? m[key] : b), null);
    const lowOf = key => win.reduce((b, m) => (m[key] != null && (b == null || m[key] < b) ? m[key] : b), null);
    const gustHour = win.reduce((b, m) => (m.gust != null && (!b || m.gust > b.gust) ? m : b), null);
    const rainIn = win.some(m => m.rain != null) ? Math.round(win.reduce((s, m) => s + (m.rain || 0), 0) * 100) / 100 : null;
    forecast = { hazard: PRIORITY.find(p => all.has(p)), startsAt: new Date(Math.max(now, marks[i].t)).toISOString(), endsAt: new Date(marks[j].t + HOUR).toISOString(),
      source: 'forecast', peak: { thunder: peakOf('thunder'), gust: peakOf('gust'), precip: peakOf('precip'), heat: peakOf('heat'), wbgt: peakOf('wbgt'), rainIn, rateInHr: rainIn == null ? null : Math.round((peakOf('rain') || 0) * 100) / 100,
        wind: peakOf('wind'), dir: gustHour ? dirWords(gustHour.dir) : null, feels: lowOf('feels') == null ? null : Math.round(lowOf('feels')) } };
    if (forecast.peak.wbgt != null) forecast.flag = heatFlag(forecast.peak.wbgt);
    if (rainIn != null && (all.has('rain') || all.has('flood'))) forecast.mud = mudTier(ground, rainIn, forecast.peak.rateInHr);
    if (forecast.peak.gust != null) forecast.wind = { line: gustLine, crossed: standing.filter(s => forecast.peak.gust >= (WIND_LINES[s] || WIND_LINES.canopies)), odds: gustOdds(forecast.peak.gust, forecast.peak.wind, gustLine) };
    // A second stretch later in the twelve hours is said too, so nobody packs up after the first.
    let k = j + 1; while (k < marks.length && !marks[k].hazards.length) k++;
    if (k < marks.length) forecast.next = { hazard: PRIORITY.find(p => marks[k].hazards.includes(p)), startsAt: new Date(marks[k].t).toISOString() };
  }
  // A warning already in effect for the hazard is on the sky and says it all: no heads-up for the same thing.
  const warned = new Set(alerts.filter(a => a.channel !== 'headsup' && /warning$/i.test(a.event || '') && Date.parse(a.onset || a.issuedAt || '') <= now && (!a.expiresAt || Date.parse(a.expiresAt) > now)).map(a => alertHazard(a.event)).filter(Boolean));
  if (forecast && warned.has(forecast.hazard)) forecast = null;
  let watch = null;
  for (const a of alerts) {
    const onset = Date.parse(a.onset || ''), hz = alertHazard(a.event);
    if (!hz || (indoor && !INDOOR_HAZARDS.includes(hz)) || !Number.isFinite(onset) || onset <= now || onset >= end || a.channel === 'headsup') continue;
    if (!watch || onset < Date.parse(watch.startsAt)) watch = { hazard: hz, startsAt: new Date(onset).toISOString(), endsAt: a.expiresAt || null, source: 'alert', event: a.event, peak: {} };
  }
  // Rain already on the radar inside two hours moves a window's start earlier, or is a window of its own when the forecast has none.
  const radar = !indoor && nowcast && nowcast.minutes != null && nowcast.minutes <= 120 ? { hazard: 'rain', startsAt: new Date(now + nowcast.minutes * 60000).toISOString(), endsAt: new Date(now + (nowcast.minutes + 120) * 60000).toISOString(), source: 'radar', peak: {}, nowcast } : null;
  if (radar && forecast) { if (Date.parse(radar.startsAt) < Date.parse(forecast.startsAt)) forecast.startsAt = radar.startsAt; forecast.nowcast = nowcast; }
  const soon = forecast || radar;
  const pick = watch && (!soon || Date.parse(watch.startsAt) <= Date.parse(soon.startsAt)) ? watch : soon;
  return pick ? { ...pick, minutes: Math.max(0, Math.round((Date.parse(pick.startsAt) - now) / 60000)), ...(indoor ? { indoor: true } : {}) } : null;
}
/** Rain in a sentence: "0.6 in of rain" when the grid says how much, "a 70% chance of rain" when it only says how likely. */
const rainWords = p => p.rainIn != null ? `${p.rainIn < 0.1 ? 'under 0.1' : p.rainIn.toFixed(1)} in of rain` : p.precip != null ? `a ${Math.round(p.precip)}% chance of rain` : '';
// Mud: inches of rain before trampled grass on this soil goes soft (USDA hydrologic group A drains fast, D is clay), and how
// the surface changes that. Sand and blacktop never make mud; they puddle, run off or turn slick instead.
const MUD_IN = { A: 1.5, B: 0.75, C: 0.5, D: 0.3 };
const SURFACE_X = { grass: 1, dirt: 0.6, gravel: 2.5, mixed: 1.2 };
const TIER = {
  wet:    { label: 'Rain', line: 'Wet but not muddy', camping: ['Rain shell and a tarp over the tent', 'Bins and bags off the floor', 'Seal a dry set of clothes in a bag'], day: ['Rain shell and a bag for the phone', 'Boots if you have them'] },
  soft:   { label: 'Mud', line: 'Paths will be soft and muddy', camping: ['Move the car to hard ground while it still can. A stuck car waits for the ground to dry', 'Bins and bags off the floor', 'Boots and a dry route to the stages', 'Tarp over the tent rather than under it'],
            day: ['Boots and a rain shell', 'Leave before it starts or wait it out', 'Keep the phone and cash dry', 'Plan the walk around the low end'] },
  deep:   { label: 'Deep mud', line: 'Fields will not hold vehicles', camping: ['Whatever must leave goes before it starts', 'Staying means waiting for the ground to dry', 'Tarp the tent floor and bin the gear', 'Expect fields closed to vehicles after'],
            day: ['Leave before it starts if you need to be anywhere', 'Staying means waiting it out', 'Boots for the walk out', 'Keep the phone and cash dry'] },
  water:  { label: 'Standing water', line: 'Low ground will flood', camping: ['Move the tent off low ground', 'Bins and bags off the floor', 'Know the route to high ground', 'Move the car off low ground while it can'], day: ['Know the route to high ground', 'Keep off the low end', 'Keep the phone and cash dry'] },
  slick:  { label: 'Rain', line: 'Slick ground and puddles', camping: ['Keep gear off the ground', 'Rain shell', 'Watch your footing on painted lines and metal plates'], day: ['Rain shell and a bag for the phone', 'Watch your footing on painted lines and metal plates'] },
  runoff: { label: 'Heavy rain', line: 'Runoff into the low end', camping: ['Keep gear off the ground', 'Weigh down anything light', 'Plan the walk around the low end', 'Stay out of underpasses and drains'], day: ['Plan the walk around the low end', 'Stay out of underpasses and drains', 'Keep the phone and cash dry'] },
};
/** What this rain does to this ground: { tier, effective, threshold, past }. Effective rain is what is ahead plus a share of what already fell. */
function mudTier(ground = {}, aheadIn = 0, rateInHr = 0) {
  const surface = ground.surface || 'grass', soil = ground.soil || 'B', low = Boolean(ground.low), p = ground.past || {};
  const past = Math.round(((p.in24 || 0) * 0.6 + Math.max(0, (p.in48 || 0) - (p.in24 || 0)) * 0.3) * 100) / 100, effective = Math.round((aheadIn + past) * 100) / 100;
  if (surface === 'pavement') return { tier: rateInHr >= 0.3 || aheadIn >= 1 ? 'runoff' : aheadIn >= 0.1 ? 'slick' : 'wet', effective, threshold: null, past };
  if (surface === 'sand') return { tier: low && aheadIn >= 1 ? 'water' : 'wet', effective, threshold: null, past };
  // What this ground actually did in the rain (reports from the field, ground.js) beats the soil table.
  const learned = ground.learned && ground.learned.threshold > 0 ? ground.learned.threshold : null;
  const threshold = learned || Math.round((MUD_IN[soil] || MUD_IN.B) * (SURFACE_X[surface] || 1) * 100) / 100;
  const tier = low && (aheadIn >= 1 || rateInHr >= 0.5) ? 'water' : effective >= 2 * threshold ? 'deep' : effective >= threshold ? 'soft' : 'wet';
  return { tier, effective, threshold, past, learned: Boolean(learned) };
}
/** The ground in a few words: "grass over clay, low ground". */
function groundWords(ground = {}) {
  const s = { grass: 'grass', dirt: 'bare dirt', sand: 'sand', gravel: 'gravel', pavement: 'blacktop', mixed: 'mixed ground' }[ground.surface] || 'grass';
  const soil = ground.surface === 'pavement' || ground.surface === 'sand' ? '' : { A: ' over sand', B: '', C: ' over soil that drains slowly', D: ' over clay' }[ground.soil] || '';
  return `${s}${soil}${ground.low ? ', low ground' : ''}`;
}
// How long each task takes, so a start-by time can be worked back from the arrival. Anything not listed takes ten minutes.
const TASK_MIN = [['Leave before it starts if', 90], ['Whatever must leave', 90], ['Park a vehicle on the', 20], ['Dry the sleeping gear', 20], ['A pad or anything', 10], ['Dry layers', 5], ['A warm layer', 5], ['Warm layers', 5], ['Keep the car', 0], ['Rotate anyone', 0], ['A warm place', 0], ['Move the car to hard ground', 60], ['Move the tent', 45], ['Move the car off low ground', 30], ['Deflate and tie down', 30], ['Clear the stage deck', 20],
  ['Park a vehicle upwind', 20], ['Guy lines and sandbags', 20], ['A tarp over the tent', 20], ['A shade cloth', 20], ['Tarp the tent floor', 20], ['Stock under a tarp', 20], ['Pack what you can carry', 20], ['Stake every loop', 15], ['Tarp over the tent', 15],
  ['Secure stock', 15], ['Close the booth', 15], ['Drop vendor canopies', 10], ['Find shade', 10], ['Drop pop-up canopies', 5], ['Seal a dry set', 5], ['Leave the camp', 5], ['Get to the shelter', 5], ['Know where the shelter is', 5],
  ['Bag the phone', 5], ['Rain shell and a bag', 5], ['Boots', 5], ['Tie down or bag', 5], ['Get under a solid roof', 5], ['Keep the phone and cash dry', 5],
  ['Staying means', 0], ['Leave before it starts or', 0], ['Head for a building', 0], ['Head down', 0], ['Freeze water bottles', 0], ['Rest between', 0], ['Rest before', 0], ['Check on', 0], ['Expect fields', 0], ['Know the route', 0], ['Know the way', 0],
  ['Rain shell', 0], ['Plan the walk', 0], ['Stay out of', 0], ['Stay clear', 0], ['Watch your footing', 0], ['Leave the car', 0], ['Water every', 0], ['Rotate the crew', 0], ['Keep out from under', 0], ['Keep off the low end', 0], ['Not the car', 0]];
const taskMinutes = t => (TASK_MIN.find(([k]) => t.startsWith(k)) || [null, 10])[1];
/**
 * The list for what is coming and for who is asking: someone camping, a day visitor in a lot with no in and out, or crew and
 * vendors with things standing. The mud tier's leave-or-stay call comes first when the ground calls for it; a stage or
 * inflatables past their line are crew's to deal with.
 */
function campFor(inc, setup = 'day') {
  if (inc.indoor) return ((PREP[inc.hazard] || PREP.storms).indoor || PREP.storms.indoor).slice();   // inside, the list is the same for everyone
  const s = setup === 'camping' || setup === 'crew' ? setup : 'day', tierList = t => TIER[t][s === 'day' ? 'day' : 'camping'];
  const list = inc.hazard === 'rain' && inc.mud ? tierList(inc.mud.tier) : (PREP[inc.hazard] || PREP.storms)[s];
  const dir = inc.peak && inc.peak.dir, own = dir ? list.map(t => (t === 'Park a vehicle upwind as a windbreak' ? `Park a vehicle on the ${dir} side as a windbreak` : t)) : list;   // the wind's side, when the forecast says which
  const ground = inc.hazard !== 'rain' && inc.mud && ['soft', 'deep', 'water'].includes(inc.mud.tier) ? tierList(inc.mud.tier).filter(t => /^(Whatever must leave|Move the car|Leave before it starts|Move the tent off)/.test(t)) : [];
  const crossed = (inc.wind && inc.wind.crossed) || [], standing = [];
  if (s === 'crew' && crossed.includes('stage')) standing.push('Clear the stage deck and drop the scrim and banners');
  if (s === 'crew' && crossed.includes('inflatables')) standing.push('Deflate and tie down the inflatables');
  return [...standing, ...ground, ...own.filter(t => !ground.includes(t))];
}
/** Each task with when to start it: the arrival less how long it takes less ten minutes, earliest start first. Late means it should have started already. */
function deadlines(startsAt, tasks, now = Date.now()) {
  const t0 = Date.parse(startsAt);
  return tasks.map(t => { const m = taskMinutes(t), by = t0 - (m + 10) * 60000; return { task: t, minutes: m, startBy: new Date(Math.max(now, by)).toISOString(), late: by <= now }; })
    .sort((a, b) => Date.parse(a.startBy) - Date.parse(b.startBy) || b.minutes - a.minutes);
}
// Where to shelter; what to do before it comes for someone camping, for a day visitor in a lot with no in and out, and for crew
// and vendors with things standing; what it is like while it is here, and after. The push says the first two, shorter.
const PREP = {
  storms:  { label: 'Storms', shelter: 'Shelter is a hard-topped vehicle or a building with wiring and plumbing. Tents, canopies and stages are not shelter.',
             indoorShelter: 'Inside is shelter. The line and the lot outside are not. A car is.', indoor: ['Stay inside until it passes', 'Keep the line and the lot clear while it is overhead', 'Charge the phone'],
             camping: ['Drop pop-up canopies and flags', 'Stake every loop, tie guy lines, weigh the legs', 'Unplug and bag electronics', 'Move poles and chairs away from where people sit'],
             day: ['Know where the shelter is and how long the walk takes', 'Charge the phone, fill water', 'Bag the phone and anything that must stay dry', 'Head for a building or the car. Not a tree or a pop-up'],
             crew: ['Drop vendor canopies and banners. Weigh the legs', 'Unplug and bag electronics', 'Secure stock, signage and anything that flies', 'Know where the shelter is and how long the walk takes'],
             during: 'Stay in shelter until it passes. Do not go back for anything.', after: 'Wait thirty minutes after the last thunder before going back out. Lightning reaches ten miles ahead of the rain.' },
  wind:    { label: 'Strong wind', shelter: 'Get into a vehicle or a building if it turns dangerous. Stay clear of stages, towers and anything tall that is tied down.',
             camping: ['Drop pop-up canopies now', 'Guy lines and sandbags or water jugs on every leg', 'Take down banners and flags', 'Close and weigh coolers and bins', 'Park a vehicle upwind as a windbreak'],
             day: ['Stay clear of stages, towers and banners', 'Tie down or bag hats and light things', 'Know where the shelter is'],
             crew: ['Drop vendor canopies now', 'Take down banners and flags', 'Close and weigh coolers, bins and stock', 'Stay clear of stages and towers'],
             during: 'Stay away from tents, stages and trees until the gusts ease.', after: 'Check every stake and line before you trust the tent again.' },
  rain:    { label: 'Heavy rain', shelter: 'A vehicle or a building keeps you dry. A tent on high ground is fine while there is no thunder.',
             camping: ['Move the tent off low ground', 'Bins and bags off the floor', 'Tarp over the tent rather than under it', 'Seal a dry set of clothes in a bag'],
             day: ['Rain shell and a bag for the phone', 'Boots if you have them', 'Know the way to cover'],
             crew: ['Stock under a tarp and off the floor', 'Unplug and bag electronics', 'Rain shell and boots'],
             during: 'Stay dry and off low ground. Watch the paths for standing water.', after: 'Dry the sleeping gear first. Wet nights are how people get cold.' },
  flood:   { label: 'Flooding', shelter: 'Move to high ground away from creeks and low fields. Never drive or walk through moving water.',
             indoorShelter: 'Upstairs is shelter from water. Never drive or walk through moving water.', indoor: ['Know the way to high ground', 'Keep off the low end and out of underpasses', 'Pack what you can carry'],
             camping: ['Pack what you can carry', 'Know the route to high ground', 'Leave the car if water is rising around it'],
             day: ['Know the route to high ground', 'Pack what you can carry', 'Leave the car if water is rising around it'],
             crew: ['Close the booth and get to high ground', 'Know the route to high ground', 'Leave the car if water is rising around it'],
             during: 'Stay on high ground. Water rises faster than it looks.', after: 'Stay off flooded paths until staff open them. The water hides what it took.' },
  cold:    { label: 'Cold night', shelter: 'A vehicle or a building with heat. A dry tent with a pad under you holds warmth; a wet one does not.',
             camping: ['Dry layers and a hat before you turn in', 'A pad or anything between you and the ground', 'Dry the sleeping gear now, not later', 'Check on neighbors in thin tents'],
             day: ['A warm layer and a hat for after dark', 'Keep the car as a warm place to sit', 'Check on the people around you'],
             crew: ['Warm layers for the night shift', 'Rotate anyone standing still', 'A warm place to sit for breaks'],
             during: 'Stay dry. Wet and cold together is how people get hurt.', after: 'Dry everything that got damp before the next night.' },
  heat:    { label: 'Dangerous heat', shelter: 'Water every twenty minutes and shade at midday. Medical tent at the first sign of confusion or no sweat.',
             camping: ['A tarp over the tent for shade', 'Freeze water bottles overnight', 'Rest between noon and four', 'Check on neighbors'],
             day: ['Water every twenty minutes', 'Find shade for the afternoon', 'Rest before it peaks', 'Check on the people around you'],
             crew: ['Water every fifteen minutes', 'A shade cloth over the booth', 'Rotate the crew by the flag', 'Check on each other'],
             during: 'Shade, water, rest. Watch each other for confusion, cramps or dry skin.', after: 'Keep drinking after sundown. The heat you took in stays with you.' },
  hail:    { label: 'Hail', shelter: 'Get under a solid roof or into a vehicle. Tents, canopies and stages are not shelter.',
             camping: ['Lay canopies flat', 'Cover windshields with mats or blankets', 'Get under a solid roof'],
             day: ['Get under a solid roof or into the car', 'Keep out from under trees'],
             crew: ['Lay canopies flat', 'Cover windshields with mats or blankets', 'Get under a solid roof'],
             during: 'Stay under the roof until it stops.', after: 'Check the tent and the car for damage before the next rain.' },
  tornado: { label: 'Tornado', shelter: 'Get to the shelter the festival named or the lowest floor of a solid building. Vehicles and tents are not safe from a tornado.',
             camping: ['Leave the camp', 'Get to the shelter the festival named', 'Head down and covered'],
             day: ['Get to the shelter the festival named', 'Not the car or a tent', 'Head down and covered'],
             crew: ['Get to the shelter the festival named', 'Not the car or a tent', 'Head down and covered'],
             during: 'Stay down in the shelter until the warning ends.', after: 'Watch for downed lines and broken glass on the way back.' },
};
/** Where to shelter for a hazard: the building itself when the event is indoors. */
const shelterFor = (hazard, indoor) => { const P = PREP[hazard] || PREP.storms; return indoor && P.indoorShelter ? P.indoorShelter : P.shelter; };
const SHELTER_PACK = ['Phone and a battery pack', 'Water and a snack', 'Rain shell and a warm layer', 'ID, cash, keys, medication', 'A light'];
/** What to do with the time there is, the same line the push carries; with the local hour it starts, a window that comes while people sleep is readied before anyone turns in. */
function timing(hazard, m, hour) {
  const night = hour != null && m > 60 && (hour >= 22 || hour < 5);
  if (hazard === 'cold') return m <= 60 ? 'Dry layers on and something under you before it gets cold.' : 'Dry the sleeping gear while there is light. Layers and a hat for the night.';
  if (hazard === 'rain') return night ? 'Finish the camp list before you turn in. The ground goes first.' : m <= 20 ? 'Get the last things under cover and stay dry.' : m <= 60 ? 'Finish the camp list now. The ground goes first.' : m <= 180 ? 'Work the list in order. The car goes first if it must move.' : 'Secure what you would hate to lose. Check back in an hour.';
  if (hazard === 'heat') return m <= 20 ? 'Get into shade now and drink.' : m <= 60 ? 'Find your shade for the afternoon and fill every bottle.' : m <= 180 ? 'Fill water and find shade. Rest before it peaks.' : 'Freeze bottles and plan the afternoon in shade. Check back in an hour.';
  if (night) return 'Secure camp before you turn in. Charge phones, fill water and know the way to shelter in the dark.';
  return m <= 20 ? 'Go to shelter now and leave the gear.' : m <= 60 ? 'Finish securing camp in the next few minutes. Head for shelter with fifteen to spare.'
    : m <= 180 ? 'Secure camp now. Charge phones, fill water and pick your shelter.' : 'Secure what you would hate to lose. Check back in an hour.';
}
// One line to act on and one line of what not to do, for every alert: a person in a panic reads the first line and nothing
// else, so the push opens with it and so does the alert screen. An imperative under eight words, then what not to do.
const ACTION = {
  tornado: { warn: ['Get to the shelter now', 'Lowest floor of a solid building. Not a tent or a car.'], watch: ['Know where the shelter is', 'Keep the phone on and charged.'] },
  storms:  { warn: ['Get into a vehicle or building', 'Not a tent, canopy or stage.'], watch: ['Know your shelter', 'A hard-topped vehicle or a building. Not a tent.'] },
  hail:    { warn: ['Get under a solid roof', 'Not a tent or canopy.'], watch: ['Know your shelter', 'Lay canopies flat before it comes.'] },
  wind:    { warn: ['Stay clear of tents and stages', 'Get into a vehicle or building if it turns dangerous.'], watch: ['Tie everything down', 'Drop pop-up canopies.'] },
  flood:   { warn: ['Move to high ground now', 'Never walk or drive through moving water.'], watch: ['Know the route to high ground', 'Move the tent off low ground.'] },
  heat:    { warn: ['Shade and water now', 'Medical tent at confusion or no sweat.'], watch: ['Water every twenty minutes', 'Shade at midday. Check on neighbors.'] },
  rain:    { warn: ['Get dry and off low ground', 'A vehicle or a building keeps you dry.'], watch: ['Move the tent off low ground', 'Bins and bags off the floor.'] },
  cold:    { warn: ['Get warm and dry now', 'A vehicle or a building with heat. Not a wet tent.'], watch: ['Dry layers before you turn in', 'Something between you and the ground.'] },
};
/** [do, and] for an alert: the protocol's line for a lightning code, the timing line and the first task of this setup's own list for a heads-up, the hazard's for a warning or a watch; null when the event names no hazard. */
function actionLines(a, opts) {
  const o = opts || {}, warn = a.severity === 'severe' || a.severity === 'extreme';
  if (a.channel === 'lightning') return a.code === 'red' || warn ? ['Shelter now', 'Full work stoppage. Not a tent, canopy or stage.'] : ['Head for shelter', 'Evacuation procedures. Staff hold posts.'];
  if (a.channel === 'headsup') {
    const hz = a.hazard || alertHazard(a.event) || 'storms', m = a.onset ? Math.max(0, Math.round((Date.parse(a.onset) - (o.now || Date.now())) / 60000)) : 999;
    const first = campFor({ hazard: hz, indoor: Boolean(o.indoor) }, o.setup || 'day')[0];
    return [timing(hz, m, o.hour == null ? null : o.hour).replace(/\.$/, ''), first ? `${first}.` : ''];
  }
  const hz = alertHazard(a.event); if (!hz) return null;
  return ACTION[hz][warn || /warning/i.test(a.event || '') ? 'warn' : 'watch'];
}
// ==== shared: end ====

// ---- backend only: the wording of a push, in the festival's own clock ----
export { THRESHOLDS, WIND_LINES, HEAT_FLAGS, LABEL, PREP, TIER, SHELTER_PACK, hourKey, spread, allocate, spreadGrid, cToF, kmhToMph, alertHazard, incoming, rainWords, mudTier, groundWords, windLine, lineWords, wbgtF, heatFlag, flagText, campFor, deadlines, taskMinutes, timing, ACTION, actionLines, gustOdds, dirWords, sunTimes };
const cap = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
/** The hour of the day (0 to 23) at a place, for the bedtime line. */
export const localHour = (t, tz) => { try { return Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: tz || 'UTC' }).format(new Date(t))); } catch { return new Date(t).getUTCHours(); } };
export const clock = (t, tz) => { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(11, 16) + 'Z'; } };
/** One line for a notification: what, and when. */
export function headline(inc, tz) {
  const at = inc.minutes <= 0 ? 'now' : `around ${clock(inc.startsAt, tz)}`;
  if (inc.source === 'alert') return `${inc.event} ${inc.minutes <= 0 ? 'in effect now' : `begins ${clock(inc.startsAt, tz)}`}`;
  if (inc.source === 'radar') return `Rain on the radar${inc.minutes <= 0 ? ' now' : ` about ${inc.minutes} min out`}`;
  if (inc.hazard === 'wind') return `Gusts to ${Math.round(inc.peak.gust)} mph${inc.peak.dir ? ` from the ${inc.peak.dir}` : ''}${inc.wind && inc.wind.crossed.length ? (inc.wind.odds === 'possible' ? `, maybe past ${lineWords(inc.wind.crossed)},` : ` past ${lineWords(inc.wind.crossed)}`) : ''} expected ${at}`;
  if (inc.hazard === 'cold') return `Cold to ${Math.round(inc.peak.feels)}° expected ${at}`;
  if (inc.hazard === 'flood') return `Flash flooding possible ${at}`;
  if (inc.hazard === 'heat') return inc.flag === 'red' || inc.flag === 'black' ? `${cap(inc.flag)} flag heat expected ${at}` : `Heat index near ${Math.round(inc.peak.heat)}° expected ${at}`;
  if (inc.hazard === 'rain' && inc.mud) return `${TIER[inc.mud.tier].label} expected ${at}`;
  return `${LABEL[inc.hazard] || 'Weather'} expected ${at}`;
}
/** Where to shelter, the camp list and the timing line for a hazard, from the shared tables. */
export function prep(hazard, minutes, indoor = false, hour = null) {
  const P = PREP[hazard] || PREP.storms;
  return { shelter: shelterFor(hazard, indoor), camp: indoor ? (P.indoor || PREP.storms.indoor) : P.camping, timing: timing(hazard, minutes, hour) };
}
/** What this rain does to this ground, in a sentence: "Paths will be soft and muddy: 0.8 in of rain on grass over clay after 1.1 in already down." */
export function mudWords(inc, ground = {}) {
  const m = inc.mud; if (!m) return '';
  return `${TIER[m.tier].line}: ${rainWords(inc.peak || {})} on ${groundWords(ground)}${m.past >= 0.1 ? ` after ${m.past.toFixed(1)} in already down` : ''}.`;
}
/** A task and its start-by time, in the festival's own clock: "Move the car to hard ground by 4:45 PM", or "now" once that has passed. */
const taskLine = (d, tz) => `${d.task} ${d.late ? 'now' : `by ${clock(d.startBy, tz)}`}`;
/** The heads-up as an alert: pushed like a warning, listed with the alerts, and gone when the weather is. */
export function headsUpAlert(festival, inc, tz, now = Date.now(), ground = {}) {
  const p = prep(inc.hazard, inc.minutes, inc.indoor, localHour(inc.startsAt, tz)), head = headline(inc, tz), pk = inc.peak || {};
  // The list for the festival's default: campers where people camp, day visitors where they do not or nobody knows. The app redoes it per person.
  const setup = ground.camping === true ? 'camping' : 'day';
  const plan = deadlines(inc.startsAt, campFor(inc, setup), now), first = plan[0] ? `${taskLine(plan[0], tz)}.` : '';
  const mud = inc.mud && inc.mud.tier !== 'wet' ? mudWords(inc, ground) : '';
  // What the forecast says, as a sentence: "The forecast has a 60% chance of thunder, gusts to 45 mph and 0.6 in of rain." The mud sentence carries the rain when there is one.
  const raining = pk.rainIn != null ? pk.rainIn >= THRESHOLDS.rainIn : pk.precip >= THRESHOLDS.precip;
  const crossed = (inc.wind && inc.wind.crossed) || [];
  const nc = inc.nowcast && inc.nowcast.minutes != null ? `On the radar${inc.nowcast.heading ? ` moving ${inc.nowcast.heading} at ${Math.round((inc.nowcast.speedKmh || 0) / 1.609)} mph` : ''}.` : '';
  const dirW = inc.hazard === 'wind' && pk.dir ? ` from the ${pk.dir}` : '', maybe = inc.wind && inc.wind.odds === 'possible';
  const bits = inc.source === 'alert' ? [] : [inc.hazard === 'storms' && pk.thunder != null ? `a ${Math.round(pk.thunder)}% chance of thunder` : '',
    crossed.length ? `gusts to ${Math.round(pk.gust)} mph${dirW}${maybe ? ', maybe past ' : ' past '}${lineWords(crossed)}` : pk.gust >= THRESHOLDS.gustMph ? `gusts to ${Math.round(pk.gust)} mph${dirW}` : '',
    inc.hazard === 'flood' && pk.rateInHr ? `${pk.rateInHr.toFixed(1)} in of rain an hour` : raining && !mud ? rainWords(pk) : '', inc.hazard === 'cold' && pk.feels != null ? `a night that feels like ${Math.round(pk.feels)}°` : '',
    pk.heat >= THRESHOLDS.heatF ? `a heat index near ${Math.round(pk.heat)}°` : '', inc.flag === 'red' || inc.flag === 'black' ? `${inc.flag} flag heat for anyone working or dancing` : ''].filter(Boolean);
  const detail = bits.length ? `The forecast has ${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0]}.` : '';
  // The notification's second line: the first thing to do and when, then the forecast, then what the rain does to the ground. The push keeps whole sentences up to its limit.
  const lead = [first, nc, detail, mud].filter(Boolean).join(' ') || p.timing;
  const flagLine = inc.hazard === 'heat' && (inc.flag === 'red' || inc.flag === 'black') ? ` ${flagText(inc.flag)}` : '';
  return {
    id: `headsup-${festival.id}-${hourKey(Date.parse(inc.startsAt))}`, event: head, headline: lead,
    body: `${lead} ${p.timing}${flagLine} ${p.shelter}`, instruction: plan.length ? `${plan.map(d => taskLine(d, tz)).join('. ')}.` : null,
    severity: 'moderate', area: festival.location, source: 'Fieldwatch forecast watch', issuedAt: new Date(now).toISOString(),
    onset: inc.startsAt, expiresAt: inc.endsAt || new Date(Date.parse(inc.startsAt) + 3 * HOUR).toISOString(), channel: 'headsup', relayCount: 0, hazard: inc.hazard, minutes: inc.minutes,
    ...(inc.mud ? { mud: inc.mud.tier } : {}), ...(inc.flag ? { flag: inc.flag } : {}), setup, plan: plan.map(d => ({ task: d.task, startBy: d.startBy })),
  };
}
