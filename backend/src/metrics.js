// Metrics with nobody in them. Everything here is a count per festival per day (db.js `stats`, written by q.count) or a
// number the server already knows (health). No identities, no sessions, no positions: the follow rate is follows over opens,
// and that is as close to a person as any of it gets.
import { q } from './db.js';
import { festivalsInWindow, pollingStatus } from './poller.js';
import { lightningOn, lightningStatus } from './lightning.js';
import { radarStatus } from './radar.js';
import { liveCount } from './live.js';
import { iso } from './util.js';

const DAY = 86_400_000, CODES = ['green', 'yellow', 'orange', 'red'];
const sum = (o, k) => o[k] || 0;
const dayKey = t => new Date(t).toISOString().slice(0, 10);

/** The counters summed over `days`, with a day-by-day series, for one festival or for all of them. */
export function statsFor(days = 7, festivalId = null, now = Date.now()) {
  days = Math.min(365, Math.max(1, Number(days) || 7));
  const rows = q.statsSeries(days).filter(r => (festivalId ? r.festivalId === festivalId : true));
  const totals = {}, byDay = new Map(), per = {};
  for (const { day, festivalId: fid, key, n } of rows) {
    totals[key] = sum(totals, key) + n;
    const d = byDay.get(day) || {}; d[key] = sum(d, key) + n; byDay.set(day, d);
    if (fid !== '*') { const p = per[fid] ||= {}; p[key] = sum(p, key) + n; }
  }
  // Every day of the window is on the series, zeros included, so a sparkline has a point per day.
  const series = [];
  for (let i = days - 1; i >= 0; i--) { const day = dayKey(now - i * DAY); series.push({ day, counts: byDay.get(day) || {} }); }
  const opens = sum(totals, 'alerts') + sum(totals, 'pack'), follows = sum(totals, 'follow');
  const sent = sum(totals, 'push.web') + sum(totals, 'push.apns'), gone = sum(totals, 'push.web.gone'), failed = sum(totals, 'push.web.failed') + sum(totals, 'push.apns.failed');
  const codes = Object.fromEntries(CODES.map(c => [c, Math.round(sum(totals, `lightning.s.${c}`) / 60)]));
  return {
    days, at: iso(now), totals, series,
    alertLatencySeconds: totals['alert.latency_n'] ? Math.round(totals['alert.latency_s'] / totals['alert.latency_n']) : null,
    opens, following: q.following(festivalId), followRate: opens ? Math.round(100 * follows / opens) : null,
    delivered: { sent, gone, failed, rate: sent + gone + failed ? Math.round(100 * sent / (sent + gone + failed)) : null },
    codes, stale: festivalId ? undefined : { poll: sum(totals, 'stale.poll'), lightning: sum(totals, 'stale.lightning'), radar: sum(totals, 'stale.radar') },
    festivals: festivalId ? undefined : Object.entries(per).map(([id, counts]) => ({ id, name: q.festival(id)?.name || id, counts, opens: sum(counts, 'alerts') + sum(counts, 'pack'), following: q.following(id), pushed: sum(counts, 'push.web') + sum(counts, 'push.apns') })).sort((a, b) => b.opens - a.opens),
  };
}

// ---- the season report: the record and the counters of one festival, as rows or a sheet ----
const what = r => r.event || r.title || r.code || r.state || r.summary || '';
export function seasonReport(f, days = 120, now = Date.now()) {
  const stats = statsFor(days, f.id, now), since = iso(now - stats.days * DAY);
  const events = q.logFor(f.id, since).map(r => ({ at: r.at, kind: r.kind, what: what(r), reach: r.reach ? (r.reach.web || 0) + (r.reach.apns || 0) : r.reach != null ? Number(r.reach) || 0 : null, latencySeconds: r.latencySeconds ?? null, detail: Object.fromEntries(Object.entries(r).filter(([k]) => !['at', 'kind'].includes(k))) }));
  const count = k => events.filter(e => e.kind === k).length;
  return {
    festival: { id: f.id, name: f.name, location: f.location || '', startDate: f.startDate, endDate: f.endDate },
    days: stats.days, from: since, at: stats.at,
    summary: { opens: stats.opens, following: stats.following, followRate: stats.followRate, warnings: count('alert'), ended: count('ended'), headsUps: count('headsup'), holdsAndPosts: count('post'), retractions: count('retract'), incidents: count('incident'), groundChanges: count('ground'), staffCodes: count('lightning-staff'), codeChanges: count('lightning'),
      pushed: stats.delivered.sent, delivered: stats.delivered, alertLatencySeconds: stats.alertLatencySeconds, minutesInCode: stats.codes },
    days_series: stats.series.map(d => ({ day: d.day, opens: sum(d.counts, 'alerts') + sum(d.counts, 'pack'), follows: sum(d.counts, 'follow'), warnings: sum(d.counts, 'alert.new'), pushed: sum(d.counts, 'push.web') + sum(d.counts, 'push.apns'), headsUps: sum(d.counts, 'headsup'), reports: sum(d.counts, 'report'), minutesRed: Math.round(sum(d.counts, 'lightning.s.red') / 60) })),
    events,
  };
}
const cell = v => `"${String(v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : v).replace(/"/g, '""')}"`;
const line = cells => cells.map(cell).join(',');
/** One sheet, three sections a spreadsheet opens as is: the summary, the days, the events. */
export function reportCSV(r) {
  const out = [line(['Fieldwatch season report']), line(['festival', r.festival.name]), line(['dates', `${r.festival.startDate} to ${r.festival.endDate}`]), line(['window', `${r.days} days from ${r.from}`]), ''];
  out.push(line(['summary', 'value']));
  for (const [k, v] of Object.entries(r.summary)) out.push(line([k, typeof v === 'object' && v ? JSON.stringify(v) : v]));
  out.push('', line(['day', 'opens', 'follows', 'warnings', 'pushed', 'headsUps', 'reports', 'minutesRed']));
  for (const d of r.days_series) out.push(line([d.day, d.opens, d.follows, d.warnings, d.pushed, d.headsUps, d.reports, d.minutesRed]));
  out.push('', line(['at', 'kind', 'what', 'reach', 'latencySeconds', 'detail']));
  for (const e of r.events) out.push(line([e.at, e.kind, e.what, e.reach, e.latencySeconds, e.detail]));
  return out.join('\n') + '\n';
}

// ---- freshness: a minute in which the data was old is counted, so the metrics say how many minutes a day the backend was behind ----
export const STALE = { pollMs: 3 * 60_000, lightningMs: 5 * 60_000, radarMs: 45 * 60_000 };
const age = (at, now) => (at ? now - Date.parse(at) : Infinity);
/** One look at the clocks; `given` stands in for the live statuses in tests. Returns what was counted. */
export function freshnessTick(now = Date.now(), given = null) {
  const s = given || { polling: pollingStatus(), lightning: lightningStatus(), radar: radarStatus(), on: festivalsInWindow().length };
  const stale = [];
  if (s.polling && s.polling.lastRunAt && age(s.polling.lastOkAt, now) > STALE.pollMs) stale.push('poll');
  if (s.on > 0 && s.lightning && s.lightning.on && s.lightning.lastTickAt && age(s.lightning.lastFileAt, now) > STALE.lightningMs) stale.push('lightning');
  if (s.on > 0 && s.radar && s.radar.festivals > 0 && age(s.radar.lastOkAt, now) > STALE.radarMs) stale.push('radar');
  for (const k of stale) q.count('*', `stale.${k}`);
  return stale;
}
export function startFreshness(seconds = 60) { const t = setInterval(() => { try { freshnessTick(); } catch (e) { console.error('freshness:', e.message); } }, seconds * 1000); t.unref?.(); return t; }

// ---- a scrape for an uptime tool: today's counters as gauges, and what health knows, in the plain text format Prometheus reads ----
const metricName = k => k.replace(/[^a-zA-Z0-9]/g, '_');
export function prometheus(now = Date.now()) {
  const lines = [], g = (name, help, value, labels = '') => { if (!lines.some(l => l.startsWith(`# HELP ${name} `))) lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`); lines.push(`${name}${labels} ${value == null || !Number.isFinite(Number(value)) ? 'NaN' : value}`); };
  const p = pollingStatus(), l = lightningStatus(), r = radarStatus(), on = festivalsInWindow().length;
  g('fieldwatch_up', 'The backend answers.', 1);
  g('fieldwatch_festivals_on', 'Festivals that are on right now.', on);
  g('fieldwatch_following', 'Phones following any festival: web subscriptions and app devices.', q.following(null));
  g('fieldwatch_live_streams', 'Pages holding the live stream open.', liveCount());
  g('fieldwatch_poll_age_seconds', 'Seconds since the last successful alert poll.', p.lastOkAt ? Math.round(age(p.lastOkAt, now) / 1000) : null);
  g('fieldwatch_lightning_file_age_seconds', 'Seconds since the newest lightning file.', lightningOn() && l.lastFileAt ? Math.round(age(l.lastFileAt, now) / 1000) : null);
  g('fieldwatch_radar_age_seconds', 'Seconds since the last radar frame fetched.', r.lastOkAt ? Math.round(age(r.lastOkAt, now) / 1000) : null);
  const today = dayKey(now), perKey = {};
  for (const row of q.statsSeries(1)) { if (row.day !== today) continue; const k = metricName(row.key); (perKey[k] ||= []).push(row); }
  for (const [k, rows] of Object.entries(perKey)) {
    const name = `fieldwatch_today_${k}`;
    g(name, `Today's count of ${rows[0].key}, with nobody in it.`, rows.reduce((a, b) => a + b.n, 0));
    for (const row of rows) if (row.festivalId !== '*') g(name, '', row.n, `{festival="${row.festivalId.replace(/"/g, '')}"}`);
  }
  return lines.join('\n') + '\n';
}
