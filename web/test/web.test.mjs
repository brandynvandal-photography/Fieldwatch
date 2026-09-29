// Drives the web client in headless Chromium against fixture responses for the National Weather
// Service, the radar archive and the tile server, so it runs anywhere with no network.
//   npm test                      (CHROMIUM=/path/to/chrome to point at another build)
//   SHOTS=./shots npm test        also saves phone-sized screenshots of each screen
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { chromium } from 'playwright-core';
import { alertFeature, points, hourly } from '../../backend/test/fixtures/nws.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
// The real list, shifted so that Suwannee Hulaween is in its second day right now: the page lists only what is on,
// from a week before gates (early entry, vendors, build crews) to the day after the end, like backend/src/festivals.js.
const DAY = 86400000, LEAD_DAYS = 7, TAIL_DAYS = 1;
const isLive = (f, now = Date.now()) => now >= ((f.groundsOpen && Date.parse(f.groundsOpen)) || Date.parse(f.startDate) - LEAD_DAYS * DAY) && now <= Date.parse(f.endDate) + TAIL_DAYS * DAY;
const real = JSON.parse(readFileSync(join(root, 'festivals.json'), 'utf8'));
const SHIFT = Date.now() - DAY - Date.parse(real.find(f => f.id === 'hulaween-2026').startDate);
const shiftIso = t => new Date(Date.parse(t) + SHIFT).toISOString().replace(/\.\d{3}Z$/, 'Z');
const FESTS = real.map(f => ({ ...f, startDate: shiftIso(f.startDate), endDate: shiftIso(f.endDate) }));
const ymd = d => new Date(d).toISOString().slice(0, 10);
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }) : Promise.resolve();

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.split('?')[0] === '/festivals.json') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(FESTS)); }
    const file = join(root, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(root) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); server?.close(); });

const json = obj => ({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(obj) });

/** A phone-sized page whose outside requests are answered by fixtures. `live` flips the weather service on and off. */
async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    timezoneId: 'America/New_York', locale: 'en-US', serviceWorkers: 'block', colorScheme: opts.dark ? 'dark' : 'light' });
  const page = await context.newPage();
  const seen = { alerts: 0, points: 0, hourly: 0, frames: [], tiles: 0, fonts: 0, backend: 0, errors: [] };
  const live = { nws: true, iem: true };
  page.on('pageerror', e => seen.errors.push(String(e)));
  // Aborted requests log 'Failed to load resource'; that is the network, not the page, so only script errors count.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) seen.errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => { seen.fonts++; r.fulfill({ status: 200, contentType: 'text/css', body: '' }); });
  // The built-in backend is down in these tests, so the page has to fall back to NWS and the archive on its own.
  await page.route(/fieldwatch-production\.up\.railway\.app/, r => { seen.backend++; r.abort('failed'); });
  await page.route(/api\.weather\.gov\/alerts\/active/, r => { seen.alerts++; live.nws ? r.fulfill(json({ type: 'FeatureCollection', features: [alertFeature()] })) : r.abort('failed'); });
  await page.route(/api\.weather\.gov\/points\//, r => { seen.points++; live.nws ? r.fulfill(json(points)) : r.abort('failed'); });
  await page.route(/gridpoints\/.*\/forecast\/hourly/, r => { seen.hourly++; live.nws ? r.fulfill(json(hourly)) : r.abort('failed'); });
  await page.route(/mesonet\.agron\.iastate\.edu/, r => {
    seen.frames.push(new URL(r.request().url()).searchParams.get('TIME'));
    live.iem ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.abort('failed');
  });
  await page.route(/tile\.openstreetmap\.org/, r => { seen.tiles++; r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  return { page, context, seen, live };
}
const enter = async page => { await page.goto(`${base}/index.html`); const start = page.locator('button:has-text("Find your festival")'); if (await start.count()) await start.click(); await page.waitForSelector('h1.title:has-text("Which festival?")'); };
const pickHulaween = async page => { await enter(page); await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn'); };

test('the walkthrough opens once; then only what is on: bubbles first, the rest a list, search, and a way to add one', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title');
  assert.equal(await page.textContent('h1.title'), 'Fieldwatch');
  assert.equal(await page.$$eval('.trio .orb', els => els.length), 3);
  await shot(page, '0-welcome');
  await page.click('button:has-text("Find your festival")');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  const on = FESTS.filter(f => isLive(f)), off = FESTS.filter(f => !isLive(f));
  assert.ok(on.length >= 2 && off.length >= 2, 'the fixture has festivals on and festivals not on');
  const names = (await page.$$eval('.bubble .t, .row .t', els => els.map(e => e.textContent))).filter(n => n !== 'Add a festival');
  assert.deepEqual(new Set(names), new Set(on.map(f => f.name)), 'exactly the festivals whose grounds are open, nothing that is weeks away or over');
  assert.equal(await page.$$eval('.bubble', els => els.length), Math.min(6, on.length));
  assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween', 'the one happening now comes first');
  assert.equal(await page.textContent('.bubble .ph'), 'Happening now');
  assert.match(await page.textContent('button:has-text("Sick New World")'), /Gates in \d days|Gates tomorrow/, 'a day out: early entry and crews are already there');
  assert.equal((await page.$$eval('p.h', els => els.map(e => e.textContent)))[0], 'Happening now');
  assert.match(await page.textContent('.note'), /week before gates/);
  await shot(page, '1-picker');
  await page.fill('#q', 'hulaween');
  assert.deepEqual(await page.$$eval('button.row .t', els => els.map(e => e.textContent)), ['Suwannee Hulaween', 'Add a festival']);
  await page.fill('#q', 'orlando');   // EDC Orlando is weeks out
  assert.match(await page.textContent('.empty'), /Not on right now/);
  await page.fill('#q', '');
  await page.click('button:has-text("Add a festival")');
  await page.waitForSelector('#f-name');   // the built-in backend takes suggestions
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  // Told to go without a backend, there is nowhere to send one.
  await page.goto(`${base}/index.html?backend=none`);
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  await page.click('button:has-text("Add a festival")');
  await page.waitForSelector('h1.title:has-text("Add a festival")');
  assert.match(await page.textContent('.card'), /Needs the backend/);
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title');
  assert.equal(await page.textContent('h1.title'), 'Which festival?', 'the welcome step is shown once');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('picking a festival pulls live alerts and the forecast, and the home screen says so at a glance', async () => {
  const { page, context, seen } = await newPage();
  await pickHulaween(page);
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning');
  assert.match(await page.textContent('.sky p'), /Take shelter now/);
  assert.equal(await page.$$eval('.sky .strip .c', els => els.length), 6, 'six hours inside the status card');
  assert.match(await page.textContent('.sky .foot'), /Checked just now/);
  assert.equal(await page.textContent('button.orb:has-text("Alerts") .badge'), '1');
  assert.equal(seen.alerts, 1); assert.equal(seen.points, 1); assert.equal(seen.hourly, 1);
  assert.ok(seen.backend >= 1, 'the built-in backend is tried first; NWS answers when it is down');
  const orbBox = await page.locator('button.orb:has-text("Radar")').boundingBox();
  await page.mouse.move(orbBox.x + orbBox.width / 2, orbBox.y + 40);
  await page.mouse.down();
  assert.ok(await page.$('button.orb.pressed'), 'the orb squishes while pressed');
  await page.mouse.up();
  assert.ok(await page.$('button.orb.pop'), 'and springs back on release');
  await page.waitForSelector('.rmap', { timeout: 5000 });   // the spring plays, then the tap lands
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('.sky.warn');
  await shot(page, '2-home');

  await page.click('button.orb:has-text("Forecast")');
  await page.waitForSelector('#chart');
  assert.equal(await page.getAttribute('#chart', 'data-n'), '24');
  assert.equal(await page.$$eval('.hours .hr', els => els.length), 24, 'the strip shows the next 24 of the 36 fetched hours');
  assert.match(await page.textContent('.hours .hr.now .tp'), /84°/);
  assert.match(await page.textContent('#chart'), /CHANCE OF RAIN/, 'the fixture has rain chances, so the second panel is drawn');
  assert.match(await page.textContent('h1.title'), /Weather/);
  assert.match(await page.textContent('.sub'), /Thunderstorms possible around/);
  const row = page.locator('button.alert:has-text("Severe Thunderstorm Warning")');
  assert.match(await row.textContent(), /Until .*3:00 PM/);
  // scrub the chart: the crosshair and tooltip follow the pointer
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.4);
  await page.mouse.down();
  assert.equal(await page.$eval('#tip', el => getComputedStyle(el).display), 'block');
  assert.match(await page.textContent('#tip'), /°/);
  await page.mouse.up();
  await shot(page, '3-weather');

  await row.click();
  await page.waitForSelector('.alerthead');
  assert.equal(await page.textContent('.alerthead h2'), 'Severe Thunderstorm Warning');
  assert.match(await page.textContent('.todo p'), /interior room/, 'the instruction is pulled up top as what to do');
  assert.match(await page.textContent('.body'), /near Live Oak/);
  assert.match(await page.textContent('.group'), /NWS Jacksonville FL/);
  const parsed = await page.evaluate(() => parseNWS('* WHAT...Southwest winds 20 to 30 mph.\n\n* WHERE...Riverside County valleys.\n\n* WHEN...Until 8 PM.\n\nSecure tents before 2 PM.'));
  assert.deepEqual(parsed.sections.map(s => s.label), ['What', 'Where', 'When']);
  assert.deepEqual(parsed.paragraphs, ['Secure tents before 2 PM.']);
  await shot(page, '4-alert');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('the radar screen asks the archive for 48 frames, newest first, and plays them', async () => {
  const { page, context, seen } = await newPage();
  await pickHulaween(page);
  await page.click('button.orb:has-text("Radar")');
  await page.waitForFunction(() => document.querySelectorAll('.frame').length === 48 && document.getElementById('radar-loaded')?.textContent === '');
  assert.equal(seen.frames.length, 48);
  const times = seen.frames.map(t => Date.parse(t));
  assert.ok(times[0] > times[1] && times[0] === Math.max(...times), 'newest frame requested first');
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i] - sorted[i - 1], 15 * 60000);
  assert.ok(Date.now() - sorted.at(-1) >= 10 * 60000 && Date.now() - sorted.at(-1) < 25 * 60000, 'newest frame is 10 to 25 minutes old');
  assert.ok(seen.tiles >= 4, 'map tiles under the square');
  assert.ok(await page.$('.frame.on'), 'a frame is showing');
  assert.match(await page.textContent('#radar-time'), /\d:\d\d/);
  assert.match(await page.textContent('#radar-ago'), /ago|just now/);
  const ticks = await page.$$eval('.ticks span', els => els.map(e => e.textContent));
  assert.equal(ticks.length, 5); for (const t of ticks) assert.match(t, /\d/);
  assert.equal(await page.$eval('#radar-progress', el => el.style.width), '100%');
  await shot(page, '5-radar');

  await page.click('#radar-play');
  assert.equal(await page.getAttribute('#radar-play', 'aria-label'), 'Play');
  await page.locator('#radar-slider').fill('3');
  await page.$eval('#radar-slider', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  const shown = await page.$$eval('.frame', els => els.findIndex(e => e.classList.contains('on')));
  assert.equal(shown, 3);
  assert.match(await page.textContent('p.note:last-of-type'), /NOAA NEXRAD via Iowa Environmental Mesonet/);
  await page.click('button[aria-label="Back"]');
  assert.equal(await page.$$eval('.frame', els => els.length), 0, 'leaving the screen stops the loop');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('losing the weather service keeps the last good data and says so', async () => {
  const { page, context, seen, live } = await newPage();
  await pickHulaween(page);
  live.nws = false;
  await page.click('button[aria-label="Refresh"]');
  await page.waitForFunction(() => /before signal dropped/.test(document.querySelector('.sky .foot')?.textContent || ''));
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning', 'the cached alert is still shown');
  await shot(page, '6-offline');

  await page.reload();
  await page.waitForSelector('.sky.warn');
  assert.match(await page.textContent('.sky h2'), /Severe Thunderstorm Warning/, 'the cache survives a reload');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('dark theme, a fresh browser, and the installable shell', async () => {
  const { page, context, seen } = await newPage({ dark: true });
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title');
  assert.equal(await page.textContent('h1.title'), 'Fieldwatch');
  assert.equal(seen.alerts + seen.points + seen.hourly + seen.frames.length, 0, 'nothing fetched until a festival is chosen');
  const bg = await page.$eval('body', el => getComputedStyle(el).backgroundColor);
  assert.equal(bg, 'rgb(11, 10, 22)', 'dark palette applies from the system setting');
  await pickHulaween(page);
  await shot(page, '7-home-dark');
  assert.equal(await page.getAttribute('link[rel="manifest"]', 'href'), 'manifest.webmanifest');
  assert.equal(await page.getAttribute('link[rel="apple-touch-icon"]', 'href'), 'apple-touch-icon.png');
  for (const f of ['manifest.webmanifest', 'sw.js', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon.svg']) {
    const r = await page.request.get(`${base}/${f}`);
    assert.equal(r.status(), 200, `${f} is served`);
  }
  const manifest = await (await page.request.get(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

/** A backend the page can call from another origin: the live list, suggestions, and the admin queue. */
function fakeBackend(list) {
  const store = { list: [...list], pending: [], subs: [], calls: [] };
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, x-admin-key' };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const path = req.url.split('?')[0], m = req.method, key = req.headers['x-admin-key'];
      store.calls.push(`${m} ${path}`);
      const send = (status, body) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (m === 'GET' && path === '/festivals') return send(200, store.list.filter(f => isLive(f)));
      if (m === 'POST' && path === '/festivals') {
        const b = JSON.parse(raw);
        const f = { ...b, id: `sub-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-abc123`, county: '', isPartner: false, feeds: [], site: [], origin: 'community', status: 'pending', featured: false };
        store.pending.push(f); return send(202, { id: f.id, pending: true });
      }
      if (m === 'GET' && path === '/push/vapid') return send(200, { key: 'BPUBLICKEY' });
      if (m === 'POST' && path === '/push/subscribe') { store.subs.push(JSON.parse(raw)); return send(200, { ok: true }); }
      if (m === 'DELETE' && path === '/push/subscribe') { const b = JSON.parse(raw || '{}'); store.subs = store.subs.filter(s => s.subscription.endpoint !== b.endpoint); return send(200, { ok: true }); }
      if (key !== 'k-admin') return send(401, { error: 'x-admin-key required' });
      if (m === 'GET' && path === '/festivals/pending') return send(200, store.pending);
      const ap = path.match(/^\/festivals\/([^/]+)\/approve$/);
      if (m === 'POST' && ap) { const i = store.pending.findIndex(f => f.id === ap[1]); if (i < 0) return send(404, {}); const [f] = store.pending.splice(i, 1); store.list.push({ ...f, status: 'published' }); return send(200, f); }
      const del = path.match(/^\/festivals\/([^/]+)$/);
      if (m === 'DELETE' && del) { store.pending = store.pending.filter(f => f.id !== del[1]); return send(200, { ok: true }); }
      send(404, { error: 'not found' });
    });
  });
  return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, store, base: `http://127.0.0.1:${server.address().port}` })));
}

test('with a backend: its live list is the list, anyone can add a festival, and an admin approves it from Settings', async () => {
  const { page, context, seen } = await newPage();
  const hula = FESTS.find(f => f.id === 'hulaween-2026');
  const extra = { ...hula, id: 'sub-blackwater-xyz', name: 'Blackwater Gathering', location: 'Lake Wales, FL', latitude: 27.9, longitude: -81.58, origin: 'community', status: 'published', featured: false, feeds: [], site: [], isPartner: false };
  const { server, store, base: api } = await fakeBackend([...FESTS, extra]);
  let geocodes = 0;
  await page.route(/nominatim\.openstreetmap\.org/, r => { geocodes++; assert.match(r.request().url(), /countrycodes=us/); r.fulfill(json([
    { name: 'Spirit of the Suwannee Music Park', display_name: 'Spirit of the Suwannee Music Park, 3076, 95th Drive, Live Oak, Suwannee County, Florida, 32060, United States', lat: '30.4040', lon: '-82.9395', address: { city: 'Live Oak', county: 'Suwannee County', state: 'Florida' } },
    { name: 'Live Oak', display_name: 'Live Oak, Suwannee County, Florida, United States', lat: '30.2949', lon: '-82.9840', address: { town: 'Live Oak', county: 'Suwannee County', state: 'Florida' } },
  ])); });
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Find your festival")');
    await page.waitForSelector('h1.title:has-text("Which festival?")');
    await page.waitForSelector('button.row:has-text("Blackwater Gathering")');
    assert.ok(store.calls.includes('GET /festivals'), 'the list came from the backend');
    assert.ok(!(await page.$$eval('.bubble .t', els => els.map(e => e.textContent))).includes('Blackwater Gathering'), 'a community festival is listed, not featured');
    assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween');

    await page.click('button:has-text("Add a festival")');
    await page.waitForSelector('#f-name');
    assert.ok(await page.$('#f-send[disabled]'), 'nothing to send yet');
    await page.fill('#f-name', 'Moon Hollow Gathering');
    await page.fill('#f-where', 'Spirit of the Suwannee, Live Oak FL');
    await page.click('#f-find');
    await page.waitForSelector('button.row:has-text("Spirit of the Suwannee Music Park")');
    assert.equal(geocodes, 1);
    assert.equal(await page.$$eval('button.row', els => els.length), 2, 'two places to choose from');
    await page.click('button.row:has-text("Spirit of the Suwannee Music Park")');
    await page.waitForSelector('.row:has-text("Spirit of the Suwannee Music Park, Live Oak, Florida")');
    const today = ymd(Date.now()), in2 = ymd(Date.now() + 2 * DAY);
    await page.fill('#f-start', today);
    await page.fill('#f-end', in2);
    await page.fill('#f-site', 'moonhollow.org');
    assert.equal(await page.$('#f-send[disabled]'), null, 'ready to send');
    await shot(page, '8-add');
    await page.click('#f-send');
    await page.waitForSelector('h1.title:has-text("Sent")');
    assert.equal(store.pending.length, 1);
    const sent = store.pending[0];
    assert.equal(sent.name, 'Moon Hollow Gathering');
    assert.equal(sent.location, 'Spirit of the Suwannee Music Park, Live Oak, Florida');
    assert.equal(sent.latitude, 30.404); assert.equal(sent.longitude, -82.9395);
    assert.equal(sent.startDate, today); assert.equal(sent.endDate, in2);
    assert.equal(sent.website, 'moonhollow.org');
    await shot(page, '9-sent');
    await page.click('button:has-text("Back to festivals")');
    await page.waitForSelector('h1.title:has-text("Which festival?")');
    assert.ok(!(await page.textContent('#app')).includes('Moon Hollow'), 'not listed until approved');

    // The admin: a key in Settings unlocks the queue.
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('#admin');
    assert.equal(await page.$('button:has-text("Review festivals")'), null);
    await page.fill('#admin', 'k-admin');
    await page.locator('#admin').blur();
    await page.waitForSelector('button:has-text("Review festivals")');
    await page.click('button:has-text("Review festivals")');
    await page.waitForSelector('.pend:has-text("Moon Hollow Gathering")');
    assert.match(await page.textContent('.pend'), /moonhollow\.org/);
    await shot(page, '10-review');
    await page.click('.pend button:has-text("Approve")');
    await page.waitForSelector('.empty:has-text("Nothing waiting")');
    assert.ok(store.calls.includes('POST /festivals/sub-moon-hollow-gathering-abc123/approve'));
    assert.ok(store.list.some(f => f.name === 'Moon Hollow Gathering'));
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('#admin');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('button.row:has-text("Moon Hollow Gathering")', { timeout: 5000 });

    // With the backend gone, the last list it gave is what shows.
    server.closeAllConnections(); await new Promise(r => server.close(r));
    await page.reload();
    await page.waitForSelector('h1.title:has-text("Which festival?")');
    assert.ok(await page.$('button.row:has-text("Moon Hollow Gathering")'), 'the last live list survives a dead backend');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a link opens straight to a festival and its alert, and warnings can be switched on for this phone', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['notifications']);
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  // The test blocks service workers, so stand in for the registration and the browser's push service.
  await page.addInitScript(() => {
    const sub = { endpoint: 'https://push.example.test/abc', unsubscribe: async () => { window.__subscribed = false; return true; },
      toJSON: () => ({ endpoint: 'https://push.example.test/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) };
    window.__subscribed = false;
    const reg = { pushManager: { getSubscription: async () => (window.__subscribed ? sub : null), subscribe: async () => { window.__subscribed = true; return sub; } } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
    window.PushManager = function PushManager(){};
  });
  try {
    const alertId = alertFeature().properties.id;
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026&alert=${encodeURIComponent(alertId)}`);
    await page.waitForSelector('.alerthead');
    assert.match(await page.textContent('.alerthead h2'), /Severe Thunderstorm Warning/, 'straight to the alert: no walkthrough, no picker');
    assert.equal(new URL(page.url()).searchParams.get('f'), null, 'the link is consumed');
    assert.equal(new URL(page.url()).searchParams.get('backend'), api, 'other settings in the address stay');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('.pill'), 'Off');
    await page.click('button.row:has-text("Warnings on this phone")');
    await page.waitForSelector('.pill.on');
    assert.ok(store.calls.includes('GET /push/vapid') && store.calls.includes('POST /push/subscribe'));
    assert.equal(store.subs.length, 1);
    assert.equal(store.subs[0].festivalId, 'hulaween-2026');
    assert.deepEqual(store.subs[0].subscription, { endpoint: 'https://push.example.test/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } });
    await shot(page, '11-home-push');
    await page.click('button.row:has-text("Warnings on this phone")');
    await page.waitForSelector('.pill:not(.on)');
    assert.ok(store.calls.includes('DELETE /push/subscribe'));
    assert.equal(store.subs.length, 0);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});
