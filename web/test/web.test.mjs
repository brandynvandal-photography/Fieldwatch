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
import { alertFeature, points, hourly, grid, daily } from '../../backend/test/fixtures/nws.js';

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
// The 7-day forecast shifted with the festivals, keeping its Eastern offsets, so its days fall inside Hulaween.
const DAYSHIFT = Math.round(SHIFT / DAY) * DAY;   // whole days, so a night stays with its day
const shiftEastern = t => new Date(Date.parse(t) + DAYSHIFT - 4 * 3600000).toISOString().replace(/\.\d{3}Z$/, '-04:00');
const dailyShifted = { properties: { ...daily.properties, periods: daily.properties.periods.map(p => ({ ...p, startTime: shiftEastern(p.startTime), endTime: shiftEastern(p.endTime) })) } };
const easternWeekday = t => new Date(Date.parse(t) + DAYSHIFT).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'America/New_York' });
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
  const seen = { alerts: 0, points: 0, hourly: 0, grid: 0, daily: 0, frames: [], tiles: 0, fonts: 0, backend: 0, errors: [] };
  const live = { nws: true, iem: true };
  page.on('pageerror', e => seen.errors.push(String(e)));
  // Aborted requests log 'Failed to load resource'; that is the network, not the page, so only script errors count.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) seen.errors.push(m.text()); });
  await page.route(/fonts\.(googleapis|gstatic)\.com/, r => { seen.fonts++; r.fulfill({ status: 200, contentType: 'text/css', body: '' }); });
  // The built-in backend is down in these tests, so the page has to fall back to NWS and the archive on its own.
  await page.route(/fieldwatch-production\.up\.railway\.app/, r => { seen.backend++; r.abort('failed'); });
  seen.alertUrls = [];
  await page.route(/api\.weather\.gov\/alerts\/active/, r => { seen.alerts++; seen.alertUrls.push(r.request().url()); live.nws ? r.fulfill(json({ type: 'FeatureCollection', features: [alertFeature()] })) : r.abort('failed'); });
  await page.route(/api\.weather\.gov\/points\//, r => { seen.points++; live.nws ? r.fulfill(json(points)) : r.abort('failed'); });
  await page.route(/gridpoints\/.*\/forecast\/hourly/, r => { seen.hourly++; live.nws ? r.fulfill(json(hourly)) : r.abort('failed'); });
  await page.route(/gridpoints\/[^/]+\/[\d,]+\/forecast$/, r => { seen.daily++; live.nws ? r.fulfill(json(dailyShifted)) : r.abort('failed'); });
  await page.route(/gridpoints\/[^/]+\/[\d,]+$/, r => { seen.grid++; live.nws ? r.fulfill(json(grid)) : r.abort('failed'); });
  await page.route(/mesonet\.agron\.iastate\.edu/, r => {
    seen.frames.push(new URL(r.request().url()).searchParams.get('TIME'));
    live.iem ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.abort('failed');
  });
  await page.route(/tile\.openstreetmap\.org/, r => { seen.tiles++; r.fulfill({ status: 200, contentType: 'image/png', body: PNG }); });
  return { page, context, seen, live };
}
// The home page is the alerts feed; the picker is one tap away on it.
const enter = async page => { await page.goto(`${base}/index.html`); const start = page.locator('button:has-text("Use my location")'); if (await start.count()) await start.click(); await page.click('button.row:has-text("All festivals")'); await page.waitForSelector('h1.title:has-text("Which festival?")'); };
const pickHulaween = async page => { await enter(page); await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn'); };
/** Icons that grew past their box: an SVG outside a chart or the radar wider than 70 px is a button swallowed by its icon (Safari does this to an unsized SVG in a flex row). */
const oversizedIcons = page => page.$$eval('svg', els => els.filter(e => !e.closest('.chart, .rmap, #crew') && e.getBoundingClientRect().width > 70).map(e => `${e.parentElement.className || e.parentElement.tagName} ${Math.round(e.getBoundingClientRect().width)}px`));

test('the walkthrough opens once; then only what is on: bubbles first, the rest a list, search, and a way to add one', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title');
  assert.equal(await page.textContent('h1.title'), 'Fieldwatch');
  assert.equal(await page.$$eval('.trio .orb', els => els.length), 3);
  await shot(page, '0-welcome');
  await page.click('button:has-text("Use my location")');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.match(await page.textContent('h1.title'), /warning|advisor|All clear|Checking|No signal/, 'the home page is what is happening, not a list');
  await page.click('button.row:has-text("All festivals")');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  // The list has a way back to the home page.
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  await page.click('button.row:has-text("All festivals")');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  const on = FESTS.filter(f => isLive(f)), off = FESTS.filter(f => !isLive(f));
  assert.ok(on.length >= 2 && off.length >= 2, 'the fixture has festivals on and festivals not on');
  const names = (await page.$$eval('.bubble .t, .row .t', els => els.map(e => e.textContent))).filter(n => n !== 'Right where you are');
  assert.deepEqual(new Set(names), new Set(on.map(f => f.name)), 'exactly the festivals whose grounds are open, nothing that is weeks away or over');
  assert.equal(await page.$$eval('.bubble', els => els.length), Math.min(6, on.length));
  assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween', 'the one happening now comes first');
  assert.equal(await page.textContent('.bubble .ph'), 'Happening now');
  assert.match(await page.textContent('button:has-text("Sick New World")'), /Gates in \d days|Gates tomorrow/, 'a day out: early entry and crews are already there');
  assert.equal((await page.$$eval('p.h', els => els.map(e => e.textContent)))[0], 'Happening now');
  assert.match(await page.textContent('.note'), /week before gates/);
  await shot(page, '1-picker');
  await page.fill('#q', 'hulaween');
  assert.deepEqual(await page.$$eval('button.row .t', els => els.map(e => e.textContent)), ['Suwannee Hulaween', 'Right where you are']);
  await page.fill('#q', 'orlando');   // EDC Orlando is weeks out
  assert.match(await page.textContent('.empty'), /Not on right now/);
  assert.ok(await page.$('button.row:has-text("Right where you are")'), 'your own spot is always an option');
  await page.fill('#q', '');
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.notEqual(await page.textContent('h1.title'), 'Fieldwatch', 'the welcome step is shown once');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('picking a festival pulls live alerts and the forecast, and the home screen says so at a glance', async () => {
  const { page, context, seen } = await newPage();
  await pickHulaween(page);
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning');
  assert.equal(await page.textContent('.sky p'), 'Get into a vehicle or building. Not a tent, canopy or stage.', 'the sky says the one thing to do for this warning');
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
  assert.match(await page.textContent('.sub'), /Thunder likely around .* Know your shelter/, 'the grid knows more than the wording does');
  // Heat, wind and lightning panels over the same hours, one crosshair.
  assert.equal(await page.getAttribute('#crew', 'data-panels'), 'heat,gust,thunder');
  assert.equal(await page.getAttribute('#crew', 'data-n'), '24');
  assert.deepEqual(await page.$$eval('#crew .peak', els => els.map(e => e.textContent)), ['96°', '34 mph', '60%']);
  assert.match(await page.textContent('#crew'), /HEAT INDEX.*WIND GUSTS, MPH.*CHANCE OF THUNDER/s);
  assert.match(await page.textContent('#crew'), /tents.*stages/s, 'gust guides for tents and stages');
  await page.locator('#crew').scrollIntoViewIfNeeded();
  const crewBox = await page.locator('#crew').boundingBox();
  await page.mouse.move(crewBox.x + crewBox.width * 0.2, crewBox.y + crewBox.height * 0.3);   // about three hours in
  await page.mouse.down();
  assert.match(await page.textContent('#tip2'), /^\d+ [AP]M heat \d+° · gusts \d+ mph · thunder \d+%$/);
  await page.mouse.up();
  // Day by day, with a pack line.
  const rows = await page.$$eval('.days .dayrow', els => els.map(e => e.textContent.replace(/\s+/g, ' ').trim()));
  assert.ok(rows.length >= 3 && rows.length <= 5, `the festival's days through the day after, not the whole week: ${rows.length}`);
  assert.match(rows[0], /88°66°40%/);
  assert.equal(await page.textContent('#pack'), `Pack for cold nights, hot afternoons, rain ${easternWeekday('2026-10-24T10:00:00-04:00')} and wind.`);
  assert.equal(seen.grid, 1); assert.equal(seen.daily, 1); assert.equal(seen.points, 1, 'one /points call feeds all three');
  await shot(page, '13-weather-crew');
  const row = page.locator('button.alert:has-text("Severe Thunderstorm Warning")');
  assert.match(await row.textContent(), /Until .*3:00 PM/);
  // scrub the chart: the crosshair and tooltip follow the pointer
  await page.locator('#chart').scrollIntoViewIfNeeded();
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
  assert.equal(await page.textContent('.donow .t'), 'Get into a vehicle or building', 'the first thing on a warning is one line to act on');
  assert.equal(await page.textContent('.donow .s'), 'Not a tent, canopy or stage.');
  assert.match(await page.textContent('.alerthead p'), /^Until 3:00 PM · .* left$/, 'and how long it has left, as a number');
  assert.ok(!(await page.$('details.more[open]')), 'the long text is folded');
  await page.click('details.more summary');
  assert.match(await page.textContent('details.more .sec:has-text("What to do")'), /interior room/, 'the weather service instruction is under Full alert');
  assert.match(await page.textContent('details.more'), /near Live Oak/);
  assert.deepEqual(await page.$$eval('.secs .sec .k', els => els.map(e => e.textContent)), ['What to do', 'From the weather service'], 'long text is stacked under small labels');
  assert.deepEqual(await page.evaluate(() => bullets('- Prolonged rain on saturated soil. - For flood safety, visit weather.gov. Rain of 2-4 inches.')), ['Prolonged rain on saturated soil.', 'For flood safety, visit weather.gov. Rain of 2-4 inches.']);
  assert.equal(await page.evaluate(() => areaText('Harrison; Shelby; Pottawattamie; Mills; Montgomery; Fremont')), 'Harrison, Shelby, Pottawattamie and 3 more');
  assert.match(await page.textContent('.group'), /NWS Jacksonville FL/);
  const parsed = await page.evaluate(() => parseNWS('* WHAT...Southwest winds 20 to 30 mph.\n\n* WHERE...Riverside County valleys.\n\n* WHEN...Until 8 PM.\n\nSecure tents before 2 PM.'));
  assert.deepEqual(parsed.sections.map(s => s.label), ['What', 'Where', 'When']);
  assert.deepEqual(parsed.paragraphs, ['Secure tents before 2 PM.']);
  await shot(page, '4-alert');
  // A warning can be handed to the phones around you: text plus the link, over AirDrop where it exists, the clipboard here.
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  assert.ok(await page.$('button.warnbtn:has-text("Warn people near you")'));
  assert.deepEqual(await oversizedIcons(page), [], 'the share icon sits beside the label, not over it');
  assert.equal(Math.round((await page.locator('button.warnbtn svg').boundingBox()).width), 22);
  await page.click('button.warnbtn');
  await page.waitForSelector('.toast.show:has-text("Copied")');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^Severe Thunderstorm Warning for Suwannee; Columbia\. /);
  assert.match(clip, /For your protection move to an interior room/);
  assert.match(clip, /\?f=hulaween-2026&alert=urn%3Aoid/);
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
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.match(await page.textContent('.group .row:has-text("Suwannee Hulaween") .s'), /Severe Thunderstorm Warning/, 'the home page shows your festival from its cache');
  await page.click('.group .row:has-text("Suwannee Hulaween")');
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
  const store = { list: [...list], pending: [], subs: [], reports: [], posts: [], pendingReports: [], imports: 0, calls: [], feed: null, lightning: {}, ground: {} };
  store.groundReports = {};
  // The live stream: open responses, and a way for a test to push a change to every page on it (backend/src/live.js).
  store.live = [];
  store.emit = e => store.live.forEach(r => r.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
  const groundOf = id => ({ surface: 'grass', soil: 'B', low: false, structures: ['canopies'], surfaceSource: 'assumed', soilSource: 'assumed', soilName: null, drainage: null, past: null, override: null, learned: null, reports: store.groundReports[id] ? { last: store.groundReports[id][0], recent: store.groundReports[id].length } : null, ...(store.ground[id] || {}) });
  // What the home page shows: the fixture's warning at Hulaween, an advisory at the next festival that is on.
  const p = alertFeature().properties, toAlert = over => ({ id: p.id, event: p.event, headline: p.headline ?? null, body: p.description ?? '', instruction: p.instruction ?? null, severity: String(p.severity || 'Unknown').toLowerCase(), area: p.areaDesc ?? '', source: p.senderName ?? 'NWS', issuedAt: p.effective, expiresAt: p.ends ?? p.expires ?? null, channel: 'weather', relayCount: 0, ...over });
  const other = store.list.find(f => isLive(f) && f.id !== 'hulaween-2026');
  store.feed = [{ festivalId: 'hulaween-2026', alerts: [toAlert({})] }, ...(other ? [{ festivalId: other.id, alerts: [toAlert({ id: 'urn:oid:feed-adv', event: 'Heat Advisory', severity: 'minor', headline: 'Heat Advisory until 8 PM' })] }] : [])];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, x-admin-key' };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const path = req.url.split('?')[0], m = req.method, key = req.headers['x-admin-key'];
      store.calls.push(`${m} ${path}`);
      const send = (status, body) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (m === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
      if (m === 'GET' && path === '/events') { res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }); res.write('retry: 5000\n: hello\n\n'); store.live.push(res); res.on('close', () => { store.live = store.live.filter(r => r !== res); }); return; }
      if (m === 'GET' && path === '/festivals') {
        const u = new URL(req.url, 'http://x');
        if (u.searchParams.get('all')) return send(200, u.searchParams.get('hidden') && key === 'k-admin' ? store.list : store.list.filter(f => f.status !== 'hidden'));
        return send(200, store.list.filter(f => isLive(f) && f.status !== 'hidden'));
      }
      if (m === 'POST' && path === '/festivals') {
        const b = JSON.parse(raw);
        const f = { ...b, id: `sub-${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-abc123`, county: '', isPartner: false, feeds: [], site: [], origin: 'community', status: 'pending', featured: false };
        store.pending.push(f); return send(202, { id: f.id, pending: true });
      }
      if (m === 'GET' && /^\/festivals\/[^/]+\/qr\.svg$/.test(path)) { res.writeHead(200, { ...cors, 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 21 21"><rect width="21" height="21" fill="#fff"/><path d="M1 1h7v7H1z" fill="#000"/></svg>'); }
      const rep = path.match(/^\/festivals\/([^/]+)\/reports$/);
      if (m === 'POST' && rep) { const b = JSON.parse(raw); if (!b.summary || b.summary.length < 8) return send(400, { error: 'summary required' }); store.reports.push({ festival: rep[1], ...b }); return send(202, { id: `rep-${store.reports.length}`, queued: true }); }
      if (m === 'GET' && path === '/alerts') return send(200, { at: new Date().toISOString(), on: store.list.filter(f => isLive(f) && f.status !== 'hidden').length, items: (store.feed || []).map(x => ({ festival: store.list.find(f => f.id === x.festivalId), alerts: x.alerts, lightning: store.lightning[x.festivalId] || null })).filter(i => i.festival) });
      const gr = path.match(/^\/festivals\/([^/]+)\/ground$/);
      if (m === 'GET' && gr) return send(200, groundOf(gr[1]));
      const grr = path.match(/^\/festivals\/([^/]+)\/ground\/report$/);
      if (m === 'POST' && grr) { const b = JSON.parse(raw); if (!['fine', 'soft', 'mud', 'water'].includes(b.state)) return send(400, { error: 'state' }); store.groundReports[grr[1]] = [{ state: b.state, at: new Date().toISOString() }, ...(store.groundReports[grr[1]] || [])]; return send(200, { ok: true, state: b.state, effective: 0.9, learned: b.state === 'fine' ? null : { threshold: 0.9, samples: store.groundReports[grr[1]].length, at: new Date().toISOString() }, reports: groundOf(grr[1]).reports }); }
      const ncm = path.match(/^\/festivals\/([^/]+)\/nowcast$/);
      if (m === 'GET' && ncm) return send(200, (store.nowcast || {})[ncm[1]] || { at: null, tracked: false, minutes: null });
      const bolt = path.match(/^\/festivals\/([^/]+)\/lightning$/);
      if (m === 'GET' && bolt) return send(200, store.lightning[bolt[1]] || { code: 'none', at: new Date().toISOString(), on: true, source: 'GOES GLM' });
      if (m === 'GET' && path === '/push/vapid') return send(200, { key: 'BPUBLICKEY' });
      if (m === 'GET' && path === '/health') return send(200, { ok: true, at: '2026-10-23T09:00:00Z', build: '4356d78', uptimeSeconds: 61, database: { path: '/data/fieldwatch.db', onVolume: true }, festivals: 14, push: { web: true }, adminKey: true, nwsUserAgent: 'placeholder', sources: { ticketmaster: false, seatgeek: false, edmtrain: true, wikidata: 'NWS_USER_AGENT not set', feeds: false }, imports: { running: false, lastStartedAt: '2026-10-23T09:00:00Z', lastFinishedAt: '2026-10-23T09:01:00Z' } });
      if (m === 'POST' && path === '/push/subscribe') { store.subs.push(JSON.parse(raw)); return send(200, { ok: true }); }
      if (m === 'DELETE' && path === '/push/subscribe') { const b = JSON.parse(raw || '{}'); store.subs = store.subs.filter(s => s.subscription.endpoint !== b.endpoint); return send(200, { ok: true }); }
      if (key !== 'k-admin') return send(401, { error: 'x-admin-key required' });
      if (m === 'PUT' && gr) { const b = JSON.parse(raw); store.ground[gr[1]] = { ...(store.ground[gr[1]] || {}), ...b, surfaceSource: b.surface ? 'staff' : 'assumed', override: b }; return send(200, groundOf(gr[1])); }
      if (m === 'DELETE' && gr) { delete store.ground[gr[1]]; return send(200, groundOf(gr[1])); }
      const grl = path.match(/^\/festivals\/([^/]+)\/ground\/lookup$/);
      if (m === 'POST' && grl) { store.ground[grl[1]] = { ...(store.ground[grl[1]] || {}), surface: 'grass', soil: 'A', soilName: 'Blanton fine sand, 0 to 5 percent slopes', drainage: 'Somewhat excessively drained', surfaceSource: 'OpenStreetMap: leisure=park', soilSource: 'USDA soil survey' }; return send(200, groundOf(grl[1])); }
      const hide = path.match(/^\/festivals\/([^/]+)\/(hide|unhide)$/);
      if (m === 'POST' && hide) { const f = store.list.find(x => x.id === hide[1]); if (!f) return send(404, {}); f.status = hide[2] === 'hide' ? 'hidden' : 'published'; return send(200, { ok: true, id: f.id, status: f.status }); }
      const post = path.match(/^\/festivals\/([^/]+)\/posts$/);
      if (m === 'POST' && post) { const b = JSON.parse(raw); store.posts.push({ festival: post[1], key, ...b }); return send(201, { id: String(store.posts.length), push: { sent: 0, skipped: true }, web: { sent: 2, gone: 0, failed: 0 } }); }
      const pend = path.match(/^\/festivals\/([^/]+)\/incidents\/pending$/);
      if (m === 'GET' && pend) return send(200, store.pendingReports);
      const pub = path.match(/^\/festivals\/([^/]+)\/incidents\/([^/]+)\/publish$/);
      if (m === 'POST' && pub) { store.pendingReports = store.pendingReports.filter(i => i.id !== pub[2]); return send(200, { id: pub[2], push: {} }); }
      const delInc = path.match(/^\/festivals\/([^/]+)\/incidents\/([^/]+)$/);
      if (m === 'DELETE' && delInc) { store.pendingReports = store.pendingReports.filter(i => i.id !== delInc[2]); return send(200, { ok: true }); }
      const report = () => ({ startedAt: '2026-10-23T09:00:00Z', finishedAt: '2026-10-23T09:01:00Z', ticketmaster: { skipped: 'TICKETMASTER_KEY not set' }, seatgeek: { calls: 0, errors: 1, lastError: 'fetch failed (ENOTFOUND)', events: 0, festivals: 0, added: 0, updated: 0, duplicates: 0, pruned: 0 }, edmtrain: { calls: 1, errors: 0, events: 40, festivals: 12, added: 3, updated: 9, duplicates: 2, pruned: 0 }, feeds: { skipped: 'FESTIVAL_FEEDS not set' } });
      if (m === 'GET' && path === '/admin/import') return send(200, { ...report(), running: false, finishedAt: store.imports ? '2026-10-23T09:05:00Z' : '2026-10-23T09:01:00Z' });
      if (m === 'POST' && path === '/admin/import') { store.imports++; return send(202, { started: true, running: true, last: report() }); }
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

test('with a backend: its live list is the list, and the admin key unlocks posting, moderation and the sources screen', async () => {
  const { page, context, seen } = await newPage();
  const hula = FESTS.find(f => f.id === 'hulaween-2026');
  const extra = { ...hula, id: 'sub-blackwater-xyz', name: 'Blackwater Gathering', location: 'Lake Wales, FL', latitude: 27.9, longitude: -81.58, origin: 'community', status: 'published', featured: false, feeds: [], site: [], isPartner: false };
  const { server, store, base: api } = await fakeBackend([...FESTS, extra]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.click('button.row:has-text("All festivals")');
    await page.waitForSelector('h1.title:has-text("Which festival?")');
    await page.waitForSelector('button.row:has-text("Blackwater Gathering")');
    assert.ok(store.calls.includes('GET /festivals'), 'the list came from the backend');
    assert.ok(!(await page.$$eval('.bubble .t', els => els.map(e => e.textContent))).includes('Blackwater Gathering'), 'a community festival is listed, not featured');
    await page.click('button:has-text("Suwannee Hulaween")');
    await page.waitForSelector('.sky.warn');

    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('#admin');
    assert.equal(await page.$('button:has-text("Post an update")'), null, 'nothing staff-only without the key');
    await page.fill('#admin', 'k-admin');
    await page.locator('#admin').blur();
    await page.waitForSelector('button:has-text("Post an update")');

    // Post an update as staff: it goes out as an alert and a push.
    await page.click('button:has-text("Post an update")');
    await page.waitForSelector('#p-title');
    assert.ok(await page.$('#p-send[disabled]'), 'nothing to post yet');
    await page.fill('#p-title', 'Medical tent has moved');
    await page.fill('#p-body', 'Now beside the water station at the east gate.');
    await page.click('button.chip:has-text("Heads up")');
    await shot(page, '16-post');
    await page.click('#p-send');
    await page.waitForSelector('.toast.show:has-text("Pushed to 2 phones")');
    assert.deepEqual(store.posts, [{ festival: 'hulaween-2026', key: 'k-admin', title: 'Medical tent has moved', body: 'Now beside the water station at the east gate.', severity: 'moderate' }]);
    await page.waitForSelector('#admin');

    // Review what people reported, before it goes out.
    store.pendingReports.push({ id: 'rep-1', category: 'flood', level: 'warning', summary: 'Flooding behind Stage 2, avoid the path', location: 'Stage 2', source: 'attendee', occurredAt: new Date().toISOString() });
    await page.click('button:has-text("Review reports")');
    await page.waitForSelector('.pend:has-text("Flooding behind Stage 2")');
    await shot(page, '17-moderate');
    await page.click('.pend button:has-text("Publish")');
    await page.waitForSelector('.empty:has-text("Nothing waiting")');
    assert.ok(store.calls.includes('POST /festivals/hulaween-2026/incidents/rep-1/publish'));
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('#admin');

    // The incidents screen, with the report button at the size of a button.
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    await page.click('button.row:has-text("Incidents")'); await page.waitForSelector('h1.title:has-text("Incidents")');
    assert.ok(await page.$('button.btn:has-text("Report a hazard")'));
    assert.deepEqual(await oversizedIcons(page), [], 'the flag on Report a hazard is an icon, not the button');
    await shot(page, '25-incidents');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');

    // Staff say what the ground is and what is standing; the lookups can be run again from here.
    await page.click('button.row:has-text("Ground and what is standing")'); await page.waitForSelector('h1.title:has-text("Ground")');
    assert.match(await page.textContent('.kv:has-text("Surface")'), /Grass.*assumed, nothing found/s);
    assert.ok(await page.$('button.chip.on:has-text("Grass")') && await page.$('button.chip.on:has-text("Average")'), 'nothing found yet: the chips show what is assumed');
    await page.click('button:has-text("Look it up again")'); await page.waitForSelector('.toast.show:has-text("Looked up again")');
    assert.match(await page.textContent('.kv:has-text("Soil")'), /Blanton fine sand.*Drains fast \(A\).*USDA soil survey/s);
    assert.ok(await page.$('button.chip.on:has-text("Fast")'), 'the lookup landed: the soil chip follows it without anyone touching it');
    // Ground that lands while the screen is open (the backend's own lookup, on the live stream) moves the chips too.
    store.ground['hulaween-2026'] = { ...(store.ground['hulaween-2026'] || {}), surface: 'sand', surfaceSource: 'OpenStreetMap: natural=beach' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'ground', at: new Date().toISOString() });
    await page.waitForSelector('button.chip.on:has-text("Sand")');
    await page.click('button.chip:has-text("Paved")'); await page.click('button.chip:has-text("Stage")'); await page.click('button.chip:has-text("No camping")');
    // Once staff have touched a chip, a refresh leaves their choices alone.
    store.ground['hulaween-2026'] = { ...store.ground['hulaween-2026'], surface: 'gravel' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'ground', at: new Date().toISOString() });
    await page.waitForFunction(() => /Gravel/.test(document.querySelector('.kv')?.textContent || ''));
    assert.ok(await page.$('button.chip.on:has-text("Paved")'), 'the readout moved to gravel; the chip staff picked stays');
    assert.ok((await page.$$eval('.chips', rs => rs.map(r => r.getBoundingClientRect().height))).every(h => h < 44), 'every section of chips is one line');
    assert.deepEqual(await page.$$eval('.chips .chip', cs => cs.filter(c => c.scrollWidth > c.clientWidth).map(c => c.textContent)), [], 'and no chip is cut short');
    await page.click('button.btn:has-text("Save")'); await page.waitForSelector('.toast.show:has-text("Saved")');
    assert.ok(store.calls.includes('PUT /festivals/hulaween-2026/ground'));
    assert.deepEqual({ surface: store.ground['hulaween-2026'].surface, structures: store.ground['hulaween-2026'].structures, low: store.ground['hulaween-2026'].low, camping: store.ground['hulaween-2026'].camping }, { surface: 'pavement', structures: ['canopies', 'stage'], low: false, camping: false });
    assert.match(await page.textContent('.kv:has-text("Surface")'), /Blacktop.*staff/s);
    await shot(page, '26-ground');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    assert.match(await page.textContent('button.row:has-text("Ground and what is standing") .s'), /^Blacktop/);
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('#admin');

    // What feeds the list.
    await page.click('button:has-text("Festival sources")');
    await page.waitForSelector('.row:has-text("Edmtrain") .pill.on');
    assert.match(await page.textContent('.row:has-text("Ticketmaster")'), /No key/);
    assert.match(await page.textContent('.row:has-text("SeatGeek")'), /1 errors · fetch failed \(ENOTFOUND\)/, 'the last error is on the screen');
    assert.match(await page.textContent('.row:has-text("Edmtrain")'), /3 added, 9 updated, 2 already listed/);
    await shot(page, '18-sources');
    await page.click('button:has-text("Run now")');
    await page.waitForSelector('.toast.show:has-text("Imported")');
    assert.equal(store.imports, 1);

    // An address typed without https:// still points at the backend, not at a page under this site.
    assert.deepEqual(await page.evaluate(() => { const was = S.backend; setBackend('fieldwatch.example.test/'); const got = [S.backend, cleanURL(' HTTPS://x.test// '), cleanURL('none'), cleanURL('')]; setBackend(was); return got; }), ['https://fieldwatch.example.test', 'HTTPS://x.test', 'none', '']);

    // Check the backend: up, which build, which keys, and whether the admin key matches.
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('#admin');
    await page.click('button.row:has-text("Check the backend")');
    await page.waitForSelector('button.row:has-text("Check the backend") .pill.on');
    const checked = await page.textContent('#app');
    assert.match(checked, /Up, build 4356d78, 14 festivals, data on a volume/);
    assert.match(checked, /Sources on: Edmtrain\. NWS_USER_AGENT is not set\. Last import .*Admin key matches\./);

    // The whole list: search it, hide a listing that is not a festival, unhide it.
    await page.click('button.row:has-text("All festivals")');
    await page.waitForSelector('#catalogQuery');
    assert.match(await page.textContent('.sub'), /\d+ listed/);
    await page.fill('#catalogQuery', 'hulaween');
    await page.waitForSelector('#catalogList .pend:has-text("Suwannee Hulaween")');
    assert.equal(await page.locator('#catalogList .pend').count(), 1, 'the search narrows the list');
    await page.click('#catalogList .pend:has-text("Suwannee Hulaween") button:has-text("Hide")');
    await page.waitForSelector('#catalogList .pend.dim:has-text("hidden")');
    assert.equal(store.list.find(f => f.id === 'hulaween-2026').status, 'hidden');
    await page.click('#catalogList .pend button:has-text("Unhide")');
    await page.waitForSelector('#catalogList .pend:not(.dim) button:has-text("Hide")');
    assert.equal(store.list.find(f => f.id === 'hulaween-2026').status, 'published');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('#admin');

    // A key that does not match says so, instead of blaming the network.
    await page.fill('#admin', 'k-wrong'); await page.locator('#admin').blur();
    await page.click('button.row:has-text("Check the backend")');
    await page.waitForSelector('button.row:has-text("Check the backend") .pill:not(.on):has-text("Problem")');
    assert.match(await page.textContent('#app'), /The admin key here does not match ADMIN_KEY on the backend/);
    await page.click('button:has-text("Festival sources")');
    await page.waitForSelector('.sub:has-text("Wrong admin key")');
    assert.match(await page.textContent('#app'), /must match ADMIN_KEY/);
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('#admin');
    await page.fill('#admin', 'k-admin'); await page.locator('#admin').blur();
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
    // The page asks once, on the festival page, before anyone finds the row.
    assert.equal(await page.textContent('.ask .t'), 'Get warnings for Suwannee Hulaween on this phone');
    await page.click('.ask button:has-text("Not now")');
    assert.equal(await page.$('.ask'), null, 'answered');
    await page.reload(); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.click('.group .row:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.$('.ask'), null, 'and not asked again');
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

test('with location on, the app opens the festival you are standing at, sorts the rest by distance, and places you on the radar', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.4045, longitude: -82.9390 });   // the Hulaween grounds
  await page.goto(`${base}/index.html`);
  await page.click('button:has-text("Use my location")');
  await page.waitForSelector('.sky', { timeout: 10000 });
  assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'no tap needed: you are there');
  await page.click('button.orb:has-text("Radar")');
  await page.waitForSelector('.rmap .me');
  const dot = await page.$eval('.rmap .me', el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
  assert.ok(Math.abs(dot.left - 256) < 2 && Math.abs(dot.top - 256) < 2, 'standing on the grounds means the center of the square');
  await shot(page, '12-radar-me');
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('.sky');
  await page.click('button:has-text("Change")');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.match(await page.textContent('.group .row .t'), /Suwannee Hulaween/, 'the home page keeps your festival at the top');
  await page.click('button.row:has-text("All festivals")');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  assert.equal((await page.$$eval('p.h', els => els.map(e => e.textContent)))[0], 'Right here');
  assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween');
  assert.match(await page.textContent('.bubble .ph'), /right here$/);
  const others = await page.$$eval('.bubble .ph, .row .tr', els => els.map(e => e.textContent).filter(t => / mi$/.test(t)));
  assert.ok(others.length >= 1, 'the others say how far');
  assert.equal(await page.$('.sky'), null, 'after Change, the picker stays put');

  // From far away, nothing opens by itself, and the nearest comes first.
  await context.setGeolocation({ latitude: 39.74, longitude: -104.99 });   // Denver
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.equal(await page.$('.sky'), null, 'from far away nothing opens by itself');
  await page.click('button.row:has-text("All festivals")');
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  await page.waitForFunction(() => /\d mi/.test(document.querySelector('.bubble .ph')?.textContent || ''));
  const dist = await page.$$eval('.bubble .ph', els => els.map(e => Number(e.textContent.match(/([\d,.]+) mi/)?.[1].replace(',', ''))));
  assert.ok(dist.every((d, i) => i === 0 || d >= dist[i - 1]), 'nearest first');
  assert.equal(await page.$('.sky'), null);
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector('button.row:has-text("Use my location") .pill.on');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('share: a link that opens on the festival, and a QR code from the backend to print at the gate', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026`);
    await page.waitForSelector('.sky');
    await page.click('button[aria-label="Share"]');
    await page.waitForSelector('h1.title:has-text("Suwannee Hulaween")');
    const src = await page.getAttribute('.qr img', 'src');
    assert.equal(src, `${api}/festivals/hulaween-2026/qr.svg`);
    await page.waitForFunction(() => document.querySelector('.qr img')?.naturalWidth > 0);
    assert.ok(store.calls.includes('GET /festivals/hulaween-2026/qr.svg'));
    assert.match(await page.textContent('.share-link'), /index\.html\?f=hulaween-2026$/);
    await shot(page, '14-share');
    await page.click('button.btn:has-text("Copy link")');
    await page.waitForSelector('.toast.show:has-text("Link copied")');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `${base}/index.html?f=hulaween-2026`);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a hazard report goes to the moderation queue with your location attached', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.4051, longitude: -82.9401 });
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026`);
    await page.waitForSelector('.sky');
    await page.click('button.row:has-text("Report a hazard")');
    await page.waitForSelector('#r-what');
    await page.waitForSelector('button.row:has-text("Attach my location") .pill.on');
    assert.ok(await page.$('#r-send[disabled]'), 'nothing to send yet');
    await page.fill('#r-what', 'Flooded path behind Stage 2, knee deep');
    await page.fill('#r-where', 'Behind Stage 2');
    assert.equal(await page.$('#r-send[disabled]'), null);
    await shot(page, '15-report');
    await page.click('#r-send');
    await page.waitForSelector('h1.title:has-text("Sent")');
    assert.equal(store.reports.length, 1);
    const r = store.reports[0];
    assert.equal(r.festival, 'hulaween-2026'); assert.equal(r.summary, 'Flooded path behind Stage 2, knee deep'); assert.equal(r.location, 'Behind Stage 2');
    assert.ok(Math.abs(r.latitude - 30.4051) < 1e-6 && Math.abs(r.longitude + 82.9401) < 1e-6, 'your position rides along');
    await page.click('button:has-text("Done")');
    await page.waitForSelector('.sky');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('right where you are: alerts, forecast, radar and warnings for the phone\'s own spot, festival or not', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['geolocation', 'notifications']);
  await context.setGeolocation({ latitude: 39.7392, longitude: -104.9903 });   // Denver: nothing on nearby
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill(json({ name: 'Denver', address: { city: 'Denver', county: 'Denver County', state: 'Colorado' } })));
  await page.addInitScript(() => {
    const sub = { endpoint: 'https://push.example.test/den', unsubscribe: async () => { window.__subscribed = false; return true; }, toJSON: () => ({ endpoint: 'https://push.example.test/den', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) };
    window.__subscribed = false;
    const reg = { pushManager: { getSubscription: async () => (window.__subscribed ? sub : null), subscribe: async () => { window.__subscribed = true; return sub; } } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
    window.PushManager = function PushManager(){};
  });
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('button.row:has-text("Right where you are")');
    await page.click('button.row:has-text("Right where you are")');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Right here');
    await page.waitForFunction(() => /Denver, Colorado/.test(document.querySelector('.sub')?.textContent || ''));
    assert.match(await page.textContent('.eyebrow'), /Your location · (just now|\d+ (min|hr) ago)/);
    assert.ok(seen.alertUrls.some(u => /point=39\.739\d?,-104\.990\d?/.test(u)), 'the weather service is asked about your spot');
    assert.equal(await page.$('button.row:has-text("Report a hazard")'), null, 'no festival, no festival rows');
    assert.equal(await page.$('button[aria-label="Share"]'), null);
    await shot(page, '19-here');
    await page.click('button.row:has-text("Warnings on this phone")');
    await page.waitForSelector('.pill.on');
    assert.deepEqual(store.subs[0].point, { latitude: 39.7392, longitude: -104.9903 }, 'warnings follow the spot');
    assert.equal(store.subs[0].festivalId, undefined);
    await page.click('button.orb:has-text("Radar")');
    await page.waitForSelector('.rmap .me');
    const dot = await page.$eval('.rmap .me', el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
    assert.ok(Math.abs(dot.left - 256) < 2 && Math.abs(dot.top - 256) < 2, 'the radar square is centered on you');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.sky');
    await page.goto(`${base}/index.html?here=1`);
    await page.waitForSelector('.sky');
    assert.equal(await page.textContent('h1.title'), 'Right here', 'a link brings your spot back');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});


test('warnings stay on across a backend redeploy: on open the phone registers again, with a fresh subscription when the key changed', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['notifications']);
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  await page.addInitScript(() => {
    // Warnings were switched on for Hulaween against a key the backend no longer has.
    if (!localStorage.getItem('fieldwatch.web')) localStorage.setItem('fieldwatch.web', JSON.stringify({ fest: 'hulaween-2026', welcomed: true, push: { endpoint: 'https://push.example.test/old', fest: 'hulaween-2026' } }));
    const mk = (endpoint, key) => ({ endpoint, options: { applicationServerKey: key }, unsubscribe: async () => { window.__unsubscribed = endpoint; window.__sub = null; return true; },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) });
    window.__sub = mk('https://push.example.test/old', new Uint8Array([1, 2, 3]).buffer);
    const reg = { pushManager: { getSubscription: async () => window.__sub, subscribe: async o => { window.__key = Array.from(new Uint8Array(o.applicationServerKey)); window.__sub = mk('https://push.example.test/new', o.applicationServerKey); return window.__sub; } } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
    window.PushManager = function PushManager(){};
  });
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.waitForFunction(() => window.__key);
    assert.equal(await page.evaluate(() => window.__unsubscribed), 'https://push.example.test/old', 'the subscription made against the old key is dropped');
    assert.deepEqual(await page.evaluate(() => window.__key), Array.from(Buffer.from('BPUBLICKEY', 'base64url')), 'and a new one made against the key the backend has now');
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('fieldwatch.web')).push.endpoint === 'https://push.example.test/new');
    assert.equal(store.subs.length, 1);
    assert.equal(store.subs[0].quiet, true, 'registered again without a welcome notification');
    assert.equal(store.subs[0].festivalId, 'hulaween-2026');
    assert.equal(store.subs[0].subscription.endpoint, 'https://push.example.test/new');
    await page.click('.group .row:has-text("Suwannee Hulaween")');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('button.row:has-text("Warnings on this phone") .pill'), 'On');
    await page.reload();
    await page.waitForSelector('span.eyebrow:has-text("Right now")');
    assert.equal(store.calls.filter(c => c === 'POST /push/subscribe').length, 1, 'checked once an hour, not on every open');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});


test('the home page is every current alert at every festival that is on: the worst first, a tap opens it on its festival, and a quiet day says so', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('h1.title:has-text("1 warning")');
    assert.match(await page.textContent('.sub'), /2 of \d+ festivals on now with alerts/);
    const cards = await page.$$eval('.feedfest .fh .t', els => els.map(e => e.textContent));
    assert.equal(cards[0], 'Suwannee Hulaween', 'the warning comes before the advisory');
    assert.equal(cards.length, 2);
    assert.deepEqual(await page.$$eval('.feedfest .alert .t', els => els.map(e => e.textContent)), ['Severe Thunderstorm Warning', 'Heat Advisory']);
    assert.ok(await page.$('button.row:has-text("All festivals")'), 'the list is one tap away, not the page');
    await shot(page, '20-feed');
    await page.click('.feedfest .alert:has-text("Severe Thunderstorm Warning")');
    await page.waitForSelector('.alerthead h2:has-text("Severe Thunderstorm Warning")');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'behind the alert is its festival');
    await page.click('button:has-text("Change")');
    await page.waitForSelector('h1.title:has-text("1 warning")');
    assert.match(await page.textContent('.group .row .t'), /Suwannee Hulaween/, 'and the festival you opened stays at the top of the home page');

    store.feed = [];
    await page.click('button[aria-label="Refresh"]');
    await page.waitForSelector('h1.title:has-text("All clear")');
    assert.match(await page.textContent('.empty'), /Nothing to worry about/);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('storms on the way: a countdown on the festival page with the first things to do, and the step-by-step prep screen behind it', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  // The fixture forecast, moved so that its storm window (thunder 40% from hour 3) starts in two to three hours.
  const H = 3600000, offset = Math.floor(Date.now() / H) * H - Date.UTC(2026, 9, 23, 18);
  const shiftT = t => new Date(Date.parse(t) + offset).toISOString();
  const hourlyNow = { properties: { ...hourly.properties, periods: hourly.properties.periods.map(p => ({ ...p, startTime: shiftT(p.startTime), endTime: shiftT(p.endTime) })) } };
  const shiftSeries = s => ({ ...s, values: s.values.map(v => { const [a, d] = v.validTime.split('/'); return { ...v, validTime: `${shiftT(a)}/${d}` }; }) });
  const gridNow = { properties: { ...grid.properties, heatIndex: shiftSeries(grid.properties.heatIndex), windGust: shiftSeries(grid.properties.windGust), probabilityOfThunder: shiftSeries(grid.properties.probabilityOfThunder) } };
  await page.route(/gridpoints\/.*\/forecast\/hourly/, r => r.fulfill(json(hourlyNow)));
  await page.route(/gridpoints\/[^/]+\/[\d,]+$/, r => r.fulfill(json(gridNow)));
  try {
  // Like pickHulaween, but on the fake backend (enter() would reload without it).
  await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
  await page.click('button:has-text("Use my location")');
  await page.click('button.row:has-text("All festivals")'); await page.waitForSelector('h1.title:has-text("Which festival?")');
  await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
  await page.waitForSelector('.headsup');
  assert.equal(await page.textContent('.headsup h3'), 'Storms');
  assert.match(await page.textContent('.headsup .eyebrow'), /On the way/);
  assert.match(await page.textContent('.hu-when'), /^in [23] h \d+ m$|^in 3 h 0 m$/, 'the countdown, two to three hours out');
  assert.match(await page.textContent('.headsup p'), /^Around \d+:00 [AP]M until \d+:00 [AP]M · thunder 60%, gusts to 34 mph past the canopy line$/, 'gusts named against what is standing');
  assert.deepEqual(await page.$$eval('.hu-steps .st .task', els => els.map(e => e.textContent)), ['Stake every loop, tie guy lines, weigh the legs', 'Unplug and bag electronics', 'Move poles and chairs away from where people sit'], 'the longest task first');
  assert.ok((await page.$$eval('.hu-steps .st .by', els => els.map(e => e.textContent))).every(t => /^by \d+:\d\d [AP]M$/.test(t)), 'each with a start-by time');
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning', 'the warning already in effect stays on the sky; the heads-up is its own card');
  await shot(page, '21-headsup');
  // The countdown ticks on its own; a minute makes no visible difference here, but the element is live.
  assert.equal(await page.evaluate(() => { tickCountdowns(); return document.querySelectorAll('[data-countdown]').length; }), 1);

  await page.click('.headsup');
  await page.waitForSelector('h1.title:has-text("Storms")');
  assert.match(await page.textContent('.countdown b'), /^[23] h \d+ m$/);
  assert.match(await page.textContent('.countdown .s'), /^Secure camp now/);
  assert.match(await page.textContent('.todo'), /Where to shelter.*hard-topped vehicle/s);
  const camp = await page.$$eval('.steps .step .task', els => els.map(e => e.textContent));
  assert.match(await page.textContent('.steps .step:first-child .by'), /^by \d+:\d\d [AP]M$/, 'start-by times on the camp list');
  // Hulaween is a camping festival, so the list is a camper's; a day visitor gets their own, with no tent in it.
  assert.ok(await page.$('button.chip.on:has-text("I\'m camping")'));
  await page.click('button.chip:has-text("Day visitor")');
  const dayList = await page.$$eval('.steps .step .task', els => els.map(e => e.textContent));
  assert.equal(dayList[0], 'Charge the phone, fill water'); assert.ok(!dayList.some(t => /canop|tent/i.test(t)), `no tents for a day visitor: ${dayList}`);
  await page.click('button.chip:has-text("I\'m camping")');
  assert.ok(camp.includes('Drop pop-up canopies and flags') && camp.includes('Unplug and bag electronics'), 'the camp list');
  assert.ok(camp.includes('Phone and a battery pack'), 'and what to pack for shelter');
  assert.deepEqual(await page.$$eval('.tl .k', els => els.map(e => e.textContent)), ['Earlier', 'Three hours out', 'One hour out', 'Twenty minutes out', 'While it is here', 'After']);
  assert.equal(await page.textContent('.tl.now .k'), 'Three hours out', 'the timeline knows where you are on it');
  assert.match(await page.textContent('.tl:last-child'), /thirty minutes after the last thunder/);
  // One tap says what the ground is doing; the venue learns from it, and the card repeats it.
  assert.match(await page.textContent('.note:has-text("One tap tells everyone here")'), /teaches the app how much rain this ground takes/);
  await page.click('button.chip:has-text("Mud")'); await page.waitForSelector('.toast.show:has-text("Reported: mud")');
  assert.ok(store.calls.includes('POST /festivals/hulaween-2026/ground/report'));
  assert.match(await page.textContent('.note:has-text("Last reported")'), /Last reported mud just now\. This ground goes soft at about 0\.90 in, from 1 report\./);
  assert.ok(await page.$('button.chip.on:has-text("Mud")'));
  await shot(page, '22-prep');
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('.headsup');
  assert.match(await page.textContent('.headsup p'), /· reported mud just now$/);
  // Rain already on the radar, 35 minutes out, pulls the countdown in and says where it is coming from.
  store.nowcast = { 'hulaween-2026': { at: new Date().toISOString(), tracked: true, minutes: 35, speedKmh: 40, headingDeg: 45, heading: 'NE', raining: false, ageMinutes: 0 } };
  await page.click('button[aria-label="Refresh"]'); await page.waitForSelector('.hu-when:has-text("min")');
  assert.match(await page.textContent('.hu-when'), /^in 3[3-5] min$/);
  assert.match(await page.textContent('.headsup p'), /on the radar, moving NE at 25 mph/);
  assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('lightning codes: a red on the festival page with the all-clear countdown, the screen behind it, and the code on the home page', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const minutesAgo = n => new Date(Date.now() - n * 60000).toISOString(), allClearAt = new Date(Date.now() + 27 * 60000).toISOString();
  store.lightning['hulaween-2026'] = { code: 'red', nearestMi: 3.6, nearestAt: minutesAgo(3), within: { 8: 2, 12: 4, 20: 9 }, lastNearMi: 3.6, lastNearAt: minutesAgo(3), allClearAt, orangeUntil: null, at: minutesAgo(0), dataAt: minutesAgo(1), source: 'GOES GLM' };
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('h1.title:has-text("1 warning")');
    assert.equal(await page.textContent('.feedfest:has-text("Suwannee Hulaween") .fh .pill'), 'Code red', 'the code sits on the festival\'s card on the home page');
    await page.click('.feedfest .alert:has-text("Severe Thunderstorm Warning")');
    await page.waitForSelector('.alerthead');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.bolt.red');
    assert.equal(await page.textContent('.bolt .t'), 'Lightning 3.6 mi · Code red');
    assert.match(await page.textContent('.bolt .s'), /^Rapid evacuation, full work stoppage · all clear in 2[67] min$/);
    assert.ok(await page.$('.sky.warn'), 'the warning stays on the sky; lightning is its own tile');
    await shot(page, '23-lightning-home');
    await page.click('.bolt');
    await page.waitForSelector('h1.title:has-text("Lightning")');
    assert.equal(await page.textContent('.codehead h2'), 'Code red');
    assert.match(await page.textContent('.codehead p'), /^Nearest flash 3\.6 mi, \d+:\d\d [AP]M$/);
    assert.match(await page.textContent('.codehead b'), /^2[67] min$/);
    assert.match(await page.textContent('.code.now .t'), /Code red · Under 8 miles/);
    assert.match(await page.textContent('.code.red'), /Non-essential personnel should prioritize exit and do not need to maintain posts\. Full work stoppage\./, 'the protocol in its own words');
    assert.match(await page.textContent('.code.orange'), /Execute evacuation procedures while maintaining assigned posts/);
    assert.match(await page.textContent('.code.yellow'), /prepared for orange and a potential work stoppage/);
    assert.deepEqual(await page.$$eval('.kv .v', els => els.slice(0, 3).map(e => e.textContent)), ['2', '4', '9']);
    assert.match(await page.textContent('.note'), /lightning vendor|safety staff are the authority/);
    await shot(page, '24-lightning');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.bolt.red');
    // A minute later, green: the backend says so down the live stream, and the tile changes with no reload and no poll.
    assert.equal(store.live.length, 1, 'the page holds one live stream open');
    store.lightning['hulaween-2026'] = { code: 'green', nearestMi: null, nearestAt: null, within: { 8: 0, 12: 0, 20: 0 }, lastNearMi: null, lastNearAt: null, allClearAt: null, orangeUntil: null, at: minutesAgo(0), dataAt: minutesAgo(0), source: 'GOES GLM' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'lightning', at: minutesAgo(0) });
    await page.waitForSelector('.bolt.green');
    assert.equal(await page.textContent('.bolt .t'), 'No lightning within 20 mi · Code green');
    // A new alert on the stream pulls the whole festival again; one at another festival does not.
    const pulls = () => store.calls.filter(c => c === 'GET /festivals/hulaween-2026/ground').length, settle = () => new Promise(r => setTimeout(r, 400));
    const was = pulls();
    store.emit({ festivalId: 'not-this-one', kind: 'alerts', at: minutesAgo(0) }); await settle();
    assert.equal(pulls(), was, 'another festival\'s change is not ours');
    store.emit({ festivalId: 'hulaween-2026', kind: 'alerts', at: minutesAgo(0) });
    for (let i = 0; i < 50 && pulls() === was; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(pulls(), was + 1, 'ours pulls the festival once');
    // Orange with no alert at all still puts a festival on the home page, as its own row.
    const other = FESTS.find(f => isLive(f) && f.id !== 'hulaween-2026');
    store.feed = [{ festivalId: other.id, alerts: [] }];
    store.lightning = { [other.id]: { code: 'orange', nearestMi: 11.2, nearestAt: minutesAgo(2), within: { 8: 0, 12: 1, 20: 3 }, lastNearMi: null, lastNearAt: null, allClearAt: null, orangeUntil: new Date(Date.now() + 13 * 60000).toISOString(), at: minutesAgo(0), dataAt: minutesAgo(0), source: 'GOES GLM' } };
    await page.click('button:has-text("Change")');
    await page.waitForSelector('h1.title:has-text("1 advisory")');
    assert.equal(await page.textContent('.feedfest .alert .t'), 'Lightning 11.2 mi');
    assert.equal(await page.textContent('.feedfest .alert .s'), 'Code orange · Evacuation procedures, staff hold posts');
    assert.equal(await page.textContent('.feedfest .fh .pill'), 'Code orange');
    await page.click('.feedfest .alert');
    await page.waitForSelector('.codehead.orange');
    assert.equal(await page.textContent('h1.title'), 'Lightning');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('staff settings stay out of sight: the backend address and the admin key show after five taps on the credits, or with ?staff=1', async () => {
  const { page, context, seen } = await newPage();
  try {
    await page.goto(`${base}/index.html`);
    await page.click('button:has-text("Use my location")');
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('h1.title:has-text("Settings")');
    assert.equal(await page.$('#backend'), null, 'no backend address for the public');
    assert.equal(await page.$('#admin'), null, 'no admin key either');
    assert.ok(await page.$('button.row:has-text("Use my location")') && await page.$('button.row:has-text("Forget saved data")'), 'what is left is theirs');
    for (let i = 0; i < 5; i++) await page.click('.note.credits');
    await page.waitForSelector('#admin');
    assert.ok(await page.$('#backend'));
    assert.equal(await page.textContent('#toast'), 'Staff settings shown');
    await page.reload();
    await page.click('button[aria-label="Settings"]');
    await page.waitForSelector('#admin', { timeout: 5000 });
    await shot(page, '25-settings-staff');
  } finally { await context.close(); }
  const other = await newPage();
  try {
    await other.page.goto(`${base}/index.html?staff=1`);
    await other.page.click('button:has-text("Use my location")');
    await other.page.click('button[aria-label="Settings"]');
    await other.page.waitForSelector('#admin', { timeout: 5000 });
    assert.deepEqual(other.seen.errors, []);
  } finally { await other.context.close(); }
  assert.deepEqual(seen.errors, []);
});
