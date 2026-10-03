// The admin key behind the staff screens. ADMIN_KEY in the environment if set; otherwise the server makes one on first
// boot, keeps its hash in the database and prints the key once, so a bare deployment has a working key and no secret to
// come up with. Lost it: set ADMIN_KEY in the variables, or run `npm run admin-key` against the same database (on
// Railway, `railway run npm run admin-key`); a running server reads the new hash on its next request.
import './env.js';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';
import { iso } from './util.js';

export const hashKey = k => createHash('sha256').update(String(k)).digest('hex');
/** Equal, in constant time, and never when either side is missing. */
export const sameKey = (given, expected) => {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given)), b = Buffer.from(String(expected));
  return a.length === b.length && timingSafeEqual(a, b);
};

const stored = () => { try { return JSON.parse(q.setting('admin') || 'null'); } catch { return null; } };
/** Where the key comes from and when it was made; never the key. */
export function adminKeyStatus(envKey = process.env.ADMIN_KEY) {
  if (envKey) return { source: 'environment', madeAt: null };
  const s = stored();
  return s ? { source: 'database', madeAt: s.madeAt || null } : { source: 'none', madeAt: null };
}
/** Is this the admin key: the environment's, else the one whose hash the database holds. */
export function isAdminKey(given, envKey = process.env.ADMIN_KEY) {
  if (!given) return false;
  if (envKey) return sameKey(given, envKey);
  const hash = stored()?.hash;
  return Boolean(hash) && sameKey(hashKey(given), hash);
}
/** A new key in place of whatever the database held, returned once in the clear for the log or the terminal. */
export function resetAdminKey(now = new Date()) {
  const key = randomBytes(24).toString('base64url'), madeAt = iso(now);
  q.setSetting('admin', JSON.stringify({ hash: hashKey(key), madeAt }));
  return { source: 'database', madeAt, key };
}
/** At boot: a key from the environment, or one already made, needs nothing; otherwise make one. */
export const ensureAdminKey = (envKey = process.env.ADMIN_KEY) => (envKey || stored() ? adminKeyStatus(envKey) : resetAdminKey());

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.env.ADMIN_KEY) console.log('ADMIN_KEY is set in the environment, so that is the key. Unset it there to use one from the database.');
  else console.log(`New admin key: ${resetAdminKey().key}\nThe old one no longer works. A running server takes this one from its next request.`);
}
