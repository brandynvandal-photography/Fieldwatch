// A live stream to open pages: when anything lands for a festival (an alert, a heads-up, a lightning code, a staff post, a
// ground report), every page listening hears which festival and what kind, and refreshes it. Server-sent events: one
// long response per page, a comment every 25 seconds to keep proxies from closing it, and the browser reconnects itself.
import { EventEmitter } from 'node:events';
import { iso } from './util.js';

export const live = new EventEmitter();
live.setMaxListeners(0);
// Every event is numbered and the last few hundred are kept: a page that reconnects says where it left off (Last-Event-ID, the
// browser sends it by itself) and hears what it missed while the signal was out, instead of refreshing blind or not at all.
const recent = []; let seq = 0; const KEEP = 500;
/** Something changed for a festival. */
export const changed = (festivalId, kind) => { const e = { id: ++seq, festivalId, kind, at: iso() }; recent.push(e); if (recent.length > KEEP) recent.shift(); live.emit('change', e); };
export const liveCount = () => live.listenerCount('change');
export const lastEventId = () => seq;

export function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n: hello\n\n');
  const only = req.query?.f ? String(req.query.f) : null;
  const line = e => `id: ${e.id}\nevent: change\ndata: ${JSON.stringify({ festivalId: e.festivalId, kind: e.kind, at: e.at })}\n\n`;
  const send = e => { if (!only || e.festivalId === only) res.write(line(e)); };
  const since = Number(req.headers['last-event-id'] || 0);
  if (Number.isFinite(since) && since > 0) for (const e of recent) if (e.id > since) send(e);
  live.on('change', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); live.off('change', send); });   // the connection went away (req 'close' fires as soon as the empty body is read)
}
