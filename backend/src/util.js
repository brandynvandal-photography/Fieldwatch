// ISO 8601 without fractional seconds, the shape the iOS decoder likes best.
export const iso = (d = new Date()) => new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
export const daysFromNow = n => new Date(Date.now() + n * 86_400_000);
