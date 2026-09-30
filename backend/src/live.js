// A live stream to open pages: when anything lands for a festival (an alert, a heads-up, a lightning code, a staff post, a
// ground report), every page listening hears which festival and what kind, and refreshes it. Server-sent events: one
// long response per page, a comment every 25 seconds to keep proxies from closing it, and the browser reconnects itself.
import { EventEmitter } from 'node:events';
import { iso } from './util.js';

export const live = new EventEmitter();
live.setMaxListeners(0);
/** Something changed for a festival. */
export const changed = (festivalId, kind) => live.emit('change', { festivalId, kind, at: iso() });
export const liveCount = () => live.listenerCount('change');

export function sse(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.write('retry: 5000\n: hello\n\n');
  const only = req.query?.f ? String(req.query.f) : null;
  const send = e => { if (!only || e.festivalId === only) res.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`); };
  live.on('change', send);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => { clearInterval(ping); live.off('change', send); });   // the connection went away (req 'close' fires as soon as the empty body is read)
}
