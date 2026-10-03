// Browser push for the web build: the same warnings APNs carries, delivered to a Home Screen web
// app (iOS 16.4+, Android, desktop) over the Web Push protocol. The VAPID key pair comes from
// VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY if set; otherwise the server makes one on first boot and
// keeps it in the database, so a deploy with a volume needs no setup at all. Advisories are not
// pushed; warnings, watches and staff posts are.
import webpush from 'web-push';
import { q } from './db.js';

let PUBLIC = process.env.VAPID_PUBLIC_KEY || '', PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const SUBJECT = process.env.VAPID_SUBJECT || 'https://brandynvandal-photography.github.io/Fieldwatch/';
const SITE = (process.env.SITE_URL || 'https://brandynvandal-photography.github.io/Fieldwatch/').replace(/\/?$/, '/');
let enabled = false, source = 'environment';
if (!(PUBLIC && PRIVATE)) {
  const stored = q.setting('vapid');
  if (stored) { ({ publicKey: PUBLIC, privateKey: PRIVATE } = JSON.parse(stored)); source = 'database'; }
  else {
    const k = webpush.generateVAPIDKeys();
    q.setSetting('vapid', JSON.stringify(k));
    PUBLIC = k.publicKey; PRIVATE = k.privateKey; source = 'database, made just now';
    console.log(`Web push keys made; they live in the database at ${process.env.DB_PATH || 'fieldwatch.db'}. Keep that on a volume (or set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY): a fresh pair after a redeploy means every phone must open the app once to register again.`);
  }
}
try { webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE); enabled = true; console.log(`Web push configured (keys from the ${source})`); }
catch (e) { console.error('Web push not configured; bad VAPID keys:', e.message); }

export const webPushEnabled = () => enabled;
export const vapidPublicKey = () => (enabled ? PUBLIC : null);
export const validSubscription = s => Boolean(s && typeof s.endpoint === 'string' && /^https:\/\/\S+$/.test(s.endpoint) && s.endpoint.length < 2048
  && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string');

let transport = (subscription, payload, options) => webpush.sendNotification(subscription, payload, options);
/** Tests swap the wire for a fake. */
export const setWebPushTransport = fn => { transport = fn; };

const worthPushing = a => a.channel !== 'weather' || ['extreme', 'severe', 'moderate'].includes(a.severity);

/** One notification to the browser that just subscribed, so the person sees the chain work before any warning does. */
export async function pushWelcome(subscription, festival) {
  if (!enabled || !festival) return { sent: 0 };
  const here = festival.id === 'here';
  const payload = JSON.stringify({
    title: 'Warnings are on', body: here ? 'For wherever this phone is. Warnings and watches show up here even with the app closed.'
      : `${festival.name}. Warnings, watches and staff posts show up here even with the app closed.`,
    tag: 'welcome', urgent: false, url: here ? `${SITE}?here=1` : `${SITE}?f=${encodeURIComponent(festival.id)}`,
  });
  try { await transport(subscription, payload, { TTL: 600, urgency: 'normal' }); return { sent: 1 }; }
  catch (e) { return { sent: 0, error: e?.statusCode || e?.message || String(e) }; }
}

/**
 * One notification to every browser subscribed to this festival, or, for a point (a phone following
 * wherever it is, festival.id 'here'), to every browser at that point. Dead subscriptions are dropped.
 */
/** Whole sentences up to a length, so a notification never ends mid-word; the first sentence always, cut if it must be. */
export function sentences(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1).lastIndexOf('. ');
  return cut > 0 ? text.slice(0, cut + 1) : text.slice(0, max);
}
export async function pushWeb(festival, alert) {
  if (!enabled) return { sent: 0, skipped: true };
  if (!worthPushing(alert)) return { sent: 0, minor: true };
  const here = festival.id === 'here';
  const subs = here ? q.webSubscriptionsAt(festival.latitude, festival.longitude) : q.webSubscriptionsFor(festival.id);
  if (!subs.length) return { sent: 0 };
  const urgent = alert.severity === 'extreme' || alert.severity === 'severe';
  const payload = JSON.stringify({
    title: alert.event,
    body: `${festival.name}. ${sentences(String(alert.headline || alert.body || '').replace(/\s+/g, ' '), 160)}`,
    tag: alert.id, urgent, severity: alert.severity,
    url: here ? `${SITE}?here=1&alert=${encodeURIComponent(alert.id)}` : `${SITE}?f=${encodeURIComponent(festival.id)}&alert=${encodeURIComponent(alert.id)}`,
  });
  let sent = 0, gone = 0, failed = 0;
  await Promise.all(subs.map(async ({ endpoint, subscription }) => {
    try { await transport(subscription, payload, { TTL: 6 * 3600, urgency: urgent ? 'high' : 'normal' }); sent++; }
    catch (e) {
      // 404/410: the browser let the subscription go. 401/403: it was made against other keys; it can never work again.
      if (e && [401, 403, 404, 410].includes(e.statusCode)) { q.deleteWebSubscription(endpoint); gone++; }
      else { failed++; console.error(`[${festival.id}] web push failed: ${e?.statusCode || ''} ${e?.message || e}`); }
    }
  }));
  q.count(festival.id, 'push.web', sent);
  return { sent, gone, failed };
}
