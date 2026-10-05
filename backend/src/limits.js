// One rate limit for everything a stranger can write: per address, a window, a cap, and a 429 that says so. The same
// map serves every route, so an operator reads one number in /health and a test clears one thing.
const hits = new Map();
export function limited(name, ip, max, windowMs, now = Date.now()) {
  const k = `${name}|${ip}`, recent = (hits.get(k) || []).filter(t => now - t < windowMs);
  if (recent.length >= max) { hits.set(k, recent); return true; }
  recent.push(now); hits.set(k, recent);
  return false;
}
/** Express middleware: `max` writes per `windowMs` from one address, named for the error. */
export const limit = (name, max, windowMs, what) => (req, res, next) => (limited(name, req.ip, max, windowMs) ? res.status(429).json({ error: `too many ${what}, try again later` }) : next());
export const resetLimits = () => hits.clear();
/** Addresses with nothing in the last hour are forgotten (housekeeping). */
export function pruneLimits(now = Date.now()) { let n = 0; for (const [k, v] of hits) if (!v.some(t => now - t < 3_600_000)) { hits.delete(k); n++; } return n; }
export const limitStatus = () => ({ tracked: hits.size });
