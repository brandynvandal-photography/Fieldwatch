// Fieldwatch service worker: the app shell opens with no signal, and an update lands on the next refresh.
// Weather is never cached here; the page keeps its own copy of the last good data. Radar frames and the map under them are kept,
// newest in and oldest out, so the loop from before the signal dropped still plays. The alert a warning carries is kept too,
// so the alert screen opens on it with nothing else loaded.
const CACHE = 'fieldwatch-shell-v2', RADAR = 'fieldwatch-radar-v1', ALERTS = 'fieldwatch-alerts-v1', KEEP = [CACHE, RADAR, ALERTS];
const RADAR_MAX = 200;    // frames and tiles kept: twelve hours at five-minute steps and the map tiles under them
const ALERTS_MAX = 50;
const SHELL = ['./', './index.html', './festivals.json', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !KEEP.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

/** A radar frame from the backend or the archive, or a map tile: a picture of one moment never changes, so the copy is the answer. */
const isRadar = url => /\/radar\/[^/]+\/[^/]+\.png$/.test(url.pathname) || (url.hostname === 'mesonet.agron.iastate.edu' && /nexrad-n0q-wmst/.test(url.search)) || url.hostname === 'tile.openstreetmap.org';
async function trim(c, max) { const keys = await c.keys(); for (const k of keys.slice(0, Math.max(0, keys.length - max))) await c.delete(k); }
async function radarFrame(req) {
  const c = await caches.open(RADAR), hit = await c.match(req.url);
  if (hit) return hit;
  let r = null;
  try { r = await fetch(req.url, { mode: 'cors' }); } catch (err) {}
  // Kept only when the server lets us see the response: an opaque copy would count against the quota many times its size.
  if (r && r.ok && r.type !== 'opaque') { try { await c.put(req.url, r.clone()); await trim(c, RADAR_MAX); } catch (err) {} return r; }
  return r || fetch(req);
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (isRadar(url)) { e.respondWith(radarFrame(e.request)); return; }
  if (url.origin === location.origin) {
    // Network first so a deploy shows up in one refresh; the cache answers when there is no signal.
    e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html'))));
    return;
  }
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    // Fonts change rarely; serve what we have and refresh in the background.
    e.respondWith(caches.open(CACHE).then(async c => { const hit = await c.match(e.request); const net = fetch(e.request).then(r => { c.put(e.request, r.clone()); return r; }).catch(() => hit); return hit || net; }));
  }
});

// Warnings arrive here when the app is closed. The payload is what backend/src/webpush.js sends.
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (err) { d = { title: 'Fieldwatch', body: e.data ? e.data.text() : '' }; }
  // Held by the push service past the end of the warning: it says so, and it does not alarm anyone.
  const ended = Boolean(d.expiresAt) && Date.parse(d.expiresAt) < Date.now();
  const urgent = !!d.urgent && !ended;
  const at = t => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const title = ended ? `Ended: ${d.title || 'alert'}` : (d.title || 'Fieldwatch');
  const body = ended ? `Delivered late. It ended at ${at(d.expiresAt)}.${d.body ? ` ${d.body}` : ''}` : (d.body || '');
  const issued = d.issuedAt ? Date.parse(d.issuedAt) : NaN;
  const work = [self.registration.showNotification(title, {
    body, tag: d.tag || undefined, renotify: urgent, requireInteraction: urgent,
    icon: './icon-192.png', badge: './icon-192.png', vibrate: urgent ? [300, 100, 300, 100, 600] : [200],
    ...(Number.isFinite(issued) ? { timestamp: issued } : {}),   // the notification shows when the warning was issued, not when the phone heard
    data: { url: d.url || './' },
  })];
  if (d.alert && d.alert.id) {
    work.push(caches.open(ALERTS).then(async c => { await c.put(`./alert/${encodeURIComponent(d.alert.id)}`, new Response(JSON.stringify(d.alert), { headers: { 'Content-Type': 'application/json' } })); await trim(c, ALERTS_MAX); }).catch(() => {}));
  }
  e.waitUntil(Promise.all(work));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || './', self.location.href).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const open = list.find(c => 'focus' in c);
    if (open) return (open.navigate ? open.navigate(url) : Promise.resolve(open)).then(c => (c || open).focus());
    return self.clients.openWindow(url);
  }));
});
