// Fieldwatch service worker: the app shell opens with no signal, and an update lands on the next refresh.
// Weather, radar and tiles are never cached here; the page keeps its own copy of the last good data.
const CACHE = 'fieldwatch-shell-v2';
const SHELL = ['./', './index.html', './festivals.json', './manifest.webmanifest', './icon.svg', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
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
  const urgent = !!d.urgent;
  e.waitUntil(self.registration.showNotification(d.title || 'Fieldwatch', {
    body: d.body || '', tag: d.tag || undefined, renotify: urgent, requireInteraction: urgent,
    icon: './icon-192.png', badge: './icon-192.png', vibrate: urgent ? [300, 100, 300, 100, 600] : [200],
    data: { url: d.url || './' },
  }));
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
