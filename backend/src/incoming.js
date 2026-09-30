// What is coming at a festival: the first stretch of the next twelve hours the forecast calls stormy, windy, wet or
// dangerously hot, or the start of a watch or warning that has not begun. The app mirrors this in web/index.html
// (incoming, PREP, prepSteps); keep the thresholds the same in both.
const HOUR = 3_600_000;
export const THRESHOLDS = { thunder: 30, gustMph: 35, precip: 60, heatF: 100 };
const PRIORITY = ['tornado', 'storms', 'hail', 'wind', 'flood', 'rain', 'heat'];
const ALERT_HAZARD = [[/tornado/i, 'tornado'], [/thunderstorm|lightning/i, 'storms'], [/hail/i, 'hail'], [/wind|gale/i, 'wind'], [/flood/i, 'flood'], [/heat/i, 'heat'], [/rain|storm/i, 'rain']];
export const LABEL = { tornado: 'Tornado', storms: 'Storms', hail: 'Hail', wind: 'Strong wind', flood: 'Flooding', rain: 'Heavy rain', heat: 'Dangerous heat' };
export const hourKey = t => Math.floor(t / HOUR);
const DURATION = /P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/;

/** A gridpoint series (an ISO interval with a duration, in metric) spread hour by hour and keyed by the hour. */
export function spread(series, convert = v => v) {
  const out = {};
  for (const v of (series && series.values) || []) {
    if (v.value == null) continue;
    const [start, dur] = String(v.validTime).split('/'), m = DURATION.exec(dur || 'PT1H') || [];
    const hours = Math.max(1, Number(m[1] || 0) * 24 + Number(m[2] || 0) + (Number(m[3] || 0) ? 1 : 0)), t0 = Date.parse(start);
    if (Number.isNaN(t0)) continue;
    for (let h = 0; h < hours && h < 72; h++) out[hourKey(t0 + h * HOUR)] = convert(v.value);
  }
  return out;
}
export const cToF = c => c * 9 / 5 + 32, kmhToMph = k => k / 1.609;
export const spreadGrid = g => ({ heat: spread(g?.heatIndex, cToF), gust: spread(g?.windGust, kmhToMph), thunder: spread(g?.probabilityOfThunder) });
export const alertHazard = event => (ALERT_HAZARD.find(([re]) => re.test(event || '')) || [null, null])[1];

/**
 * { hazard, startsAt, endsAt, minutes, source: 'forecast' | 'alert', event?, peak } or null. The forecast window is the
 * first run of hours over a threshold; a watch or warning with an onset still ahead wins when it comes first.
 */
export function incoming({ hourly = [], grid = {}, alerts = [], now = Date.now(), hours = 12 } = {}) {
  const end = now + hours * HOUR;
  const marks = hourly.map(h => ({ t: Date.parse(h.startTime), h })).filter(x => Number.isFinite(x.t) && x.t + HOUR > now && x.t < end).sort((a, b) => a.t - b.t)
    .map(({ t, h }) => {
      const k = hourKey(t), thunder = grid.thunder?.[k] ?? null, gust = grid.gust?.[k] ?? null, heat = grid.heat?.[k] ?? null, precip = h.precipChance ?? null;
      const hazards = [];
      if (thunder >= THRESHOLDS.thunder) hazards.push('storms');
      if (gust >= THRESHOLDS.gustMph) hazards.push('wind');
      if (precip >= THRESHOLDS.precip) hazards.push('rain');
      if (heat >= THRESHOLDS.heatF) hazards.push('heat');
      return { t, hazards, thunder, gust, heat, precip };
    });
  let forecast = null;
  const i = marks.findIndex(m => m.hazards.length);
  if (i >= 0) {
    let j = i;
    while (j + 1 < marks.length && marks[j + 1].hazards.length && marks[j + 1].t - marks[j].t <= HOUR) j++;
    const win = marks.slice(i, j + 1), all = new Set(win.flatMap(m => m.hazards));
    const peakOf = key => win.reduce((b, m) => (m[key] != null && (b == null || m[key] > b) ? m[key] : b), null);
    forecast = { hazard: PRIORITY.find(p => all.has(p)), startsAt: new Date(Math.max(now, marks[i].t)).toISOString(), endsAt: new Date(marks[j].t + HOUR).toISOString(),
      source: 'forecast', peak: { thunder: peakOf('thunder'), gust: peakOf('gust'), precip: peakOf('precip'), heat: peakOf('heat') } };
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

export const clock = (t, tz) => { try { return new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz || 'UTC' }).format(new Date(t)); } catch { return new Date(t).toISOString().slice(11, 16) + 'Z'; } };
/** One line for a notification: what, and when, in the festival's own clock. */
export function headline(inc, tz) {
  const at = inc.minutes <= 0 ? 'now' : `around ${clock(inc.startsAt, tz)}`;
  if (inc.source === 'alert') return `${inc.event} ${inc.minutes <= 0 ? 'in effect now' : `begins ${clock(inc.startsAt, tz)}`}`;
  if (inc.hazard === 'wind') return `Gusts to ${Math.round(inc.peak.gust)} mph expected ${at}`;
  if (inc.hazard === 'heat') return `Heat index near ${Math.round(inc.peak.heat)}° expected ${at}`;
  return `${LABEL[inc.hazard] || 'Weather'} expected ${at}`;
}
/** What to do with the time there is. The app's prep screen says the same, at more length. */
export function prep(hazard, minutes) {
  const shelter = hazard === 'tornado' ? 'Get to the shelter the festival named or the lowest floor of a solid building. Vehicles and tents are not safe from a tornado.'
    : hazard === 'storms' || hazard === 'hail' ? 'Shelter is a hard-topped vehicle or a building with wiring and plumbing. Tents, canopies and stages are not shelter.'
    : hazard === 'flood' ? 'Move to high ground now, away from creeks and low fields. Never drive or walk through moving water.'
    : hazard === 'heat' ? 'Water every twenty minutes, shade at midday, and the medical tent at the first sign of confusion or no sweat.'
    : 'Get into a vehicle or a building if it turns dangerous.';
  const camp = {
    storms: ['Drop pop-up canopies and flags', 'Stake every loop, tie guy lines, weigh the legs', 'Unplug and bag electronics', 'Move poles and chairs away from where people sit'],
    wind: ['Drop pop-up canopies now, they fly', 'Guy lines and sandbags or water jugs on every leg', 'Take down banners and flags', 'Close and weigh coolers and bins', 'Park a vehicle upwind as a windbreak'],
    rain: ['Move the tent off low ground', 'Bins and bags off the floor', 'Tarp over, not under, so water sheds', 'Seal a dry set of clothes in a bag'],
    flood: ['Pack what you can carry', 'Know the route to high ground', 'Leave the car if water is rising around it'],
    heat: ['Shade over the tent, not only inside it', 'Freeze water bottles overnight', 'Rest between noon and four', 'Check on neighbours'],
    hail: ['Lay canopies flat so hail does not shred them', 'Cover windshields with mats or blankets', 'Get under a solid roof'],
    tornado: ['Leave the camp', 'Get to the shelter the festival named', 'Head down, cover your head'],
  }[hazard] || [];
  const timing = hazard === 'heat'
    ? (minutes <= 20 ? 'Get into shade now, and drink.' : minutes <= 60 ? 'Find your shade for the afternoon and fill every bottle.' : minutes <= 180 ? 'Fill water, find shade for the afternoon, and rest before it peaks.' : 'Freeze bottles, plan the afternoon in shade, and check back in an hour.')
    : minutes <= 20 ? 'Go to shelter now and leave the gear.' : minutes <= 60 ? 'Finish securing camp in the next few minutes, then head for shelter with fifteen to spare.'
    : minutes <= 180 ? 'Secure camp now, charge phones, fill water, and decide where you will shelter.' : 'Secure what you would hate to lose, and check back in an hour.';
  return { shelter, camp, timing };
}
/** The heads-up as an alert: pushed like a warning, listed with the alerts, and gone when the weather is. */
export function headsUpAlert(festival, inc, tz, now = Date.now()) {
  const p = prep(inc.hazard, inc.minutes), head = headline(inc, tz);
  const detail = inc.source === 'alert' ? '' : [inc.hazard === 'storms' && inc.peak.thunder != null ? `Thunder chance ${Math.round(inc.peak.thunder)}%` : '',
    inc.peak.gust >= THRESHOLDS.gustMph ? `gusts to ${Math.round(inc.peak.gust)} mph` : '', inc.peak.precip >= THRESHOLDS.precip ? `rain ${Math.round(inc.peak.precip)}%` : ''].filter(Boolean).join(', ');
  const lead = `${detail ? `${detail}. ` : ''}${p.timing}`;   // the notification's second line, under the headline
  return {
    id: `headsup-${festival.id}-${hourKey(Date.parse(inc.startsAt))}`, event: head, headline: lead,
    body: `${lead} ${p.shelter}`, instruction: p.camp.length ? `${p.camp.join('. ')}.` : null,
    severity: 'moderate', area: festival.location, source: 'Fieldwatch forecast watch', issuedAt: new Date(now).toISOString(),
    onset: inc.startsAt, expiresAt: inc.endsAt || new Date(Date.parse(inc.startsAt) + 3 * HOUR).toISOString(), channel: 'headsup', relayCount: 0, hazard: inc.hazard, minutes: inc.minutes,
  };
}
