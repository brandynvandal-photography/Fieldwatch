import apn from '@parse/node-apn';
import { ttlFor } from './util.js';
import { existsSync } from 'node:fs';
import { q } from './db.js';
import { actionLead } from './webpush.js';
import { PREP, alertHazard } from './incoming.js';

// Push is optional until there is a paid developer account. A missing or placeholder
// key must never stop the server: everything else (packs, alerts, incidents) still works.
let provider = null;
const { APNS_KEY_PATH, APNS_KEY_ID, APNS_TEAM_ID, APNS_BUNDLE_ID } = process.env;
if (APNS_KEY_PATH && APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID) {
  if (!existsSync(APNS_KEY_PATH)) {
    console.log(`APNs not configured; key file ${APNS_KEY_PATH} not found. Alerts are stored but not pushed`);
  } else {
    try {
      provider = new apn.Provider({
        token: { key: APNS_KEY_PATH, keyId: APNS_KEY_ID, teamId: APNS_TEAM_ID },
        production: process.env.APNS_PRODUCTION === 'true',
      });
      console.log('APNs configured');
    } catch (e) {
      console.error('APNs not configured; could not load the key:', e.message);
    }
  }
} else {
  console.log('APNs not configured; alerts are stored but not pushed');
}

// The whole alert rides in the payload so the phone can open it with no network.
export async function pushAlert(tokens, festival, alert) {
  if (!provider || tokens.length === 0) return { sent: 0, skipped: true };
  const note = new apn.Notification();
  note.topic = process.env.APNS_BUNDLE_ID;
  note.pushType = 'alert';
  note.priority = 10;
  note.sound = 'default';
  // The warning's own end is the expiry: a phone with no signal gets it when it is back, never once it is over. One message per alert id.
  note.expiry = Math.floor(Date.now() / 1000) + ttlFor(alert);
  note.collapseId = alert.id;
  note.alert = {
    title: alert.event,
    subtitle: festival.name,
    body: `${actionLead(festival, alert)}${alert.headline || alert.body || ''}`.slice(0, 200),
  };
  note.payload = {
    festivalId: festival.id,
    alert: JSON.stringify({ ...alert, body: (alert.body || '').slice(0, 1500) }),
  };
  const result = await provider.send(note, tokens);
  for (const f of result.failed) {
    if (f.status === '410' || f.response?.reason === 'BadDeviceToken') q.deleteDevice(f.device);
  }
  q.count(festival.id, 'push.apns', result.sent.length); if (result.failed.length) q.count(festival.id, 'push.apns.failed', result.failed.length);
  return { sent: result.sent.length, failed: result.failed.length };
}

/** The warning is over: a quiet note under the same collapse id, so it replaces the loud one, with what to do now. */
export async function pushEnded(tokens, festival, alert, { title = null, why = null } = {}) {
  if (!provider || tokens.length === 0) return { sent: 0, skipped: true };
  if (!(alert.severity === 'extreme' || alert.severity === 'severe')) return { sent: 0, minor: true };
  const hz = alert.hazard || alertHazard(alert.event) || 'storms', after = alert.channel === 'lightning' ? '' : ` ${(PREP[hz] || PREP.storms).after}`;
  const note = new apn.Notification();
  note.topic = process.env.APNS_BUNDLE_ID;
  note.pushType = 'alert';
  note.priority = 5;
  note.expiry = Math.floor(Date.now() / 1000) + 3600;
  note.collapseId = alert.id;
  note.alert = { title: title || `Ended: ${alert.event}`, subtitle: festival.name, body: `${why || `The ${String(alert.event || 'alert').toLowerCase()} has ended.`}${after}`.slice(0, 180) };
  note.payload = { festivalId: festival.id, ended: true, alertId: alert.id };
  const result = await provider.send(note, tokens);
  for (const f of result.failed) {
    if (f.status === '410' || f.response?.reason === 'BadDeviceToken') q.deleteDevice(f.device);
  }
  q.count(festival.id, 'push.apns', result.sent.length); if (result.failed.length) q.count(festival.id, 'push.apns.failed', result.failed.length);
  return { sent: result.sent.length, failed: result.failed.length };
}
