// The morning brief: once a day at DIGEST_HOUR in the festival's own clock, one quiet push to every phone that favorited it,
// with the day in a line: the high, the first window worth a heads-up and the first thing to do, and sunset. Off for a phone
// that said so when it subscribed (digest: false), off everywhere with DIGEST_HOUR=off.
import { q } from './db.js';
import { festivalsInWindow } from './poller.js';
import { gridpoint, hourly, point } from './nws.js';
import { groundFor } from './ground.js';
import { headline, incoming, spreadGrid, sunTimes, campFor, deadlines, clock, localHour } from './incoming.js';
import { pushAlert } from './push.js';
import { pushWeb } from './webpush.js';
import { iso } from './util.js';

const localDay = (t, tz) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t)); } catch { return iso(t).slice(0, 10); } };
/** The brief for one festival, as the words a push carries. */
export async function digestFor(f, { now = Date.now(), tz = 'UTC', hours = 16 } = {}) {
  const [periods, g] = await Promise.all([hourly(f.latitude, f.longitude), gridpoint(f.latitude, f.longitude)]);
  const ground = await groundFor(f, { now });
  const ahead = periods.filter(p => { const t = Date.parse(p.startTime); return t + 3_600_000 > now && t < now + hours * 3_600_000; });
  const hi = ahead.length ? Math.round(Math.max(...ahead.map(p => p.temperature))) : null;
  const inc = incoming({ hourly: periods, grid: spreadGrid(g, periods), alerts: q.activeAlerts(f.id), ground, now, hours });
  const first = inc && inc.source !== 'alert' ? deadlines(inc.startsAt, campFor(inc, ground.camping === true ? 'camping' : 'day'), now)[0] : null;
  const sun = sunTimes(f.latitude, f.longitude, now);
  const window = inc ? (inc.source === 'alert' ? headline(inc, tz) : headline(inc, tz).replace(/^./, c => c.toLowerCase())) : 'nothing in the forecast worth a heads-up';   // an alert's name keeps its capitals
  const bits = [hi != null ? `High ${hi}°` : '', window].filter(Boolean).join(', ') + '.';
  const task = first ? ` ${first.task} ${first.late ? 'now' : `by ${clock(first.startBy, tz)}`}.` : '';
  const sunset = sun.sunset ? ` Sunset ${clock(sun.sunset, tz)}.` : '';
  return { title: `Today at ${f.name}`, body: `${bits}${task}${sunset}`, hazard: inc ? inc.hazard : null };
}
/** Every festival that is on whose local clock just reached the hour, once a day. */
export async function sendDigests({ now = Date.now(), hour = process.env.DIGEST_HOUR || 7, festivals = festivalsInWindow(now) } = {}) {
  if (String(hour) === 'off') return [];
  const sent = [];
  for (const f of festivals) {
    let p; try { p = await point(f.latitude, f.longitude); } catch { continue; }
    const tz = p.timeZone, day = localDay(now, tz);
    if (localHour(now, tz) !== Number(hour) || q.setting(`digest:${f.id}`) === day) continue;
    q.setSetting(`digest:${f.id}`, day);
    try {
      const d = await digestFor(f, { now, tz });
      const alert = { id: `digest-${f.id}-${day}`, event: d.title, headline: d.body, body: d.body, instruction: null, severity: 'minor', area: f.location, source: 'Fieldwatch', issuedAt: iso(now), expiresAt: iso(now + 6 * 3_600_000), channel: 'digest', relayCount: 0 };
      const r = await pushAlert(q.tokensFor(f.id), f, alert), w = await pushWeb(f, alert);
      q.count(f.id, 'digest');
      console.log(`[${f.id}] digest: ${d.body} push=${JSON.stringify(r)} web=${JSON.stringify(w)}`);
      sent.push({ festivalId: f.id, ...d });
    } catch (e) { console.error(`[${f.id}] digest failed:`, e.message); }
  }
  return sent;
}
