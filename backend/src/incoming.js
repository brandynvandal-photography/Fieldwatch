// ==== shared: start ====
// Fieldwatch's weather logic, byte for byte the same in backend/src/incoming.js and web/index.html: the backend pushes
// from it, the phone draws from it, and backend/test/mirror.test.js fails when the two differ. Pure functions only:
// nothing from the page or the server, no imports.
const HOUR = 3600000;
// Lines the forecast has to cross: chance of thunder (%), gusts (mph), rain in the window (inches) with the chance of
// rain (%) standing in when the grid has no amount, hourly rain that counts as raining (inches), heat index (°F).
const THRESHOLDS = { thunder: 30, gustMph: 35, precip: 60, rainIn: 0.25, rainInHr: 0.02, heatF: 100 };
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
function incoming({ hourly = [], grid = {}, alerts = [], now = Date.now(), hours = 12 } = {}) {
  const end = now + hours * HOUR;
  const marks = hourly.map(h => ({ t: Date.parse(h.startTime), h })).filter(x => Number.isFinite(x.t) && x.t + HOUR > now && x.t < end).sort((a, b) => a.t - b.t)
    .map(({ t, h }) => {
      const k = hourKey(t), thunder = grid.thunder?.[k] ?? null, gust = grid.gust?.[k] ?? null, heat = grid.heat?.[k] ?? null, precip = h.precipChance ?? null, rain = grid.rain?.[k] ?? null;
      const hazards = [];
      if (thunder >= THRESHOLDS.thunder) hazards.push('storms');
      if (gust >= THRESHOLDS.gustMph) hazards.push('wind');
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
  if (hazard === 'heat') return m <= 20 ? 'Get into shade now, and drink.' : m <= 60 ? 'Find your shade for the afternoon and fill every bottle.' : m <= 180 ? 'Fill water, find shade for the afternoon, and rest before it peaks.' : 'Freeze bottles, plan the afternoon in shade, and check back in an hour.';
  return m <= 20 ? 'Go to shelter now and leave the gear.' : m <= 60 ? 'Finish securing camp in the next few minutes, then head for shelter with fifteen to spare.'
    : m <= 180 ? 'Secure camp now, charge phones, fill water, and decide where you will shelter.' : 'Secure what you would hate to lose, and check back in an hour.';
}
// ==== shared: end ====

// ---- backend only: the wording of a push, in the festival's own clock ----
export { THRESHOLDS, LABEL, PREP, SHELTER_PACK, hourKey, spread, allocate, spreadGrid, cToF, kmhToMph, alertHazard, incoming, rainWords, timing };
export const clock = (t, tz) => { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(11, 16) + 'Z'; } };
/** One line for a notification: what, and when. */
export function headline(inc, tz) {
  const at = inc.minutes <= 0 ? 'now' : `around ${clock(inc.startsAt, tz)}`;
  if (inc.source === 'alert') return `${inc.event} ${inc.minutes <= 0 ? 'in effect now' : `begins ${clock(inc.startsAt, tz)}`}`;
  if (inc.hazard === 'wind') return `Gusts to ${Math.round(inc.peak.gust)} mph expected ${at}`;
  if (inc.hazard === 'heat') return `Heat index near ${Math.round(inc.peak.heat)}° expected ${at}`;
  return `${LABEL[inc.hazard] || 'Weather'} expected ${at}`;
}
/** Where to shelter, the camp list and the timing line for a hazard, from the shared tables. */
export function prep(hazard, minutes) {
  const P = PREP[hazard] || PREP.storms;
  return { shelter: P.shelter, camp: P.camp, timing: timing(hazard, minutes) };
}
/** The heads-up as an alert: pushed like a warning, listed with the alerts, and gone when the weather is. */
export function headsUpAlert(festival, inc, tz, now = Date.now()) {
  const p = prep(inc.hazard, inc.minutes), head = headline(inc, tz), pk = inc.peak || {};
  // What the forecast says, as a sentence: "The forecast has a 60% chance of thunder, gusts to 45 mph and 0.6 in of rain."
  const raining = pk.rainIn != null ? pk.rainIn >= THRESHOLDS.rainIn : pk.precip >= THRESHOLDS.precip;
  const bits = inc.source === 'alert' ? [] : [inc.hazard === 'storms' && pk.thunder != null ? `a ${Math.round(pk.thunder)}% chance of thunder` : '',
    pk.gust >= THRESHOLDS.gustMph ? `gusts to ${Math.round(pk.gust)} mph` : '', raining ? rainWords(pk) : '',
    pk.heat >= THRESHOLDS.heatF ? `a heat index near ${Math.round(pk.heat)}°` : ''].filter(Boolean);
  const detail = bits.length ? `The forecast has ${bits.length > 1 ? `${bits.slice(0, -1).join(', ')} and ${bits[bits.length - 1]}` : bits[0]}.` : '';
  const lead = `${detail ? `${detail} ` : ''}${p.timing}`;   // the notification's second line, under the headline
  return {
    id: `headsup-${festival.id}-${hourKey(Date.parse(inc.startsAt))}`, event: head, headline: lead,
    body: `${lead} ${p.shelter}`, instruction: p.camp.length ? `${p.camp.join('. ')}.` : null,
    severity: 'moderate', area: festival.location, source: 'Fieldwatch forecast watch', issuedAt: new Date(now).toISOString(),
    onset: inc.startsAt, expiresAt: inc.endsAt || new Date(Date.parse(inc.startsAt) + 3 * HOUR).toISOString(), channel: 'headsup', relayCount: 0, hazard: inc.hazard, minutes: inc.minutes,
  };
}
