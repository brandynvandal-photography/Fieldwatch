// Browser push for the web build: the same warnings APNs carries, delivered to a Home Screen web
// app (iOS 16.4+, Android, desktop) over the Web Push protocol. Needs a VAPID key pair
// (npm run vapid) in VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY; without one the routes answer 404
// and the web build hides its switch. Advisories are not pushed; warnings, watches and staff posts are.
import webpush from 'web-push';
import { q } from './db.js';

const PUBLIC = process.env.VAPID_PUBLIC_KEY || '', PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'https://brandynvandal-photography.github.io/Fieldwatch/';
const SITE = (process.env.SITE_URL || 'https://brandynvandal-photography.github.io/Fieldwatch/').replace(/\/?$/, '/');
let enabled = false;
if (PUBLIC && PRIVATE) {
  try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); enabled = true; console.log('Web push configured'); }
  catch (e) { console.error('Web push not configured; bad VAPID keys:', e.message); }
} else {
  console.log('Web push not configured (VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY); the web build cannot subscribe');
}

export const webPushEnabled = () => enabled;
export const vapidPublicKey = () => (enabled ? PUBLIC : null);
export const validSubscription = s => Boolean(s && typeof s.endpoint === 'string' && /^https:\/\/\S+$/.test(s.endpoint) && s.endpoint.length < 2048
  && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');

let transport = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
/** Tests swap the wire for a fake. */
export const setWebPushTransport = fn => { transport = fn; };

const worthPushing = a => a.channel !== 'weather' || ['extreme', 'severe', 'moderate'].includes(a.severity);

/** One notification to every browser subscribed to this festival. Dead subscriptions are dropped. */
export async function pushWeb(festival, alert) {
  if (!enabled) return { sent: 0, skipped: true };
  if (!worthPushing(alert)) return { sent: 0, minor: true };
  const subs = q.webSubscriptionsFor(festival.id);
  if (!subs.length) return { sent: 0 };
  const urgent = alert.severity === 'extreme' || alert.severity === 'severe';
  const payload = JSON.stringify({
    title: alert.event,
    body: `${festival.name}. ${String(alert.headline || alert.body || '').replace(/\s+/g, ' ').slice(0, 160)}`,
    tag: alert.id, urgent, severity: alert.severity,
    url: `${SITE}?f=${encodeURIComponent(festival.id)}&alert=${encodeURIComponent(alert.id)}`,
  });
  let sent = 0, gone = 0, failed = 0;
  await Promise.all(subs.map(async ({ endpoint, subscription }) => {
    try { await transport(subscription, payload, { TTL: 6 * 3600, urgency: urgent ? 'high' : 'normal' }); sent++; }
    catch (e) {
      if (e && (e.statusCode === 404 || e.statusCode === 410)) { q.deleteWebSubscription(endpoint); gone++; }
      else { failed++; console.error(`[${festival.id}] web push failed: ${e?.statusCode || ''} ${e?.message || e}`); }
    }
  }));
  return { sent, gone, failed };
}
