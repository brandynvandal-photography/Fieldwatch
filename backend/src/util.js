// ISO 8601 without fractional seconds, the shape the iOS decoder likes best.
export const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const daysFromNow = n => new Date(Date.now() + n * 86_400_000);
/** How long a push may wait for a phone with no signal: until the alert's own end, five minutes at the least and six hours at the most. */
export const ttlFor = (alert, now = Date.now()) => { const left = alert && alert.expiresAt ? (Date.parse(alert.expiresAt) - now) / 1000 : NaN; return Number.isFinite(left) ? Math.min(6 * 3600, Math.max(300, Math.round(left))) : 6 * 3600; };
