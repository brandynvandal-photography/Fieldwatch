// ==== shared: start ====
// Fieldwatch's weather logic, byte for byte the same in backend/src/incoming.js and web/index.html: the backend pushes
// from it, the phone draws from it, and backend/test/mirror.test.js fails when the two differ. Pure functions only:
// nothing from the page or the server, no imports.
const HOUR = 3600000;
// Lines the forecast has to cross: chance of thunder (%), gusts (mph), rain in the window (inches) with the chance of
// rain (%) standing in when the grid has no amount, hourly rain that counts as raining (inches), heat index (°F).
const THRESHOLDS = { thunder: 30, gustMph: 30, precip: 60, rainIn: 0.25, rainInHr: 0.02, heatF: 100 };
// Gust lines by what is standing: inflatables come down at 20 mph, pop-up canopies fail around 30, stages and rigging hold to 40.
const WIND_LINES = { inflatables: 20, canopies: 30, stage: 40 };
const WIND_LABEL = { inflatables: 'inflatables line', canopies: 'canopy line', stage: 'stage hold line' };
/** The gust that matters here: the lowest line among what is standing (canopies, when nothing is known). */
const windLine = ground => Math.min(...((ground && Array.isArray(ground.structures) && ground.structures.length ? ground.structures : ['canopies']).map(s => WIND_LINES[s] || WIND_LINES.canopies)));
/** "the canopy line", "the inflatables and canopy lines". */
const lineWords = crossed => { const l = crossed.map(s => WIND_LABEL[s]).filter(Boolean); return !l.length ? '' : l.length === 1 ? `the ${l[0]}` : `the ${l.slice(0, -1).map(x => x.replace(/ line$/, '')).join(', ')} and ${l[l.length - 1].replace(/ line$/, ' lines')}`; };
const PRIORITY = ['tornado', 'storms', 'hail', 'wind', 'flood', 'rain', 'heat'];
const ALERT_HAZARD = [[/tornado/i, 'tornado'], [/thunderstorm|lightning/i, 'storms'], [/hail/i, 'hail'], [/wind|gale/i, 'wind'], [/flood/i, 'flood'], [/heat/i, 'heat'], [/rain|storm/i, 'rain']];
const LABEL = { tornado: 'Tornado', storms: 'Storms', hail: 'Hail', wind: 'Strong wind', flood: 'Flooding', rain: 'Heavy rain', heat: 'Dangerous heat' };
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
/** The grid's hour-by-hour numbers the model reads: heat index (°F), gusts (mph), chance of thunder (%), rain (inches in the hour). */
const spreadGrid = (g, hourly = []) => ({ heat: spread(g?.heatIndex, cToF), gust: spread(g?.windGust, kmhToMph), thunder: spread(g?.probabilityOfThunder), rain: allocate(g?.quantitativePrecipitation, hourly) });
const alertHazard = event => (ALERT_HAZARD.find(([re]) => re.test(event || '')) || [null, null])[1];
/**
 * What is coming: { hazard, startsAt, endsAt, minutes, source: 'forecast' | 'alert', event?, peak } or null. The forecast window
 * is the first run of hours over a line; rain counts by amount when the grid has one (a run must add up to rainIn), by chance
 * when it does not. A watch or warning with an onset still ahead wins when it comes first.
 */
function incoming({ hourly = [], grid = {}, alerts = [], ground = {}, now = Date.now(), hours = 12 } = {}) {
  const end = now + hours * HOUR, gustLine = windLine(ground), standing = ground && Array.isArray(ground.structures) && ground.structures.length ? ground.structures : ['canopies'];
  const marks = hourly.map(h => ({ t: Date.parse(h.startTime), h })).filter(x => Number.isFinite(x.t) && x.t + HOUR > now && x.t < end).sort((a, b) => a.t - b.t)
    .map(({ t, h }) => {
      const k = hourKey(t), thunder = grid.thunder?.[k] ?? null, gust = grid.gust?.[k] ?? null, heat = grid.heat?.[k] ?? null, precip = h.precipChance ?? null, rain = grid.rain?.[k] ?? null;
      const hazards = [];
      if (thunder >= THRESHOLDS.thunder) hazards.push('storms');
      if (gust >= gustLine) hazards.push('wind');
      if (heat >= THRESHOLDS.heatF) hazards.push('heat');
      return { t, hazards, thunder, gust, heat, precip, rain, wet: rain != null ? rain >= THRESHOLDS.rainInHr : precip >= THRESHOLDS.precip };
    });
  // A run of wet hours is rain when it adds up: a drizzle that never reaches rainIn is not worth a heads-up.
  for (let i = 0; i < marks.length; i++) {
    if (!marks[i].wet) continue;
    let j = i; while (j + 1 < marks.length && marks[j + 1].wet && marks[j + 1].t - marks[j].t <= HOUR) j++;
    const run = marks.slice(i, j + 1), known = run.some(m => m.rain != null), total = run.reduce((s, m) => s + (m.rain || 0), 0);
    if (!known || total >= THRESHOLDS.rainIn) for (const m of run) m.hazards.push('rain');
    i = j;
  }
  let forecast = null;
  const i = marks.findIndex(m => m.hazards.length);
  if (i >= 0) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1].hazards.length && marks[j + 1].t - marks[j].t <= HOUR) j++;
    const win = marks.slice(i, j + 1), all = new Set(win.flatMap(m => m.hazards));
    const peakOf = key => win.reduce((b, m) => (m[key] != null && (b == null || m[key] > b) ? m[key] : b), null);
    const rainIn = win.some(m => m.rain != null) ? Math.round(win.reduce((s, m) => s + (m.rain || 0), 0) * 100) / 100 : null;
    forecast = { hazard: PRIORITY.find(p => all.has(p)), startsAt: new Date(Math.max(now, marks[i].t)).toISOString(), endsAt: new Date(marks[j].t + HOUR).toISOString(),
      source: 'forecast', peak: { thunder: peakOf('thunder'), gust: peakOf('gust'), precip: peakOf('precip'), heat: peakOf('heat'), rainIn, rateInHr: rainIn == null ? null : Math.round((peakOf('rain') || 0) * 100) / 100 } };
    if (rainIn != null && all.has('rain')) forecast.mud = mudTier(ground, rainIn, forecast.peak.rateInHr);
    if (forecast.peak.gust != null) forecast.wind = { line: gustLine, crossed: standing.filter(s => forecast.peak.gust >= (WIND_LINES[s] || WIND_LINES.canopies)) };
  }
  let watch = null;
  for (const a of alerts) {
    const onset = Date.parse(a.onset || ''), hz = alertHazard(a.event);
    if (!hz || !Number.isFinite(onset) || onset <= now || onset >= end || a.channel === 'headsup') continue;
    if (!watch || onset < Date.parse(watch.startsAt)) watch = { hazard: hz, startsAt: new Date(onset).toISOString(), endsAt: a.expiresAt || null, source: 'alert', event: a.event, peak: {} };
  }
  const pick = watch && (!forecast || Date.parse(watch.startsAt) <= Date.parse(forecast.startsAt)) ? watch : forecast;
  return pick ? { ...pick, minutes: Math.max(0, Math.round((Date.parse(pick.startsAt) - now) / 60000)) } : null;
}
/** Rain in a sentence: "0.6 in of rain" when the grid says how much, "a 70% chance of rain" when it only says how likely. */
const rainWords = p => p.rainIn != null ? `${p.rainIn < 0.1 ? 'under 0.1' : p.rainIn.toFixed(1)} in of rain` : p.precip != null ? `a ${Math.round(p.precip)}% chance of rain` : '';
// Mud: inches of rain before trampled grass on this soil goes soft (USDA hydrologic group A drains fast, D is clay), and how
// the surface changes that. Sand and blacktop never make mud; they puddle, run off or turn slick instead.
const MUD_IN = { A: 1.5, B: 0.75, C: 0.5, D: 0.3 };
const SURFACE_X = { grass: 1, dirt: 0.6, gravel: 2.5, mixed: 1.2 };
const TIER = {
  wet:    { label: 'Rain', line: 'Wet, not muddy', camp: ['Rain shell and a tarp over the tent', 'Bins and bags off the floor', 'Seal a dry set of clothes in a bag'] },
  soft:   { label: 'Mud', line: 'Paths will be soft and muddy', camp: ['Move the car to hard ground', 'Bins and bags off the floor', 'Boots, and a dry route to the stages', 'Tarp over, not under, so water sheds'] },
  deep:   { label: 'Deep mud', line: 'Fields will not hold vehicles', camp: ['Anything that must leave, leaves before it starts', 'Move the car to hard ground', 'Tarp over the tent floor, gear in bins', 'Expect fields closed to vehicles after'] },
  water:  { label: 'Standing water', line: 'Low ground will flood', camp: ['Move the tent off low ground', 'Bins and bags off the floor', 'Know the route to high ground', 'Move the car to hard ground'] },
  slick:  { label: 'Rain', line: 'Slick ground and puddles', camp: ['Keep gear off the ground', 'Rain shell', 'Watch your footing on painted lines and metal plates'] },
  runoff: { label: 'Heavy rain', line: 'Runoff into the low end', camp: ['Keep gear off the ground', 'Weigh down anything light; runoff moves it', 'Plan the walk around the low end', 'Stay out of underpasses and drains'] },
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
// How long each camp task takes, so a start-by time can be worked back from the arrival. Anything not listed takes ten minutes.
const TASK_MIN = [['Anything that must leave', 90], ['Move the car', 60], ['Move the tent', 45], ['Deflate and tie down', 30], ['Stage: clear the deck', 20], ['Park a vehicle upwind', 20], ['Guy lines and sandbags', 20], ['Shade over the tent', 20], ['Tarp over the tent floor', 20],
  ['Pack what you can carry', 20], ['Stake every loop', 15], ['Tarp over, not under', 15], ['Drop pop-up canopies', 5], ['Seal a dry set', 5], ['Leave the camp', 5], ['Get to the shelter', 5],
  ['Head down', 0], ['Freeze water bottles', 0], ['Rest between', 0], ['Check on neighbours', 0], ['Expect fields', 0], ['Know the route', 0], ['Rain shell', 0], ['Plan the walk', 0], ['Stay out of', 0], ['Watch your footing', 0], ['Leave the car', 0]];
const taskMinutes = t => (TASK_MIN.find(([k]) => t.startsWith(k)) || [null, 10])[1];
/** The camp list for what is coming: the hazard's own, with the mud tier's car and tent moves in front when the ground calls for them. */
function campFor(inc) {
  const own = inc.hazard === 'rain' && inc.mud ? TIER[inc.mud.tier].camp : (PREP[inc.hazard] || PREP.storms).camp;
  const ground = inc.hazard !== 'rain' && inc.mud && ['soft', 'deep', 'water'].includes(inc.mud.tier) ? TIER[inc.mud.tier].camp.filter(t => /^(Anything that must leave|Move the car|Move the tent)/.test(t)) : [];
  const crossed = (inc.wind && inc.wind.crossed) || [], standing = [];
  if (crossed.includes('stage')) standing.push('Stage: clear the deck, drop the scrim and the banners');
  if (crossed.includes('inflatables')) standing.push('Deflate and tie down the inflatables');
  return [...standing, ...ground, ...own.filter(t => !ground.includes(t))];
}
/** Each task with when to start it: the arrival less how long it takes less ten minutes, earliest start first. Late means it should have started already. */
function deadlines(startsAt, tasks, now = Date.now()) {
  const t0 = Date.parse(startsAt);
  return tasks.map(t => { const m = taskMinutes(t), by = t0 - (m + 10) * 60000; return { task: t, minutes: m, startBy: new Date(Math.max(now, by)).toISOString(), late: by <= now }; })
    .sort((a, b) => Date.parse(a.startBy) - Date.parse(b.startBy) || b.minutes - a.minutes);
}
// Where to shelter, how to solidify camp, what it is like while it is here, and after. The push says the first two, shorter.
const PREP = {
  storms:  { label: 'Storms', shelter: 'Shelter is a hard-topped vehicle or a building with wiring and plumbing. Tents, canopies and stages are not shelter.',
             camp: ['Drop pop-up canopies and flags', 'Stake every loop, tie guy lines, weigh the legs', 'Unplug and bag electronics', 'Move poles and chairs away from where people sit'],
             during: 'Stay in shelter until it passes. Do not go back for anything.', after: 'Wait thirty minutes after the last thunder before going back out. Lightning reaches ten miles ahead of the rain.' },
  wind:    { label: 'Strong wind', shelter: 'Get into a vehicle or a building if it turns dangerous. Stay clear of stages, towers and anything tall that is tied down.',
             camp: ['Drop pop-up canopies now, they fly', 'Guy lines and sandbags or water jugs on every leg', 'Take down banners and flags', 'Close and weigh coolers and bins', 'Park a vehicle upwind as a windbreak'],
             during: 'Stay away from tents, stages and trees until the gusts ease.', after: 'Check every stake and line before you trust the tent again.' },
  rain:    { label: 'Heavy rain', shelter: 'A vehicle or a building keeps you dry. A tent on high ground is fine while there is no thunder.',
             camp: ['Move the tent off low ground', 'Bins and bags off the floor', 'Tarp over, not under, so water sheds', 'Seal a dry set of clothes in a bag'],
             during: 'Stay dry and off low ground. Watch the paths for standing water.', after: 'Dry the sleeping gear first. Wet nights are how people get cold.' },
  flood:   { label: 'Flooding', shelter: 'Move to high ground now, away from creeks and low fields. Never drive or walk through moving water.',
             camp: ['Pack what you can carry', 'Know the route to high ground', 'Leave the car if water is rising around it'],
             during: 'Stay on high ground. Water rises faster than it looks.', after: 'Stay off flooded paths until staff open them. The water hides what it took.' },
  heat:    { label: 'Dangerous heat', shelter: 'Water every twenty minutes, shade at midday, and the medical tent at the first sign of confusion or no sweat.',
             camp: ['Shade over the tent, not only inside it', 'Freeze water bottles overnight', 'Rest between noon and four', 'Check on neighbours'],
             during: 'Shade, water, rest. Watch each other for confusion, cramps, or skin that stops sweating.', after: 'Keep drinking after sundown. The heat you took in stays with you.' },
  hail:    { label: 'Hail', shelter: 'Get under a solid roof or into a vehicle. Tents, canopies and stages are not shelter.',
             camp: ['Lay canopies flat so hail does not shred them', 'Cover windshields with mats or blankets', 'Get under a solid roof'],
             during: 'Stay under the roof until it stops.', after: 'Check the tent and the car for damage before the next rain.' },
  tornado: { label: 'Tornado', shelter: 'Get to the shelter the festival named or the lowest floor of a solid building. Vehicles and tents are not safe from a tornado.',
             camp: ['Leave the camp', 'Get to the shelter the festival named', 'Head down, cover your head'],
             during: 'Stay down in the shelter until the warning ends.', after: 'Watch for downed lines and broken glass on the way back.' },
};
const SHELTER_PACK = ['Phone and a battery pack', 'Water and a snack', 'Rain shell and a warm layer', 'ID, cash, keys, medication', 'A light'];
/** What to do with the time there is, the same line the push carries. */
function timing(hazard, m) {
  if (hazard === 'rain') return m <= 20 ? 'Last things under cover, then stay dry.' : m <= 60 ? 'Finish the camp list now: the ground goes first, then the paths.' : m <= 180 ? 'Work the list in order, the car first if it must move.' : 'Secure what you would hate to lose, and check back in an hour.';
  if (hazard === 'heat') return m <= 20 ? 'Get into shade now, and drink.' : m <= 60 ? 'Find your shade for the afternoon and fill every bottle.' : m <= 180 ? 'Fill water, find shade for the afternoon, and rest before it peaks.' : 'Freeze bottles, plan the afternoon in shade, and check back in an hour.';
  return m <= 20 ? 'Go to shelter now and leave the gear.' : m <= 60 ? 'Finish securing camp in the next few minutes, then head for shelter with fifteen to spare.'
    : m <= 180 ? 'Secure camp now, charge phones, fill water, and decide where you will shelter.' : 'Secure what you would hate to lose, and check back in an hour.';
}
// ==== shared: end ====

// ---- backend only: the wording of a push, in the festival's own clock ----
export { THRESHOLDS, WIND_LINES, LABEL, PREP, TIER, SHELTER_PACK, hourKey, spread, allocate, spreadGrid, cToF, kmhToMph, alertHazard, incoming, rainWords, mudTier, groundWords, windLine, lineWords, campFor, deadlines, taskMinutes, timing };
export const clock = (t, tz) => { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(11, 16) + 'Z'; } };
/** One line for a notification: what, and when. */
export function headline(inc, tz) {
  const at = inc.minutes <= 0 ? 'now' : `around ${clock(inc.startsAt, tz)}`;
  if (inc.source === 'alert') return `${inc.event} ${inc.minutes <= 0 ? 'in effect now' : `begins ${clock(inc.startsAt, tz)}`}`;
  if (inc.hazard === 'wind') return `Gusts to ${Math.round(inc.peak.gust)} mph${inc.wind && inc.wind.crossed.length ? `, past ${lineWords(inc.wind.crossed)},` : ''} expected ${at}`;
  if (inc.hazard === 'heat') return `Heat index near ${Math.round(inc.peak.heat)}° expected ${at}`;
  if (inc.hazard === 'rain' && inc.mud) return `${TIER[inc.mud.tier].label} expected ${at}`;
  return `${LABEL[inc.hazard] || 'Weather'} expected ${at}`;
}
/** Where to shelter, the camp list and the timing line for a hazard, from the shared tables. */
export function prep(hazard, minutes) {
  const P = PREP[hazard] || PREP.storms;
  return { shelter: P.shelter, camp: P.camp, timing: timing(hazard, minutes) };
}
/** What this rain does to this ground, in a sentence: "Paths will be soft and muddy: 0.8 in of rain on grass over clay, after 1.1 in already down." */
export function mudWords(inc, ground = {}) {
  const m = inc.mud; if (!m) return '';
  return `${TIER[m.tier].line}: ${rainWords(inc.peak || {})} on ${groundWords(ground)}${m.past >= 0.1 ? `, after ${m.past.toFixed(1)} in already down` : ''}.`;
}
/** A task and its start-by time, in the festival's own clock: "Move the car to hard ground by 4:45 PM", or "now" once that has passed. */
const taskLine = (d, tz) => `${d.task} ${d.late ? 'now' : `by ${clock(d.startBy, tz)}`}`;
/** The heads-up as an alert: pushed like a warning, listed with the alerts, and gone when the weather is. */
export function headsUpAlert(festival, inc, tz, now = Date.now(), ground = {}) {
  const p = prep(inc.hazard, inc.minutes), head = headline(inc, tz), pk = inc.peak || {};
  const plan = deadlines(inc.startsAt, campFor(inc), now), first = plan[0] ? `${taskLine(plan[0], tz)}.` : '';
  const mud = inc.mud && inc.mud.tier !== 'wet' ? mudWords(inc, ground) : '';
  // What the forecast says, as a sentence: "The forecast has a 60% chance of thunder, gusts to 45 mph and 0.6 in of rain." The mud sentence carries the rain when there is one.
  const raining = pk.rainIn != null ? pk.rainIn >= THRESHOLDS.rainIn : pk.precip >= THRESHOLDS.precip;
  const crossed = (inc.wind && inc.wind.crossed) || [];
  const bits = inc.source === 'alert' ? [] : [inc.hazard === 'storms' && pk.thunder != null ? `a ${Math.round(pk.thunder)}% chance of thunder` : '',
    crossed.length ? `gusts to ${Math.round(pk.gust)} mph past ${lineWords(crossed)}` : pk.gust >= THRESHOLDS.gustMph ? `gusts to ${Math.round(pk.gust)} mph` : '', raining && !mud ? rainWords(pk) : '',
    pk.heat >= THRESHOLDS.heatF ? `a heat index near ${Math.round(pk.heat)}°` : ''].filter(Boolean);
  const detail = bits.length ? `The forecast has ${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0]}.` : '';
  // The notification's second line: the first thing to do and when, then the forecast, then what the rain does to the ground. The push keeps whole sentences up to its limit.
  const lead = [first, detail, mud].filter(Boolean).join(' ') || p.timing;
  return {
    id: `headsup-${festival.id}-${hourKey(Date.parse(inc.startsAt))}`, event: head, headline: lead,
    body: `${lead} ${p.timing} ${p.shelter}`, instruction: plan.length ? `${plan.map(d => taskLine(d, tz)).join('. ')}.` : null,
    severity: 'moderate', area: festival.location, source: 'Fieldwatch forecast watch', issuedAt: new Date(now).toISOString(),
    onset: inc.startsAt, expiresAt: inc.endsAt || new Date(Date.parse(inc.startsAt) + 3 * HOUR).toISOString(), channel: 'headsup', relayCount: 0, hazard: inc.hazard, minutes: inc.minutes,
    ...(inc.mud ? { mud: inc.mud.tier } : {}), plan: plan.map(d => ({ task: d.task, startBy: d.startBy })),
  };
}
