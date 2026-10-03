// Your own list, kept anywhere that serves a file: a Google Sheet published to the web as CSV,
// a JSON file in a repository. FESTIVAL_FEEDS is a comma-separated list of URLs, fetched on the
// same schedule as the other imports. Rows are trusted (it is your sheet) but still validated.
import { q } from '../db.js';
import { normalizeFestival, slug } from '../festivals.js';
import { USER_AGENT } from '../site.js';

export function parseCSV(text) {
  const rows = []; let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += ch; continue; }
    if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const [head, ...body] = rows.filter(r => r.some(c => c.trim() !== ''));
  if (!head) return [];
  const keys = head.map(h => h.trim().replace(/^﻿/, ''));
  return body.map(r => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// Column names people actually type in a sheet, in any case, onto the record's own.
const ALIASES = { festival: 'name', where: 'location', place: 'location', venue: 'location', lat: 'latitude', lon: 'longitude', lng: 'longitude', long: 'longitude',
  start: 'startDate', startdate: 'startDate', 'start date': 'startDate', 'first day': 'startDate', end: 'endDate', enddate: 'endDate', 'end date': 'endDate', 'last day': 'endDate',
  url: 'website', link: 'website', verifiedon: 'verifiedOn', ispartner: 'isPartner' };
for (const k of ['id', 'name', 'location', 'latitude', 'longitude', 'website', 'county', 'featured', 'source', 'note', 'feeds', 'site']) ALIASES[k] = k;

/** Rows from a CSV or a JSON array, with sheet-style column names mapped onto the record's. */
export function recordsFrom(text) {
  const t = String(text).trim();
  const raw = t.startsWith('[') || t.startsWith('{') ? [].concat(JSON.parse(t)) : parseCSV(t);
  return raw.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [ALIASES[k.trim().toLowerCase()] || k.trim(), v])));
}

export async function importFeeds({ urls = (process.env.FESTIVAL_FEEDS || '').split(',').map(s => s.trim()).filter(Boolean), fetchImpl = globalThis.fetch, log = console } = {}) {
  if (!urls.length) return { skipped: 'FESTIVAL_FEEDS not set' };
  const report = { feeds: urls.length, rows: 0, saved: 0, rejected: [] };
  for (const u of urls) {
    let text;
    try {
      const res = await fetchImpl(u, { headers: { 'User-Agent': USER_AGENT } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (e) { log.error(`feed ${u}: ${e.message}`); report.rejected.push({ feed: u, error: e.message }); continue; }
    let records;
    try { records = recordsFrom(text); } catch (e) { report.rejected.push({ feed: u, error: `unreadable: ${e.message}` }); continue; }
    for (const r of records) {
      report.rows++;
      const { festival, error } = normalizeFestival(r, { origin: 'feed', id: 'pending-id' });
      if (error) { report.rejected.push({ name: r.name || null, error }); continue; }
      festival.id = r.id || `feed-${slug(festival.name)}-${festival.startDate.slice(0, 4)}`;
      const old = q.festival(festival.id);
      q.upsertFestival(old ? { ...old, ...festival, origin: old.origin, status: old.status } : festival);
      report.saved++;
    }
  }
  return report;
}
