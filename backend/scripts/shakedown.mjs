#!/usr/bin/env node
// One pass over a running backend, from any machine: node scripts/shakedown.mjs https://host [ADMIN_KEY]
// Reads /health, every festival that is on (alerts, lightning, radar, ground, nowcast), holds the live stream open for
// half a minute, and with the key the usage counters and the last import. docs/shakedown.md says what good looks like.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ago = t => { const m = Math.round((Date.now() - Date.parse(t)) / 60_000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
const summarize = {
  alerts: v => `${v.length} active${v.length ? ': ' + v.map(a => a.event).join(', ') : ''}`,
  lightning: v => `${v.code || 'none'}${v.on === false ? ' (off)' : ''}${v.dataAt ? `, data ${ago(v.dataAt)}` : ', no data'}${v.nearestMi != null ? `, nearest ${v.nearestMi} mi` : ''}`,
  radar: v => `${(v.frames || []).length} frames${v.newestAt ? `, newest ${ago(v.newestAt)}` : ''}`,
  ground: v => `${v.surface || '?'} (${v.surfaceSource || '?'}), soil ${v.soil || '?'} (${v.soilSource || '?'})${v.indoor === true ? ', indoors' : ''}${v.lookupError ? `, error: ${v.lookupError}` : ''}${v.past && v.past.in48 != null ? `, ${v.past.in48} in of rain in 48 h` : ''}`,
  nowcast: v => v.minutes != null ? `rain in ${v.minutes} min${v.heading ? ` from the ${v.heading}` : ''}` : v.tracked ? 'tracked, nothing on the way' : `not tracked${v.reason ? ` (${v.reason})` : ''}`,
};

/** Hold /events open for `ms` and count what came down it. */
export async function liveCheck(base, { fetchImpl = globalThis.fetch, ms = 30_000 } = {}) {
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
  let text = '', opened = false;
  try {
    const r = await fetchImpl(`${base}/events`, { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
    opened = r.ok;
    const reader = r.body.getReader(), dec = new TextDecoder();
    for (;;) { const { value, done } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  } catch (e) { if (e.name !== 'AbortError') return { opened, error: e.message }; }
  finally { clearTimeout(timer); }
  return { opened, seconds: Math.round(ms / 1000), hello: /: hello/.test(text), pings: (text.match(/^: ping/gm) || []).length, changes: (text.match(/^event: change/gm) || []).length };
}

export async function shakedown(base, { key = '', fetchImpl = globalThis.fetch, sseMs = 30_000, max = 12 } = {}) {
  base = base.replace(/\/$/, '');
  const get = async (path, headers = {}) => { const r = await fetchImpl(`${base}${path}`, { headers: { Accept: 'application/json', ...headers } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
  const report = { base, at: new Date().toISOString(), health: null, festivals: [], live: null, admin: null, errors: [] };
  try { report.health = await get('/health'); } catch (e) { report.errors.push(`health: ${e.message}`); return report; }
  let on = [];
  try { on = await get('/festivals'); } catch (e) { report.errors.push(`festivals: ${e.message}`); }
  for (const f of on.slice(0, max)) {
    const row = { id: f.id, name: f.name };
    for (const k of Object.keys(summarize)) {
      try { row[k] = summarize[k](await get(`/festivals/${encodeURIComponent(f.id)}/${k}`)); } catch (e) { row[k] = `error: ${e.message}`; }
    }
    report.festivals.push(row);
  }
  report.live = await liveCheck(base, { fetchImpl, ms: sseMs });
  if (key) {
    try { report.admin = { stats: await get('/admin/stats?days=7', { 'x-admin-key': key }), imports: await get('/admin/import', { 'x-admin-key': key }) }; }
    catch (e) { report.errors.push(`admin: ${e.message}`); }
  }
  return report;
}

function print(r) {
  const h = r.health;
  console.log(`${r.base} at ${r.at}`);
  if (!h) { console.log(`  ${r.errors.join('; ')}`); return; }
  console.log(`  health: ${h.ok ? 'ok' : 'PROBLEMS'}${h.build ? `, build ${h.build}` : ''}, up ${Math.round(h.uptimeSeconds / 60)} min, ${h.festivals} festivals, database ${h.database?.onVolume ? 'on a volume' : 'NOT on a volume'}`);
  for (const p of h.problems || []) console.log(`  PROBLEM: ${p}`);
  for (const w of h.warnings || []) console.log(`  warning: ${w}`);
  const l = h.lightning || {};
  console.log(`  lightning: ${l.on ? 'on' : 'off'}, ${l.files || 0} files, ${l.flashes || 0} flashes in the buffer${l.lastFileAt ? `, last file ${ago(l.lastFileAt)}` : ''}`);
  for (const b of l.buckets || []) console.log(`    ${b.bucket}: ${b.files} files${b.lastError ? `, error: ${b.lastError}` : ''}`);
  console.log(`  polling: ${h.polling?.lastOkAt ? `ok ${ago(h.polling.lastOkAt)}` : 'no successful poll yet'}${h.polling?.lastError ? `, last error: ${h.polling.lastError}` : ''}`);
  console.log(`  radar: ${h.radar?.festivals ?? 0} loops${h.radar?.lastError ? `, error: ${h.radar.lastError}` : ''}; backups: ${h.backups?.count ?? 0}${h.backups?.newest ? `, newest ${h.backups.newest}` : ''}`);
  console.log(`  sources: ${Object.entries(h.sources || {}).map(([k, v]) => `${k} ${v === true || v === 'on' ? 'on' : 'off'}`).join(', ')}`);
  for (const f of r.festivals) { console.log(`  ${f.name} (${f.id})`); for (const k of Object.keys(summarize)) console.log(`    ${k}: ${f[k]}`); }
  if (r.live) console.log(`  live stream: ${r.live.opened ? `open for ${r.live.seconds} s, hello ${r.live.hello ? 'yes' : 'NO'}, ${r.live.pings} pings, ${r.live.changes} changes` : `did not open${r.live.error ? ` (${r.live.error})` : ''}`}`);
  if (r.admin) {
    const t = r.admin.stats.totals || {};
    console.log(`  last 7 days: ${t.pack || 0} packs, ${t.alerts || 0} alert lists, ${t['alert.new'] || 0} alerts stored, ${(t['push.web'] || 0) + (t['push.apns'] || 0)} pushes, ${t.headsup || 0} heads-ups, ${t.follow || 0} follows${r.admin.stats.alertLatencySeconds != null ? `, alert latency ${r.admin.stats.alertLatencySeconds} s` : ''}`);
    const im = r.admin.imports; console.log(`  last import: ${im.never ? 'never' : im.startedAt}${im.running ? ' (running)' : ''}`);
  }
  for (const e of r.errors) console.log(`  error: ${e}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const [base, key] = process.argv.slice(2);
  if (!base) { console.error('usage: node scripts/shakedown.mjs https://host [ADMIN_KEY]'); process.exit(2); }
  print(await shakedown(base, { key }));
}
