// The service worker, run in a sandbox: what it keeps, what it lets go, and what a late warning says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SCOPE = 'https://example.test/Fieldwatch/';
function boot() {
  const key = k => typeof k === 'string' ? new URL(k, SCOPE + 'sw.js').href : k.url;
  const mkCache = () => { const m = new Map(); return { m, match: async k => (m.get(key(k)) ? m.get(key(k)).clone() : undefined), put: async (k, r) => { m.set(key(k), r); }, keys: async () => [...m.keys()].map(u => ({ url: u })), delete: async k => m.delete(key(k)), addAll: async () => {} }; };
  const stores = new Map();
  const caches = { open: async n => { if (!stores.has(n)) stores.set(n, mkCache()); return stores.get(n); }, keys: async () => [...stores.keys()], delete: async n => stores.delete(n),
    match: async k => { for (const c of stores.values()) { const r = await c.match(k); if (r) return r; } } };
  const shown = [], on = {}, posted = [];
  const self = { addEventListener: (t, fn) => { on[t] = fn; }, registration: { showNotification: async (title, opts) => { shown.push({ title, ...opts }); } }, clients: { claim: async () => {}, matchAll: async () => [{ postMessage: m => posted.push(m) }] }, skipWaiting: () => {}, location: new URL(SCOPE + 'sw.js') };
  const ctx = { self, caches, location: self.location, fetches: [], answer: async () => new Response('png', { status: 200, headers: { 'content-type': 'image/png' } }), Response, Request, URL, console };
  ctx.fetch = async (...a) => { ctx.fetches.push(a); return ctx.answer(...a); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  const fire = async (type, ev) => { const waits = []; let out; ev.waitUntil = p => waits.push(p); ev.respondWith = p => { out = p; }; on[type](ev); await Promise.all(waits); return out ? await out : undefined; };
  return { ctx, caches, stores, shown, posted, fire };
}

test('a warning the push service held past its end says so, carries when it was issued, and its alert is kept for the screen', async () => {
  const { shown, caches, fire } = boot();
  const alert = { id: 'urn:oid:2.49.0.1.840.0.late', event: 'Severe Thunderstorm Warning', body: 'Wind 60 mph.' };
  const late = { title: 'Severe Thunderstorm Warning', body: 'Suwannee Hulaween. Get into a vehicle or building.', tag: alert.id, urgent: true, issuedAt: '2026-10-23T17:02:00Z', expiresAt: new Date(Date.now() - 20 * 60000).toISOString(), url: './?f=hulaween-2026', alert };
  await fire('push', { data: { json: () => late } });
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Ended: Severe Thunderstorm Warning');
  assert.match(shown[0].body, /^Delivered late\. It ended at \d{1,2}:\d\d/);
  assert.equal(shown[0].requireInteraction, false, 'late is not urgent'); assert.equal(shown[0].renotify, false);
  assert.equal(shown[0].timestamp, Date.parse(late.issuedAt));
  const kept = await caches.match(`./alert/${encodeURIComponent(alert.id)}`);
  assert.deepEqual(await kept.json(), alert, 'the alert the push carried is on the phone, keyed for the alert screen');
  // One that is current: as loud as before, with the title as sent.
  const now = { ...late, expiresAt: new Date(Date.now() + 30 * 60000).toISOString(), alert: { ...alert, id: 'urn:oid:now' } };
  await fire('push', { data: { json: () => now } });
  assert.equal(shown[1].title, 'Severe Thunderstorm Warning'); assert.equal(shown[1].requireInteraction, true); assert.equal(shown[1].body, now.body);
  assert.ok(await caches.match('./alert/urn%3Aoid%3Anow'));
  // Text that is not JSON still shows, and no timestamp is made up.
  await fire('push', { data: { json: () => { throw new Error('nope'); }, text: () => 'plain' } });
  assert.equal(shown[2].title, 'Fieldwatch'); assert.equal(shown[2].body, 'plain'); assert.equal('timestamp' in shown[2], false);
});

test('radar frames and tiles are kept once seen, served from the copy, and the oldest go past the cap; an opaque answer is shown but not kept', async () => {
  const { ctx, stores, fire } = boot();
  const frame = t => `https://fieldwatch.example.test/radar/hulaween-2026/${t}.png`;
  const r1 = await fire('fetch', { request: new Request(frame('202610231700Z')) });
  assert.equal(await r1.text(), 'png');
  assert.equal(ctx.fetches.length, 1); assert.equal(ctx.fetches[0][0], frame('202610231700Z')); assert.equal(ctx.fetches[0][1].mode, 'cors', 'fetched with CORS so the copy is not opaque');
  const r2 = await fire('fetch', { request: new Request(frame('202610231700Z')) });
  assert.equal(await r2.text(), 'png'); assert.equal(ctx.fetches.length, 1, 'the second time is the copy');
  await fire('fetch', { request: new Request('https://mesonet.agron.iastate.edu/cgi-bin/wms/nexrad/n0q-t.cgi?LAYERS=nexrad-n0q-wmst&TIME=2026-10-23T17:00:00Z') });
  await fire('fetch', { request: new Request('https://tile.openstreetmap.org/8/68/107.png') });
  const radar = stores.get('fieldwatch-radar-v1');
  assert.equal(radar.m.size, 3, 'the archive frame and the tile are kept beside the backend frame');
  for (let i = 0; i < 200; i++) await fire('fetch', { request: new Request(frame(`t${i}`)) });
  assert.equal(radar.m.size, 200, 'the cap holds');
  assert.equal(radar.m.has(frame('202610231700Z')), false, 'the oldest went first');
  assert.ok(radar.m.has(frame('t199')));
  // A server with no CORS header: the picture shows through a plain fetch and nothing is kept.
  ctx.answer = (url, opts) => { if (opts && opts.mode === 'cors') throw new TypeError('cors'); return new Response('opaque-ish', { status: 200 }); };
  const r3 = await fire('fetch', { request: new Request('https://tile.openstreetmap.org/8/69/107.png') });
  assert.equal(await r3.text(), 'opaque-ish'); assert.equal(radar.m.has('https://tile.openstreetmap.org/8/69/107.png'), false);
  // A frame the archive does not have yet is a 404 to the page, not an error.
  ctx.answer = async () => new Response('', { status: 404 });
  assert.equal((await fire('fetch', { request: new Request(frame('future')) })).status, 404);
  assert.equal(radar.m.has(frame('future')), false);
  // Weather is not this cache's business.
  assert.equal(await fire('fetch', { request: new Request('https://api.weather.gov/alerts/active?point=1,2') }), undefined);
});

test('activating a new worker clears an old shell and keeps the radar and the alerts', async () => {
  const { caches, fire } = boot();
  for (const n of ['fieldwatch-shell-v1', 'fieldwatch-shell-v2', 'fieldwatch-radar-v1', 'fieldwatch-alerts-v1']) await caches.open(n);
  await fire('activate', {});
  assert.deepEqual((await caches.keys()).sort(), ['fieldwatch-alerts-v1', 'fieldwatch-radar-v1', 'fieldwatch-shell-v2']);
});

test('the shell answers from its copy at once, the network refreshes it behind, a changed page is announced, and no signal still opens the app', async () => {
  const { ctx, posted, stores, fire } = boot();
  const page = (body, etag) => new Response(body, { status: 200, headers: { 'content-type': 'text/html', etag } });
  ctx.answer = async () => page('<html>one</html>', '"v1"');
  const r1 = await fire('fetch', { request: new Request(SCOPE + 'index.html') });
  assert.equal(await r1.text(), '<html>one</html>', 'nothing kept yet: the network answers');
  await new Promise(r => setTimeout(r, 5));
  const shellCache = stores.get('fieldwatch-shell-v2');
  assert.ok(shellCache.m.has(SCOPE + 'index.html'), 'and the copy is kept');
  // The same page again, now from the copy, while the network says it has not changed: nobody is told anything.
  ctx.fetches.length = 0;
  const r2 = await fire('fetch', { request: new Request(SCOPE + 'index.html?f=hulaween-2026&alert=x') });
  assert.equal(await r2.text(), '<html>one</html>', 'the copy answers, whatever the query');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(ctx.fetches.length, 1, 'the network was asked behind it'); assert.deepEqual(posted, []);
  // A new build behind the copy: the copy still answers, the fresh one is kept, and every open page hears.
  ctx.answer = async () => page('<html>two</html>', '"v2"');
  const r3 = await fire('fetch', { request: new Request(SCOPE) });
  assert.equal(await r3.text(), '<html>one</html>', 'the page that opened is the one that opened');
  await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(posted.map(m => ({ ...m })), [{ type: 'updated' }]);
  assert.equal(await (await shellCache.match(SCOPE + 'index.html')).text(), '<html>two</html>', 'the next open gets the new build');
  // A data file changing is not an update of the app.
  ctx.answer = async () => page('[]', '"d1"');
  await fire('fetch', { request: new Request(SCOPE + 'festivals.json') });
  ctx.answer = async () => page('[{}]', '"d2"');
  await fire('fetch', { request: new Request(SCOPE + 'festivals.json') }); await new Promise(r => setTimeout(r, 5));
  assert.equal(posted.length, 1);
  // No signal: the copy, and for a page never seen, the app itself.
  ctx.answer = async () => { throw new TypeError('Failed to fetch'); };
  assert.equal(await (await fire('fetch', { request: new Request(SCOPE + 'index.html') })).text(), '<html>two</html>');
  assert.equal(await (await fire('fetch', { request: new Request(SCOPE + 'somewhere') })).text(), '<html>two</html>', 'an unknown path opens the app rather than failing');
});

test('a warning that ended comes as a quiet notification under the same tag, so it replaces the loud one', async () => {
  const { shown, fire } = boot();
  await fire('push', { data: { json: () => ({ title: 'Ended: Severe Thunderstorm Warning', body: 'Suwannee Hulaween. The severe thunderstorm warning has ended. Wait thirty minutes after the last thunder before going back out.', tag: 'urn:oid:x', urgent: false, ended: true, issuedAt: '2026-10-23T18:00:00Z', expiresAt: null, url: './?f=hulaween-2026&alert=urn%3Aoid%3Ax' }) } });
  assert.equal(shown[0].title, 'Ended: Severe Thunderstorm Warning'); assert.equal(shown[0].tag, 'urn:oid:x'); assert.equal(shown[0].requireInteraction, false); assert.equal(shown[0].renotify, false); assert.deepEqual([...shown[0].vibrate], [200]);
});
