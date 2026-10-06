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
  // CHROMIUM names a build; this container keeps one at /opt/pw-browsers/chromium; anywhere else (CI) the one `playwright-core install chromium` fetched.
  const executablePath = process.env.CHROMIUM || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : chromium.executablePath());
  browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });
});
after(async () => { await browser?.close(); server?.close(); });

const json = obj => ({ status: 200, contentType: 'application/geo+json', body: JSON.stringify(obj) });

/** A phone-sized page whose outside requests are answered by fixtures. `live` flips the weather service on and off. */
async function newPage(opts = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    timezoneId: 'America/New_York', locale: 'en-US', serviceWorkers: 'block', colorScheme: opts.dark ? 'dark' : 'light' });
  // Every page but the walkthrough's own test has taken the tour, so its coach marks never sit over what a test taps.
  if (!opts.tour) await context.addInitScript(() => { try { const d = JSON.parse(localStorage.getItem('fieldwatch.web') || '{}'); if (!d.toured) localStorage.setItem('fieldwatch.web', JSON.stringify({ ...d, toured: true })); } catch (e) {} });
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
// Without a location the festivals list is the home page; the picker is one tap away on it.
/** The whole list is behind the Festivals tile of the dashboard: a tap on it, then the list. */
const openPicker = async page => { await page.click('.tiles.dash .kpi:has(.k:text-is("Festivals"))'); await page.waitForSelector('h1.title:has-text("Which festival?")'); };
const enter = async page => { await page.goto(`${base}/index.html`); await page.waitForSelector('h1.title'); const start = page.locator('button:has-text("Use my location")'); if (await start.count()) await start.click(); await openPicker(page); };
/** Back from a long screen after a tap far down it: the top first, a frame to settle, then the button. A click while the page is still re-laying out around the scroll is what the runner's slow Chromium reports as an unstable element. */
const backToTop = async page => { await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(350); await page.click('button[aria-label="Back"]'); };
/** A chip far down a long screen: into view, a frame to settle, then the tap itself (the runner's slow Chromium reports the chip unstable while the page settles around the scroll). */
const tapChip = async (page, text) => {
  const chip = page.locator(`button.chip:has-text("${text}")`);
  for (let i = 0; ; i++) {   // a render landing under the tap replaces the chip: the one found is then detached, so find it again
    try { await chip.scrollIntoViewIfNeeded(); await page.waitForTimeout(350); await chip.click({ force: true }); return; }
    catch (e) { if (i >= 2 || !/not attached|detached|not stable/i.test(String(e))) throw e; }
  }
};
const pickHulaween = async page => { await enter(page); await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn'); };
/** Icons that grew past their box: an SVG outside a chart or the radar wider than 70 px is a button swallowed by its icon (Safari does this to an unsized SVG in a flex row). */
const oversizedIcons = page => page.$$eval('svg', els => els.filter(e => !e.closest('.chart, .rmap, #crew, .scene, .illus') && e.getBoundingClientRect().width > 70).map(e => `${e.parentElement.className || e.parentElement.tagName} ${Math.round(e.getBoundingClientRect().width)}px`));

test('the walkthrough opens once: an intro scene, pages that teach, a start page; the first festival page gives the tour; then only what is on', async () => {
  const { page, context, seen } = await newPage({ tour: true });
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title');
  assert.equal(await page.textContent('h1.title'), 'Fieldwatch');
  // The cover is the intro scene; four pages follow, the last with the two ways in. Next and Skip page through; the dots follow.
  assert.equal(await page.$$eval('.walk .page', els => els.length), 5);
  assert.ok(await page.$('.walk .cover .scene .zap'), 'the cover is the intro scene');
  assert.deepEqual(await page.$$eval('.walk .page h2', els => els.map(e => e.textContent)), ['Start with the sky', 'Know your lightning code', 'Radar, forecast, and a plan', 'Warnings come to you']);
  assert.equal(await page.$$eval('.trio .orb', els => els.length), 3);
  assert.deepEqual(await page.$$eval('.codes .crow .pill', els => els.map(e => e.textContent)), ['Code Red', 'Code Orange', 'Code Yellow', 'Code Green'], 'the codes page lists the four, red first');
  await shot(page, '0-welcome');
  await page.click('.walk .nav .next'); await page.waitForFunction(() => S.walkStep === 1);
  assert.equal(await page.$eval('.walk .dots i.on', e => [...e.parentNode.children].indexOf(e)), 1, 'the dots follow');
  await page.click('.walk .nav button:has-text("Skip")'); await page.waitForFunction(() => S.walkStep === 4);
  assert.ok(await page.$('.walk .nav.last'), 'on the start page the nav steps aside');
  await shot(page, '0b-start');
  await page.click('button:has-text("pick a festival")');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.equal(await page.textContent('h1.title'), 'Festivals', 'without a location the festivals list is the home page');
  assert.deepEqual(await page.evaluate(() => [S.geoDenied, S.geoSkip]), [false, true], 'picking a festival is not a denial: location can still be asked for');
  assert.match(await page.textContent('.sub'), /warning|advisor|All clear|Checking|No signal/, 'and its line says what is happening');
  await openPicker(page);
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  // The list has a way back to the home page.
  await page.click('button[aria-label="Back"]');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  await openPicker(page);
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  const on = FESTS.filter(f => isLive(f)), off = FESTS.filter(f => !isLive(f));
  assert.ok(on.length >= 2 && off.length >= 2, 'the fixture has festivals on and festivals not on');
  const names = (await page.$$eval('.bubble .t, .row .t', els => els.map(e => e.textContent))).filter(n => n !== 'Right where you are');
  assert.deepEqual(new Set(names), new Set(on.map(f => f.name)), 'exactly the festivals whose grounds are open, nothing that is weeks away or over');
  assert.equal(await page.$$eval('.bubble', els => els.length), Math.min(6, on.length));
  assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween', 'the one happening now comes first');
  assert.equal(await page.textContent('.bubble .ph'), 'Happening now');
  assert.match(await page.textContent('button:has-text("Sick New World")'), /Gates in \d days|Gates tomorrow/, 'a day out: early entry and crews are already there');
  assert.equal((await page.$$eval('p.h', els => els.map(e => e.textContent)))[0], 'Now');
  assert.match(await page.textContent('.note'), /week before gates/);
  await shot(page, '1-picker');
  assert.equal(await page.$('input[type="search"]'), null, 'no search box: what is on is the whole list');
  assert.ok(await page.$('button.row:has-text("Right where you are")'), 'your own spot is always an option');
  // The first festival page gives the tour: a spotlight per element, Next through to Done, remembered after.
  await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
  await page.waitForSelector('#coach .card .t');
  const anchors = [['.sky', 'This is the sky right now'], ['.bolt', 'Your lightning code'], ['.orbrow', 'Radar, alerts and forecast'], ['.tb.fav', 'Make this one yours'], ['.topbar .side:first-child .tb', "Everything else that's on"]];
  const steps = []; for (const a of anchors) if (await page.$(a[0])) steps.push(a);
  assert.equal(steps.length, 4, 'with no backend there is no lightning tile, so its step is skipped; the rest stand');
  await page.waitForTimeout(600);   // the page's own rise has ended; the spotlight has been measured against the settled page
  assert.equal(await page.getAttribute('#coach', 'role'), 'dialog'); assert.equal(await page.getAttribute('#coach', 'aria-modal'), 'true');
  assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.textContent), 'Next', 'each step hands focus to Next');
  for (let i = 0; i < steps.length; i++) {
    await page.waitForTimeout(400);
    assert.equal(await page.textContent('#coach .card .k'), `${i + 1} of ${steps.length}`);
    assert.equal(await page.textContent('#coach .card .t'), steps[i][1]);
    const spot = await page.$eval('#coach .spot', e => ({ x: parseFloat(e.style.left), y: parseFloat(e.style.top) })), target = await page.$eval(steps[i][0], e => e.getBoundingClientRect());
    assert.ok(Math.abs(spot.x + 6 - target.x) < 2 && Math.abs(spot.y + 6 - target.y) < 2, `step ${i + 1} spotlights ${steps[i][0]}: ${JSON.stringify(spot)} vs ${target.x},${target.y}`);
    if (i === 0) await shot(page, '0c-tour');
    assert.equal(await page.textContent('#coach .card .acts .btn:not(.quiet)'), i === steps.length - 1 ? 'Got it' : 'Next');
    await page.click('#coach .card .acts .btn:not(.quiet)');
    if (i < steps.length - 1) await page.waitForFunction(n => (document.querySelector('#coach .card .k') || {}).textContent === n, `${i + 2} of ${steps.length}`);
  }
  await page.waitForSelector('#coach', { state: 'detached' });
  assert.equal(await page.evaluate(() => S.toured), true);
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.notEqual(await page.textContent('h1.title'), 'Fieldwatch', 'the welcome step is shown once');
  assert.equal(await page.evaluate(() => S.toured), true, 'and the tour is remembered');
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
  assert.ok(seen.alerts >= 1, 'alerts came from the weather service (the home page asks for the nearest festivals too)'); assert.equal(seen.points, 1); assert.equal(seen.hourly, 1);
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
  assert.match(await page.textContent('details.more .sec:has-text("Instructions")'), /interior room/, 'the weather service instruction is under Full alert');
  assert.match(await page.textContent('details.more'), /near Live Oak/);
  assert.deepEqual(await page.$$eval('.secs .sec .k', els => els.map(e => e.textContent)), ['Instructions', 'Statement'], 'long text is stacked under small labels');
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
  assert.equal(ticks.length, 5); for (const t of ticks.slice(0, 4)) assert.match(t, /\d/); assert.equal(ticks[4], 'Now', 'the right end of the scrubber is the present');
  assert.deepEqual(await page.evaluate(() => [frameMs(48), frameMs(72), frameMs(6)]), [313, 208, 400], 'a pass over the loop takes about fifteen seconds, whatever the step');
  assert.equal(await page.$eval('#radar-progress', el => el.style.width), '100%');
  assert.deepEqual(await page.$$eval('.rmap .ring', els => els.map(e => e.textContent)), ['8 mi', '12 mi', '20 mi'], 'the rings around the pin');
  assert.equal(await page.$('.rmap .arrive'), null, 'nothing is coming: no badge');
  await shot(page, '5-radar');

  await page.click('#radar-play');
  assert.equal(await page.getAttribute('#radar-play', 'aria-label'), 'Play');
  await page.locator('#radar-slider').fill('3');
  await page.$eval('#radar-slider', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  const shown = await page.$$eval('.frame', els => els.findIndex(e => e.classList.contains('on')));
  assert.equal(shown, 3);
  assert.equal(await page.$('.stamp.now'), null, 'an older frame is not the present');
  await page.locator('#radar-slider').fill('47');
  await page.$eval('#radar-slider', el => el.dispatchEvent(new Event('input', { bubbles: true })));
  assert.ok(await page.$('.stamp.now') && await page.$('#radar-slider.now'), 'the latest frame is marked as now on the stamp and the thumb');
  assert.equal(await page.$eval('#radar-now', el => getComputedStyle(el).display), 'inline-flex');
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
  await page.waitForFunction(() => /No signal since/.test(document.querySelector('.sky .foot')?.textContent || ''));
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning', 'the cached alert is still shown');
  await shot(page, '6-offline');

  await page.reload();
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.match(await page.textContent('.feedfest:has-text("Suwannee Hulaween") .alert .t'), /Severe Thunderstorm Warning/, 'the home page shows the warning from its cache');
  await page.click('.feedfest:has-text("Suwannee Hulaween") .alert'); await page.waitForSelector('.alerthead');
  await page.click('button[aria-label="Back"]');
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
  const store = { list: [...list], pending: [], subs: [], reports: [], posts: [], retracted: [], pendingReports: [], imports: 0, calls: [], feed: null, lightning: {}, ground: {}, partnerKeys: {} };
  store.groundReports = {}; store.alerts = {}; store.radar = {}; store.staff = {}; store.lsr = {};
  const CODE_RANK = { red: 4, orange: 3, yellow: 2, green: 1, none: 0 };
  // The lightning the page sees: the mapper's grade, raised to the code staff set while it stands (backend/src/lightning.js lightningFor).
  const lightningOf = id => { const base = store.lightning[id] || { code: 'none', at: new Date().toISOString(), on: true, source: 'GOES GLM' }, st = store.staff[id]; return st ? { ...base, code: (CODE_RANK[st.code] || 0) > (CODE_RANK[base.code] || 0) ? st.code : base.code, staff: st } : base; };
  // The live stream: open responses, and a way for a test to push a change to every page on it (backend/src/live.js).
  store.live = [];
  store.emit = e => store.live.forEach(r => r.write(`event: change\ndata: ${JSON.stringify(e)}\n\n`));
  const groundOf = id => ({ surface: 'grass', soil: 'B', low: false, structures: ['canopies'], surfaceSource: 'assumed', soilSource: 'assumed', soilName: null, drainage: null, past: null, override: null, learned: null, reports: store.groundReports[id] ? { last: store.groundReports[id][0], recent: store.groundReports[id].length } : null, ...(store.ground[id] || {}) });
  // What the home page shows: the fixture's warning at Hulaween, an advisory at the next festival that is on.
  const p = alertFeature().properties, toAlert = over => ({ id: p.id, event: p.event, headline: p.headline ?? null, body: p.description ?? '', instruction: p.instruction ?? null, severity: String(p.severity || 'Unknown').toLowerCase(), area: p.areaDesc ?? '', source: p.senderName ?? 'NWS', issuedAt: p.effective, expiresAt: p.ends ?? p.expires ?? null, channel: 'weather', relayCount: 0, ...over });
  const other = store.list.find(f => isLive(f) && f.id !== 'hulaween-2026');
  // Hulaween's warning comes twice, as the weather service lists an update beside the message it replaced: the page shows it once.
  store.feed = [{ festivalId: 'hulaween-2026', alerts: [toAlert({}), toAlert({ id: 'urn:oid:feed-twice', issuedAt: '2026-10-23T13:02:00-04:00' })] }, ...(other ? [{ festivalId: other.id, alerts: [toAlert({ id: 'urn:oid:feed-adv', event: 'Heat Advisory', severity: 'minor', headline: 'Heat Advisory until 8 PM' })] }] : [])];
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS', 'access-control-allow-headers': 'Content-Type, x-admin-key' };
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', c => { raw += c; }); req.on('end', () => {
      const path = req.url.split('?')[0], m = req.method, key = req.headers['x-admin-key'];
      store.calls.push(`${m} ${path}`);
      const send = (status, body) => { res.writeHead(status, { ...cors, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const statsBodyPublic = fid => { const days = Number(new URL(req.url, 'http://x').searchParams.get('days') || 7); const series = Array.from({ length: days }, (_, i) => ({ day: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10), counts: { alerts: 10 + i, pack: 2, follow: 1, 'alert.new': i % 3 ? 0 : 1, 'push.web': 20 } }));
        return { days, at: new Date().toISOString(), totals: { alerts: 120, pack: 14, follow: 9, 'alert.new': 3, 'push.web': 140, headsup: 2, report: 4, post: 1 }, series, alertLatencySeconds: 41, opens: 134, following: 57, followRate: 7, delivered: { sent: 140, gone: 3, failed: 1, rate: 97 }, codes: { green: 600, yellow: 0, orange: 0, red: 25 },
          ...(fid ? {} : { stale: { poll: 0, lightning: 2, radar: 0 }, festivals: store.list.filter(f => isLive(f)).map(f => ({ id: f.id, name: f.name, counts: {}, opens: 50, following: 12, pushed: 40 })) }) }; };
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
      if (m === 'GET' && path === '/alerts') return send(200, { at: new Date().toISOString(), on: store.list.filter(f => isLive(f) && f.status !== 'hidden').length, items: (store.feed || []).map(x => ({ festival: store.list.find(f => f.id === x.festivalId), alerts: x.alerts, lightning: store.lightning[x.festivalId] || null })).filter(i => i.festival), codes: { ...store.lightning } });
      const gr = path.match(/^\/festivals\/([^/]+)\/ground$/);
      if (m === 'GET' && gr) return send(200, groundOf(gr[1]));
      const rad = path.match(/^\/festivals\/([^/]+)\/radar$/);
      if (m === 'GET' && rad && store.radar[rad[1]]) return send(200, store.radar[rad[1]]);
      if (m === 'GET' && /^\/radar\/[^/]+\/[^/]+\.png$/.test(path)) { res.writeHead(200, { ...cors, 'content-type': 'image/png' }); return res.end(PNG); }
      const fal = path.match(/^\/festivals\/([^/]+)\/alerts$/);
      if (m === 'GET' && fal && store.alerts[fal[1]]) return send(200, store.alerts[fal[1]]);
      const grr = path.match(/^\/festivals\/([^/]+)\/ground\/report$/);
      if (m === 'POST' && grr) { const b = JSON.parse(raw); if (!['fine', 'soft', 'mud', 'water'].includes(b.state)) return send(400, { error: 'state' }); store.groundReports[grr[1]] = [{ state: b.state, at: new Date().toISOString() }, ...(store.groundReports[grr[1]] || [])]; return send(200, { ok: true, state: b.state, effective: 0.9, learned: b.state === 'fine' ? null : { threshold: 0.9, samples: store.groundReports[grr[1]].length, at: new Date().toISOString() }, reports: groundOf(grr[1]).reports }); }
      const ncm = path.match(/^\/festivals\/([^/]+)\/nowcast$/);
      if (m === 'GET' && ncm) return send(200, (store.nowcast || {})[ncm[1]] || { at: null, tracked: false, minutes: null });
      const pl = path.match(/^\/point\/(-?[\d.]+),(-?[\d.]+)\/lightning$/);
      if (m === 'GET' && pl) return send(200, store.pointLightning || { code: 'none', warming: true, readyAt: new Date(Date.now() + 15 * 60000).toISOString(), at: new Date().toISOString(), source: 'GOES GLM', point: true });
      const plf = path.match(/^\/point\/(-?[\d.]+),(-?[\d.]+)\/lightning\/flashes$/);
      if (m === 'GET' && plf) return send(200, { at: new Date().toISOString(), on: true, flashes: store.pointFlashes || [] });
      const fla = path.match(/^\/festivals\/([^/]+)\/lightning\/flashes$/);
      if (m === 'GET' && fla) return send(200, { festivalId: fla[1], at: new Date().toISOString(), on: true, flashes: (store.flashes || {})[fla[1]] || [] });
      const bolt = path.match(/^\/festivals\/([^/]+)\/lightning$/);
      if (m === 'GET' && bolt) return send(200, lightningOf(bolt[1]));
      const lsr = path.match(/^\/festivals\/([^/]+)\/storm-reports$/);
      if (m === 'GET' && lsr) return send(200, { at: new Date().toISOString(), reports: store.lsr[lsr[1]] || [] });
      const pg = path.match(/^\/point\/(-?[\d.]+),(-?[\d.]+)\/ground$/);
      if (m === 'GET' && pg) return send(200, { ...groundOf(`pt:${pg[1]},${pg[2]}`), ...(store.pointGround || {}), point: true });
      if (m === 'GET' && path === '/push/vapid') return send(200, { key: 'BPUBLICKEY' });
      if (m === 'GET' && path === '/health') return send(200, { ok: true, at: '2026-10-23T09:00:00Z', build: '4356d78', uptimeSeconds: 61, database: { path: '/data/fieldwatch.db', onVolume: true }, festivals: 14, push: { web: true }, adminKey: 'database', nwsUserAgent: 'default', userAgent: 'Fieldwatch/0.1.0 (+https://fieldwatch.test/)', sources: { ticketmaster: false, seatgeek: false, edmtrain: true, wikidata: 'WIKIDATA_IMPORT=false', feeds: false }, imports: { running: false, lastStartedAt: '2026-10-23T09:00:00Z', lastFinishedAt: '2026-10-23T09:01:00Z' } });
      const sameFollow = (s, b) => s.subscription.endpoint === b.endpoint && (b.festivalId ? s.festivalId === b.festivalId : !s.festivalId);
      if (m === 'POST' && path === '/push/subscribe') { const b = JSON.parse(raw); store.subs = store.subs.filter(s => !sameFollow(s, { endpoint: b.subscription.endpoint, festivalId: b.festivalId })); store.subs.push(b); return send(200, { ok: true }); }
      if (m === 'DELETE' && path === '/push/subscribe') { const b = JSON.parse(raw || '{}'); store.subs = store.subs.filter(s => b.festivalId || b.here ? !sameFollow(s, b) : s.subscription.endpoint !== b.endpoint); return send(200, { ok: true }); }
      if (m === 'GET' && path === '/stats') return send(200, statsBodyPublic(null));
      const fst = path.match(/^\/festivals\/([^/]+)\/stats$/);
      if (m === 'GET' && fst) return send(200, statsBodyPublic(fst[1]));
      const postList = path.match(/^\/festivals\/([^/]+)\/posts$/);
      if (m === 'GET' && postList) return send(200, store.posts.map((p, i) => ({ id: String(i + 1), ...p, festival: undefined, key: undefined, postedAt: p.postedAt || new Date().toISOString(), kind: p.kind || 'notice', reach: 2 })).filter((p, i) => store.posts[i].festival === postList[1] && !store.retracted.includes(String(i + 1))));
      // The admin key does everything; a festival's staff key does that festival's staff routes.
      const partnerOf = store.partnerKeys[key] || null, keyedFest = (path.match(/^\/festivals\/([^/]+)(?:\/|$)/) || [])[1];
      if (m === 'GET' && path === '/staff/me') return key === 'k-admin' ? send(200, { scope: 'admin' }) : partnerOf ? send(200, { scope: 'partner', festivalId: partnerOf, name: store.list.find(f => f.id === partnerOf)?.name }) : send(401, { error: 'x-admin-key required' });
      const pk = path.match(/^\/festivals\/([^/]+)\/partner-key$/);
      if (m === 'POST' && pk) { if (key !== 'k-admin') return send(401, { error: 'x-admin-key required' }); const issued = `k-${pk[1]}`; store.partnerKeys[issued] = pk[1]; return send(200, { festivalId: pk[1], key: issued, link: `https://example.test/?f=${pk[1]}&staff=1` }); }
      if (key !== 'k-admin' && !(partnerOf && partnerOf === keyedFest)) return send(401, { error: 'x-admin-key required' });
      if (m === 'PUT' && bolt) { const b = JSON.parse(raw); if (!['green', 'yellow', 'orange', 'red'].includes(b.code)) return send(400, { error: 'code' }); store.staff[bolt[1]] = { code: b.code, until: new Date(Date.now() + Math.min(180, Math.max(5, Number(b.minutes) || 60)) * 60000).toISOString(), note: String(b.note || '').slice(0, 200), at: new Date().toISOString() }; return send(200, lightningOf(bolt[1])); }
      if (m === 'DELETE' && bolt) { const had = Boolean(store.staff[bolt[1]]); delete store.staff[bolt[1]]; return send(200, { ok: true, released: had, ...lightningOf(bolt[1]) }); }
      const lg = path.match(/^\/festivals\/([^/]+)\/log$/);
      if (m === 'GET' && lg) { const u = new URL(req.url, 'http://x'), rows = [['2026-10-23T14:02:00Z', 'alert', 'Severe Thunderstorm Warning', '{}'], ['2026-10-23T15:10:00Z', 'lightning-staff', 'orange', '{}']]; if (u.searchParams.get('format') !== 'csv') return send(200, { festivalId: lg[1], days: 30, rows: [] }); res.writeHead(200, { ...cors, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${lg[1]}-record.csv"` }); return res.end(['at,kind,what,detail', ...rows.map(r => r.map(c => `"${c}"`).join(','))].join('\n') + '\n'); }
      // Metrics with nobody in them (backend/src/metrics.js): the same body for everyone, by festival or over all of them.
      const statsBody = fid => { const days = Number(new URL(req.url, 'http://x').searchParams.get('days') || 7); const series = Array.from({ length: days }, (_, i) => ({ day: new Date(Date.now() - (days - 1 - i) * 86400000).toISOString().slice(0, 10), counts: { alerts: 10 + i, pack: 2, follow: 1, 'alert.new': i % 3 ? 0 : 1, 'push.web': 20 } }));
        return { days, at: new Date().toISOString(), totals: { alerts: 120, pack: 14, follow: 9, 'alert.new': 3, 'push.web': 140, headsup: 2, report: 4, post: 1 }, series, alertLatencySeconds: 41, opens: 134, following: 57, followRate: 7, delivered: { sent: 140, gone: 3, failed: 1, rate: 97 }, codes: { green: 600, yellow: 0, orange: 0, red: 25 },
          ...(fid ? {} : { stale: { poll: 0, lightning: 2, radar: 0 }, festivals: store.list.filter(f => isLive(f)).map(f => ({ id: f.id, name: f.name, counts: {}, opens: 50, following: 12, pushed: 40 })) }) }; };
      if (m === 'GET' && path === '/admin/stats') return key === 'k-admin' ? send(200, statsBody(null)) : send(401, { error: 'x-admin-key required' });
      const frep = path.match(/^\/festivals\/([^/]+)\/report$/);
      if (m === 'GET' && frep) { res.writeHead(200, { ...cors, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${frep[1]}-season-report.csv"` }); return res.end('"Fieldwatch season report"\n"festival","Suwannee Hulaween"\n'); }
      const fe = path.match(/^\/festivals\/([^/]+)$/);
      if (m === 'PUT' && fe) { const b = JSON.parse(raw), f = store.list.find(x => x.id === fe[1]); if (!f) return send(404, { error: 'no such festival' }); Object.assign(f, b); return send(200, f); }
      if (m === 'PUT' && gr) { const b = JSON.parse(raw); store.ground[gr[1]] = { ...(store.ground[gr[1]] || {}), ...b, surfaceSource: b.surface ? 'staff' : 'assumed', override: b }; return send(200, groundOf(gr[1])); }
      if (m === 'DELETE' && gr) { delete store.ground[gr[1]]; return send(200, groundOf(gr[1])); }
      const grl = path.match(/^\/festivals\/([^/]+)\/ground\/lookup$/);
      if (m === 'POST' && grl) { store.ground[grl[1]] = { ...(store.ground[grl[1]] || {}), surface: 'grass', soil: 'A', soilName: 'Blanton fine sand, 0 to 5 percent slopes', drainage: 'Somewhat excessively drained', surfaceSource: 'OpenStreetMap: leisure=park', soilSource: 'USDA soil survey' }; return send(200, groundOf(grl[1])); }
      const hide = path.match(/^\/festivals\/([^/]+)\/(hide|unhide)$/);
      if (m === 'POST' && hide) { const f = store.list.find(x => x.id === hide[1]); if (!f) return send(404, {}); f.status = hide[2] === 'hide' ? 'hidden' : 'published'; return send(200, { ok: true, id: f.id, status: f.status }); }
      const post = path.match(/^\/festivals\/([^/]+)\/posts$/);
      const pd = path.match(/^\/festivals\/([^/]+)\/posts\/([^/]+)$/);
      if (m === 'DELETE' && pd) { store.retracted.push(pd[2]); return send(200, { ok: true, id: pd[2], ended: true }); }
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
    await openPicker(page);
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
    assert.deepEqual(store.posts, [{ festival: 'hulaween-2026', key: 'k-admin', title: 'Medical tent has moved', body: 'Now beside the water station at the east gate.', severity: 'moderate', kind: 'notice' }]);
    await page.waitForSelector('#admin');
    // A hold from a template: shelter in place, an hour, always urgent; the page says it until it ends.
    await page.click('button:has-text("Post an update")'); await page.waitForSelector('#p-title');
    await page.click('button.chip:has-text("Shelter")');
    assert.equal(await page.inputValue('#p-title'), 'Shelter in place'); assert.equal(await page.textContent('.chips .chip.on:has-text("hour")'), '1 hour');
    assert.equal(await page.$('button.chip:has-text("Urgent")'), null, 'shelter is urgent, not a choice');
    await page.click('button.chip:has-text("2 hours")');
    assert.equal(await page.textContent('#p-send'), 'Call the hold');
    await page.click('#p-send'); await page.waitForSelector('.toast.show:has-text("Pushed to 2 phones")');
    assert.deepEqual(store.posts.at(-1), { festival: 'hulaween-2026', key: 'k-admin', title: 'Shelter in place', body: 'Lightning within 8 miles. Get into a vehicle or a building now. Tents, canopies and stages are not shelter.', severity: 'severe', kind: 'shelter', minutes: 120 });
    await page.waitForSelector('#admin');

    // Review what people reported, before it goes out.
    store.pendingReports.push({ id: 'rep-1', category: 'flood', level: 'warning', summary: 'Flooding behind Stage 2, avoid the path', location: 'Stage 2', source: 'attendee', occurredAt: new Date().toISOString() });
    await page.click('button:has-text("Review reports")');
    await page.waitForSelector('.pend:has-text("Flooding behind Stage 2")');
    // The queue is live: a report landing while the screen is open shows up with no tap.
    store.pendingReports.push({ id: 'rep-2', category: 'crowd', level: 'advisory', summary: 'Crush at the front rail of Stage 1', location: 'Stage 1', source: 'attendee', occurredAt: new Date().toISOString() });
    store.emit({ festivalId: 'hulaween-2026', kind: 'reports', at: new Date().toISOString() });
    await page.waitForSelector('.pend:has-text("Crush at the front rail")');
    await page.click('.pend:has-text("Crush at the front rail") button:has-text("Remove")');
    await page.waitForSelector('.pend:has-text("Crush at the front rail")', { state: 'detached' });
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
    assert.match(await page.textContent('.kv:has-text("Camping")'), /No camping|Yes, people camp|Unknown/); assert.match(await page.textContent('.kv:has-text("Standing")'), /Pop-up canopies/);
    assert.equal(await page.$eval('details.correct', d => d.open), false, 'the readout is the screen; the corrections wait behind one fold');
    assert.equal(await page.$eval('details.correct .chips', el => el.checkVisibility()), false, 'no chips on screen until the fold is opened'); await page.click('details.correct summary');
    assert.ok(await page.$('button.chip.on:has-text("Grass")') && await page.$('button.chip.on:has-text("Average")'), 'nothing found yet: the chips show what is assumed');
    await page.click('button:has-text("Look it up again")'); await page.waitForSelector('.toast.show:has-text("Looked up again")');
    assert.match(await page.textContent('.kv:has-text("Soil")'), /Blanton fine sand.*Drains fast \(A\).*USDA soil survey/s);
    assert.ok(await page.$('button.chip.on:has-text("Fast")'), 'the lookup landed: the soil chip follows it without anyone touching it');
    // Ground that lands while the screen is open (the backend's own lookup, on the live stream) moves the chips too.
    store.ground['hulaween-2026'] = { ...(store.ground['hulaween-2026'] || {}), surface: 'sand', surfaceSource: 'OpenStreetMap: natural=beach' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'ground', at: new Date().toISOString() });
    await page.waitForSelector('button.chip.on:has-text("Sand")');
    await page.click('button.chip:has-text("Paved")'); await page.click('button.chip:has-text("Stage")'); await page.click('button.chip:has-text("No camping")'); await page.click('button.chip:has-text("Indoors")');
    // Once staff have touched a chip, a refresh leaves their choices alone.
    store.ground['hulaween-2026'] = { ...store.ground['hulaween-2026'], surface: 'gravel' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'ground', at: new Date().toISOString() });
    await page.waitForFunction(() => [...document.querySelectorAll('.kv')].some(k => /Gravel/.test(k.textContent)));
    assert.ok(await page.$('button.chip.on:has-text("Paved")'), 'the readout moved to gravel; the chip staff picked stays');
    assert.ok((await page.$$eval('.chips', rs => rs.map(r => r.getBoundingClientRect().height))).every(h => h < 60), 'every section of chips is one line (a chip is 44 px tall; two lines would be near 90)');
    assert.deepEqual(await page.$$eval('.chips .chip', cs => cs.filter(c => c.scrollWidth > c.clientWidth).map(c => c.textContent)), [], 'and no chip is cut short');
    await page.click('button.btn:has-text("Save")'); await page.waitForSelector('.toast.show:has-text("Saved")');
    assert.ok(store.calls.includes('PUT /festivals/hulaween-2026/ground'));
    assert.deepEqual({ surface: store.ground['hulaween-2026'].surface, structures: store.ground['hulaween-2026'].structures, low: store.ground['hulaween-2026'].low, camping: store.ground['hulaween-2026'].camping, indoor: store.ground['hulaween-2026'].indoor }, { surface: 'pavement', structures: ['canopies', 'stage'], low: false, camping: false, indoor: true });
    assert.match(await page.textContent('.kv:has-text("Setting")'), /Indoors/);
    await page.click('button.chip:has-text("Outdoors")'); await page.click('button.btn:has-text("Save")'); await page.waitForSelector('.toast.show:has-text("Saved")');
    assert.equal(store.ground['hulaween-2026'].indoor, false);
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
    assert.match(checked, /Sources on: Edmtrain\. Last import .*Admin key matches\./);

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
    assert.match(await page.textContent('#app'), /The key here is not the admin key or a staff key the backend knows/);
    await page.click('button:has-text("Festival sources")');
    await page.waitForSelector('.sub:has-text("Wrong admin key")');
    assert.match(await page.textContent('#app'), /does not know the key in Settings/);
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
    assert.equal(await page.textContent('.ask .t'), 'Favorite Suwannee Hulaween?');
    await page.click('.ask button:has-text("Not now")');
    assert.equal(await page.$('.ask'), null, 'answered');
    await page.reload(); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    assert.match(await page.textContent('.feedfest:has-text("Suwannee Hulaween") .alert .s'), /^Warning · Until /, 'the word beside the color');
    await page.click('.feedfest:has-text("Suwannee Hulaween") .alert'); await page.waitForSelector('.alerthead'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.$('.ask'), null, 'and not asked again');
    await page.click('button.row:has-text("Favorite")');
    await page.waitForSelector('.pill.on');
    await page.waitForFunction(() => /^Favorited Suwannee Hulaween/.test(document.querySelector('.toast.show')?.textContent || ''));
    assert.ok(store.calls.includes('GET /push/vapid') && store.calls.includes('POST /push/subscribe'));
    assert.ok(await page.$('button.tb.fav.on'), 'the heart in the top bar fills');
    assert.equal(store.subs.length, 1);
    assert.equal(store.subs[0].festivalId, 'hulaween-2026');
    assert.deepEqual(store.subs[0].subscription, { endpoint: 'https://push.example.test/abc', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } });
    assert.equal(store.subs[0].digest, true, 'the morning brief comes unless switched off');
    await shot(page, '11-home-push');
    // Switching the brief off in Settings registers the favorite again with the flag down.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('h1.title:has-text("Settings")');
    await page.click('button.row:has-text("Morning brief")');
    await page.waitForFunction(() => /Off/.test([...document.querySelectorAll('button.row')].find(b => /Morning brief/.test(b.textContent))?.querySelector('.pill')?.textContent || ''));
    for (let i = 0; i < 50 && store.subs[0]?.digest !== false; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal(store.subs[0].digest, false); assert.equal(store.subs.length, 1, 'the same phone, not a second row');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    await page.click('button.tb.fav');
    await page.waitForSelector('.pill:not(.on)');
    await page.waitForFunction(() => /^Removed Suwannee Hulaween/.test(document.querySelector('.toast.show')?.textContent || ''));
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
  await page.click('button:has-text("Festivals")');
  await page.waitForSelector('span.eyebrow:has-text("Right now")');
  assert.match(await page.textContent('.feedfest .fh .t'), /Suwannee Hulaween/, 'its warning puts it first on the home page');
  await openPicker(page);
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  assert.equal((await page.$$eval('p.h', els => els.map(e => e.textContent)))[0], 'Here');
  assert.equal(await page.textContent('.bubble .t'), 'Suwannee Hulaween');
  assert.match(await page.textContent('.bubble .ph'), /right here$/);
  const others = await page.$$eval('.bubble .ph, .row .tr', els => els.map(e => e.textContent).filter(t => / mi$/.test(t)));
  assert.ok(others.length >= 1, 'the others say how far');
  assert.equal(await page.$('.sky'), null, 'after Change, the picker stays put');

  // From far away, the home page is the weather where you stand; the festivals wait behind their button, the nearest first.
  await context.setGeolocation({ latitude: 39.74, longitude: -104.99 });   // Denver
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill(json({ name: 'Denver', address: { city: 'Denver', county: 'Denver County', state: 'Colorado' } })));
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.title:has-text("Right here")', { timeout: 10000 });
  assert.ok(await page.$('.sky'), 'the weather for the spot, with no festival near');
  await page.click('button:has-text("Festivals")'); await page.waitForSelector('h1.title:has-text("Festivals")');
  assert.equal(await page.$('button.row:has-text("Right where you are")'), null, 'already on your spot');
  await openPicker(page);
  await page.waitForSelector('h1.title:has-text("Which festival?")');
  await page.waitForFunction(() => /\d mi/.test(document.querySelector('.bubble .ph')?.textContent || ''));
  const dist = await page.$$eval('.bubble .ph', els => els.map(e => Number(e.textContent.match(/([\d,.]+) mi/)?.[1].replace(',', ''))));
  assert.ok(dist.every((d, i) => i === 0 || d >= dist[i - 1]), 'nearest first');
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
    await page.waitForSelector('.sky.warn', { timeout: 10000 });
    assert.equal(await page.textContent('h1.title'), 'Right here', 'nothing on nearby: the home page is the weather where you stand');
    await page.waitForFunction(() => /Denver, Colorado/.test(document.querySelector('.sub')?.textContent || ''));
    assert.match(await page.textContent('.eyebrow'), /Your location · (just now|\d+ (min|hr) ago)/);
    assert.ok(seen.alertUrls.some(u => /point=39\.739\d?,-104\.990\d?/.test(u)), 'the weather service is asked about your spot');
    assert.equal(await page.$('button.row:has-text("Report a hazard")'), null, 'no festival, no festival rows');
    assert.equal(await page.$('button[aria-label="Share"]'), null);
    // The lightning code for the spot itself: a warm-up first, then the grade, with where the flashes are going.
    await page.waitForSelector('.bolt.none');
    assert.match(await page.textContent('.bolt .t'), /^Watching for lightning here$/);
    assert.ok(store.calls.some(c => /^GET \/point\/39\.7392,-104\.9903\/lightning$/.test(c)), 'asked by where it is, not by a festival id');
    store.pointLightning = { code: 'yellow', nearestMi: 15, nearestAt: new Date().toISOString(), within: { 8: 0, 12: 0, 20: 3 }, lastNearMi: null, lastNearAt: null, allClearAt: null, orangeUntil: null, held: false, stale: false, motion: { heading: 'SW', speedMph: 25, closing: true, arrivalMinutes: 30, distanceMi: 15, flashes: 9 }, at: new Date().toISOString(), dataAt: new Date().toISOString(), source: 'GOES GLM', point: true };
    await page.evaluate(() => loadLightning(fest())); await page.waitForSelector('.bolt.yellow');
    assert.match(await page.textContent('.bolt .s'), /· closing, ~30 min$/);
    await shot(page, '19-here');
    await page.click('button.row:has-text("Warnings on this phone")');
    await page.waitForSelector('.pill.on');
    assert.deepEqual(store.subs[0].point, { latitude: 39.7392, longitude: -104.9903 }, 'warnings follow the spot');
    assert.equal(store.subs[0].festivalId, undefined);
    await page.click('button.orb:has-text("Radar")');
    await page.waitForSelector('.rmap .me');
    const dot = await page.$eval('.rmap .me', el => ({ left: parseFloat(el.style.left), top: parseFloat(el.style.top) }));
    assert.ok(Math.abs(dot.left - 256) < 2 && Math.abs(dot.top - 256) < 2, 'the radar square is centered on you');
    assert.equal(await page.$$eval('.rmap .ring', els => els.length), 3, 'the protocol\'s rings around you');
    assert.equal(await page.textContent('.rmap .arrive'), 'Lightning closing SW · ~30 min');
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
    const d0 = JSON.parse(localStorage.getItem('fieldwatch.web') || '{}');
    if (!d0.fest) localStorage.setItem('fieldwatch.web', JSON.stringify({ ...d0, fest: 'hulaween-2026', welcomed: true, push: { endpoint: 'https://push.example.test/old', fest: 'hulaween-2026' } }));
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
    await page.click('.feedfest.fav:has-text("Suwannee Hulaween") button.fh');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('button.row:has-text("Favorite") .pill'), 'On', 'the old one-festival record became a favorite');
    await page.reload();
    await page.waitForSelector('span.eyebrow:has-text("Right now")');
    assert.equal(store.calls.filter(c => c === 'POST /push/subscribe').length, 1, 'checked once an hour, not on every open');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});


test('the festivals list is the festivals with a code to show, worst first; Code Green and Indoors are not listed, their alerts are; a favorite stays; a tap opens one; a quiet day says so', async () => {
  const { page, context, seen } = await newPage();
  // Three quiet festivals on at the same time, the Code Green bulk of a real weekend.
  const quietOnes = ['A', 'B', 'C'].map((k, n) => ({ ...FESTS.find(f => f.id === 'hulaween-2026'), id: `quiet-${k.toLowerCase()}-2026`, name: `Quiet Fest ${k}`, location: `Field ${k}, GA`, latitude: 32 + n, longitude: -83 - n, featured: false, source: 'https://quiet.example/' }));
  const { server, store, base: api } = await fakeBackend([...FESTS, ...quietOnes]);
  const liveCount = store.list.filter(f => isLive(f)).length;
  const headers = () => page.$$eval('p.h', els => els.map(e => e.textContent));
  const graded = (id, code) => page.waitForFunction(([id, code]) => !S.feedBusy && S.feed && S.feed.codes && (S.feed.codes[id] || {}).code === code, [id, code]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('h1.title:has-text("Festivals")');
    assert.match(await page.textContent('.sub'), /^\d+ festivals on now · 1 warning$/);
    const cards = await page.$$eval('.feedfest .fh .t', els => els.map(e => e.textContent));
    assert.equal(cards[0], 'Suwannee Hulaween', 'the warning comes before the advisory');
    assert.equal(cards.length, liveCount, 'every festival that is on is a card');
    assert.deepEqual(await page.$$eval('.feedfest .alert .t', els => els.map(e => e.textContent)), ['Severe Thunderstorm Warning', 'Heat Advisory']);
    assert.ok(await page.$('.tiles.dash .kpi:has(.k:text-is("Festivals"))'), 'the whole list is one tap away, behind the Festivals tile, not the page');
    await shot(page, '20-feed');
    // The card itself opens its festival, favorite or not; the alert under it opens on the alert.
    await page.click('.feedfest:has-text("Suwannee Hulaween") button.fh'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'the card header opens the festival');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.click('.feedfest .alert:has-text("Severe Thunderstorm Warning")');
    await page.waitForSelector('.alerthead h2:has-text("Severe Thunderstorm Warning")');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'behind the alert is its festival');
    store.lightning['hulaween-2026'] = { code: 'green', nearestMi: null, nearestAt: null, within: { 8: 0, 12: 0, 20: 0 }, lastNearMi: null, lastNearAt: null, allClearAt: null, orangeUntil: null, at: new Date().toISOString(), dataAt: new Date().toISOString(), source: 'GOES GLM' };
    await page.click('button:has-text("Festivals")');
    await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.click('button[aria-label="Refresh"]'); await graded('hulaween-2026', 'green');
    // Code Green is not listed: a festival missing from the list is a green one. Its warning is on the page all the same, in the
    // alerts at the top, with the festival's name. The ungraded festivals stay, a card each, under no header: one code on the list.
    assert.equal(await page.$('.feedfest:has-text("Suwannee Hulaween")'), null, 'a green festival is not a card, warning or not');
    assert.equal(await page.$$eval('.feedfest', els => els.length), liveCount - 1, 'the ungraded festivals stay, a card each');
    assert.deepEqual(await headers(), ['Alerts'], 'one code on the list: no code header');
    assert.match(await page.textContent('.dash-alerts .alert:has-text("Severe Thunderstorm Warning") .s'), /^Suwannee Hulaween · Warning · Until /, 'the warning, with its festival, in the alerts');
    assert.ok((await page.$$eval('p.h, .tile .k', els => els.map(e => e.textContent.trim()))).every(t => !/\s/.test(t) || /^Code (Red|Orange|Yellow|Green)$/.test(t)), 'every section header is one word, a code\'s name aside');
    // Rows the same height whatever their text, the name and the place on one line each.
    const heads = await page.$$eval('.feedfest .fh', els => els.map(e => Math.round(e.getBoundingClientRect().height)));
    assert.ok(heads.length >= 4 && heads.every(h => h === 84), `every festival row is the same height whatever its text: ${heads.join(' ')}`);
    assert.deepEqual(await page.$eval('.feedfest .fh', e => [getComputedStyle(e.querySelector('.t')).whiteSpace, getComputedStyle(e.querySelector('.s')).whiteSpace]), ['nowrap', 'nowrap'], 'the name and the place stay on one line each');
    await shot(page, '21b-feed-ungraded');

    // Every festival green: no cards, and nothing that says so; the tiles and the alerts are the page. The warning and the advisory stay in the alerts.
    for (const x of store.list.filter(f => isLive(f))) store.lightning[x.id] = { ...store.lightning['hulaween-2026'] };
    await page.click('button[aria-label="Refresh"]');
    await page.waitForFunction(() => !S.feedBusy && !document.querySelector('.feedfest'));
    assert.deepEqual(await headers(), ['Alerts'], 'no code headers');
    assert.deepEqual(await page.$$eval('.dash-alerts .alert .t', els => els.map(e => e.textContent)), ['Severe Thunderstorm Warning', 'Heat Advisory'], 'the warning and the advisory are listed, not lost');
    assert.equal(await page.$('.empty'), null, 'no empty state: the festivals are on, they are green');
    assert.deepEqual(await page.$eval('.tiles.dash .kpi:has-text("Lightning")', e => [e.querySelector('.n').textContent, e.querySelector('.s').textContent]), ['None', 'none near a festival'], 'the lightning tile says none, not green at some festival');
    await shot(page, '21-feed-green');

    // A favorite stays on the list whatever its code, its heart and its code beside the name, its alerts under it.
    await page.evaluate(() => { S.favorites = { ...(S.favorites || {}), 'hulaween-2026': true }; save(); render(false); });
    await page.waitForSelector('.feedfest.fav:has-text("Suwannee Hulaween")');
    assert.equal(await page.textContent('.feedfest.fav .fh .pill'), 'Code Green', 'with its code');
    assert.equal(await page.$$eval('.feedfest', els => els.length), 1, 'the favorite, and nothing else');
    assert.equal(await page.textContent('.feedfest.fav .alert .t'), 'Severe Thunderstorm Warning', 'carrying its alerts');
    await page.click('.feedfest.fav button.fh'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'the card opens the festival');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.evaluate(() => { S.favorites = {}; save(); render(false); });
    await page.waitForFunction(() => !document.querySelector('.feedfest'));

    // More than eight alerts in effect: eight on the page, the rest behind one fold.
    const many = (fid, n) => ({ festivalId: fid, alerts: Array.from({ length: n }, (_, k) => ({ id: `${fid}-${k}`, event: `Wind Advisory ${k + 1}`, headline: null, body: '', instruction: null, severity: 'minor', area: '', source: 'NWS', issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString(), channel: 'weather', relayCount: 0 })) });
    store.feed = quietOnes.map(q => many(q.id, 4));
    await page.click('button[aria-label="Refresh"]');
    await page.waitForFunction(() => !S.feedBusy && document.querySelectorAll('.dash-alerts .alert').length === 12);
    assert.equal(await page.$$eval('.dash-alerts > .alert', els => els.length), 8, 'eight on the page');
    assert.equal(await page.$$eval('.dash-alerts details .alert', els => els.length), 4, 'the rest behind the fold');
    assert.equal(await page.$eval('.dash-alerts details', d => d.open), false, 'folded to start');
    // Shown or not by the browser's own word (checkVisibility: a closed fold hides its rows), once the screen has settled: a render
    // landing under the check redraws the rows in place, and the runner's Chromium reports nothing visible for a moment after one.
    const shown = () => page.$$eval('.dash-alerts .alert', els => els.filter(e => e.checkVisibility()).length);
    await page.waitForFunction(() => document.querySelectorAll('.dash-alerts .alert').length === 12 && [...document.querySelectorAll('.dash-alerts > .alert')].every(e => e.checkVisibility()));
    assert.equal(await shown(), 8, 'eight shown, the folded four not');
    assert.equal(await page.textContent('.dash-alerts details summary'), '4 more');
    await page.click('.dash-alerts details summary');
    await page.waitForFunction(() => document.querySelector('.dash-alerts details')?.open && [...document.querySelectorAll('.dash-alerts .alert')].every(e => e.checkVisibility()));
    assert.equal(await shown(), 12, 'a tap shows the rest');
    await shot(page, '21c-feed-alerts');

    // A quiet day: no alerts section, no cards, and the sub line says so.
    store.feed = [];
    await page.click('button[aria-label="Refresh"]');
    await page.waitForFunction(() => /All clear/.test(document.querySelector('.sub')?.textContent || ''));
    assert.match(await page.textContent('.sub'), new RegExp(`^${liveCount} festivals on now · All clear$`));
    assert.equal(await page.$('.dash-alerts'), null, 'no alerts section with nothing in effect');
    assert.equal(await page.$('.feedfest'), null, 'no cards: every festival is green');

    // Indoors is not listed either: a club show gets no code, so there is nothing to show for it.
    const indoorOne = store.list.filter(f => isLive(f)).find(f => f.id !== 'hulaween-2026');
    store.lightning[indoorOne.id] = { code: 'indoor', indoor: true, at: new Date().toISOString(), dataAt: new Date().toISOString(), source: 'GOES GLM' };
    await page.click('button[aria-label="Refresh"]'); await graded(indoorOne.id, 'indoor');
    assert.equal(await page.$('.feedfest'), null, 'green and indoors alike: not listed');
    assert.deepEqual(await headers(), [], 'no headers at all');
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
  await openPicker(page);
  await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
  await page.waitForSelector('.headsup');
  assert.equal(await page.textContent('.headsup h3'), 'Storms');
  assert.match(await page.textContent('.headsup .eyebrow'), /On the way/);
  assert.match(await page.textContent('.hu-when'), /^in [23] h \d+ m$|^in 3 h 0 m$/, 'the countdown, two to three hours out');
  assert.match(await page.textContent('.headsup p'), /^Around \d+:00 [AP]M until \d+:00 [AP]M · thunder 60%, gusts to 34 mph, maybe past the canopy line$/, 'gusts named against what is standing, and how sure');
  assert.deepEqual(await page.$$eval('.hu-steps .st .task', els => els.map(e => e.textContent)), ['Stake every loop, tie guy lines, weigh the legs'], 'the longest task first');
  assert.ok((await page.$$eval('.hu-steps .st .by', els => els.map(e => e.textContent))).every(t => /^by \d+:\d\d [AP]M$/.test(t)), 'each with a start-by time');
  assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning', 'the warning already in effect stays on the sky; the heads-up is its own card');
  await shot(page, '21-headsup');
  // The countdown ticks on its own; a minute makes no visible difference here, but the element is live.
  assert.equal(await page.evaluate(() => { tickCountdowns(); return document.querySelectorAll('[data-countdown]').length; }), 1);

  await page.click('.headsup');
  await page.waitForSelector('h1.title:has-text("Storms")');
  assert.match(await page.textContent('.countdown b'), /^[23] h \d+ m$/);
  assert.match(await page.textContent('.countdown .s'), /^Secure camp (now|before you turn in)/);
  assert.match(await page.textContent('.todo'), /Where to shelter.*hard-topped vehicle/s);
  const camp = await page.$$eval('.steps .step .task', els => els.map(e => e.textContent));
  assert.match(await page.textContent('.steps .step:first-child .by'), /^by \d+:\d\d [AP]M$/, 'start-by times on the camp list');
  // Hulaween is a camping festival, so the list is a camper's and nobody is asked; one small link says if that is not you, and a day visitor gets their own list, with no tent in it.
  assert.equal(await page.$('.chips.setup'), null, 'no chips to pick from until asked for');
  await page.click('.h .hlink:has-text("Not camping?")'); await page.click('button.chip:has-text("Day visitor")');
  const dayList = await page.$$eval('.steps .step .task', els => els.map(e => e.textContent));
  assert.equal(dayList[0], 'Charge the phone, fill water'); assert.ok(!dayList.some(t => /canop|tent/i.test(t)), `no tents for a day visitor: ${dayList}`);
  assert.equal(await page.$('.chips.setup'), null, 'the choice closes the chips again');
  await page.click('.h .hlink:has-text("Camping or crew?")'); await page.click('button.chip:has-text("I\'m camping")');
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
  assert.match(await page.textContent('.headsup p'), /on the radar moving NE at 25 mph/);
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
    await page.waitForSelector('h1.title:has-text("Festivals")');
    assert.equal(await page.textContent('.feedfest:has-text("Suwannee Hulaween") .fh .pill'), 'Code Red', 'the code sits on the festival\'s card on the home page');
    await page.click('.feedfest .alert:has-text("Severe Thunderstorm Warning")');
    await page.waitForSelector('.alerthead');
    await page.click('button[aria-label="Back"]');
    await page.waitForSelector('.bolt.red');
    // The flashes behind the code sit on the radar square, fading with age; one far outside the square is not drawn.
    store.flashes = { 'hulaween-2026': [{ latitude: 30.456, longitude: -82.9395, at: minutesAgo(2), ageSeconds: 120, mi: 3.6 }, { latitude: 30.52, longitude: -82.80, at: minutesAgo(20), ageSeconds: 1200, mi: 12.1 }, { latitude: 35, longitude: -90, at: minutesAgo(1), ageSeconds: 60, mi: 400 }] };
    await page.click('button.orb:has-text("Radar")'); await page.waitForSelector('.rmap .flash');
    assert.equal(await page.$$eval('.rmap .flash', els => els.length), 2, 'two flashes inside the square');
    const fade = await page.$$eval('.rmap .flash', els => els.map(e => parseFloat(e.style.opacity)));
    assert.ok(fade[0] > fade[1], 'the newer flash is brighter');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.bolt.red');
    assert.equal(await page.$('h1.title .pill'), null, 'the code is on the tile under the sky, not beside the name');
    assert.equal(await page.textContent('.bolt .t'), 'Lightning 3.6 mi · Code Red');
    assert.match(await page.textContent('.bolt .s'), /^Rapid evacuation, full work stoppage · all clear in 2[67] min$/);
    assert.ok(await page.$('.sky.warn'), 'the warning stays on the sky; lightning is its own tile');
    await shot(page, '23-lightning-home');
    await page.click('.bolt');
    await page.waitForSelector('h1.title:has-text("Lightning")');
    assert.equal(await page.textContent('.codehead h2'), 'Code Red');
    assert.match(await page.textContent('.codehead p'), /^Nearest flash 3\.6 mi at \d+:\d\d [AP]M$/);
    assert.match(await page.textContent('.codehead b'), /^2[67] min$/);
    assert.match(await page.textContent('.code.now .t'), /Code Red · Under 8 miles/);
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
    assert.equal(await page.textContent('.bolt .t'), 'No lightning within 20 mi · Code Green');
    // The backend restarted mid-red: its grade says green for a minute while the red alert it issued still stands. The phone shows
    // the alert's red on the sky, the tile and the home page, with the alert's own all-clear: never a red card over a green tile.
    const redAlert = { id: 'lightning-hulaween-2026-red-1', event: 'Code Red: lightning within 8 miles', headline: 'Lightning 3.6 mi away at 6:40 PM. Rapid evacuation required. Full work stoppage.', body: 'Lightning has been detected in less than an 8 mile radius.', instruction: 'Get to shelter now.', severity: 'severe', area: 'Live Oak, FL', source: 'GOES lightning mapper, via Fieldwatch', issuedAt: minutesAgo(10), onset: minutesAgo(10), expiresAt: new Date(Date.now() + 20 * 60000).toISOString(), channel: 'lightning', relayCount: 0, code: 'red', nearestMi: 3.6 };
    store.alerts['hulaween-2026'] = [redAlert];
    await page.evaluate(() => refresh(fest())); await page.waitForSelector('.bolt.red');
    // A Code Red landing on an open page takes the screen with the protocol's line; one tap and the page is back.
    await page.waitForSelector('.takeover');
    assert.equal(await page.textContent('.takeover h2'), 'Code Red: lightning within 8 miles'); assert.equal(await page.textContent('.takeover .do'), 'Shelter now');
    await page.click('.takeover button:has-text("Got it")'); assert.equal(await page.$('.takeover'), null);
    assert.equal(await page.textContent('.bolt .t'), 'Lightning 3.6 mi · Code Red');
    assert.match(await page.textContent('.bolt .s'), /all clear in (19|20) min/, 'the countdown is the alert\'s own end');
    assert.equal(await page.textContent('.sky h2'), 'Code Red: lightning within 8 miles', 'the sky and the tile say the same thing');
    await page.click('.bolt'); await page.waitForSelector('h1.title:has-text("Lightning")');
    assert.equal(await page.textContent('.codehead h2'), 'Code Red'); assert.match(await page.textContent('.codehead p'), /^Last flash within 8 mi at/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.bolt.red');
    store.feed = [{ festivalId: 'hulaween-2026', alerts: [redAlert] }];   // the home page's grade for it still says green
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.click('button[aria-label="Refresh"]'); await page.waitForFunction(() => !S.feedBusy); await page.waitForSelector('h1.title:has-text("Festivals")');
    assert.equal(await page.textContent('.feedfest .fh .pill'), 'Code Red', 'on the home page too');
    assert.deepEqual(await page.$$eval('.feedfest:has-text("Suwannee Hulaween") .alert .t', els => els.map(e => e.textContent)), ['Lightning 3.6 mi'], 'the grade and the alert it stands on are one row, not two');
    assert.match(await page.textContent('.feedfest:has-text("Suwannee Hulaween") .alert .s'), /^Code Red · Rapid evacuation, full work stoppage · all clear \w{3} \d+:\d\d [AP]M$/);
    await page.click('.feedfest .alert'); await page.waitForSelector('.alerthead'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    delete store.alerts['hulaween-2026'];
    // An indoor event: the backend grades nothing, the tile and the screen say why, the home page lists it no more; its warning is in the alerts.
    store.lightning['hulaween-2026'] = { code: 'indoor', indoor: true, at: minutesAgo(0), dataAt: minutesAgo(0), source: 'GOES GLM' };
    store.ground['hulaween-2026'] = { ...(store.ground['hulaween-2026'] || {}), indoor: true, indoorSource: 'the listing' };
    await page.evaluate(() => refresh(fest())); await page.waitForSelector('.bolt.indoor');
    assert.equal(await page.textContent('.bolt .t'), 'Indoors · No lightning codes');
    await page.click('.bolt'); await page.waitForSelector('h1.title:has-text("Lightning")');
    assert.equal(await page.textContent('.codehead h2'), 'Indoors'); assert.match(await page.textContent('.codehead p'), /^The lightning protocol is for outdoor grounds/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.bolt.indoor');
    store.feed = [{ festivalId: 'hulaween-2026', alerts: [alertFeature().properties].map(p => ({ id: p.id, event: p.event, headline: p.headline ?? null, body: '', instruction: null, severity: 'severe', area: '', source: 'NWS', issuedAt: p.effective, expiresAt: p.ends ?? p.expires ?? null, channel: 'weather', relayCount: 0 })) }];
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.click('button[aria-label="Refresh"]'); await page.waitForFunction(() => !S.feedBusy); await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.waitForFunction(() => !S.feedBusy && S.feed && (S.feed.codes['hulaween-2026'] || {}).code === 'indoor');
    assert.equal(await page.$('.feedfest:has-text("Suwannee Hulaween")'), null, 'an indoor festival is not listed: there is no code to show');
    assert.match(await page.textContent('.dash-alerts .alert .s'), /^Suwannee Hulaween · Warning/, 'its warning is on the page all the same, in the alerts, with its festival');
    await page.click('.dash-alerts .alert'); await page.waitForSelector('.alerthead'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    delete store.ground['hulaween-2026'];
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
    await page.click('button:has-text("Festivals")');
    await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.waitForFunction(() => !S.feedBusy).catch(e => { throw new Error(`${e.message}; page errors: ${seen.errors.join(' | ')}`); });
    assert.match(await page.textContent('.sub'), /1 advisory/, 'an orange with no alert is still something going on');
    const card = `.feedfest:has-text("${other.name}")`;
    assert.equal(await page.textContent(`${card} .alert .t`), 'Lightning 11.2 mi');
    assert.match(await page.textContent(`${card} .alert .s`), /^Code Orange · Evacuation procedures, staff hold posts · until \w{3} \d+:\d\d [AP]M$/, 'with the end of the orange');
    assert.equal(await page.textContent(`${card} .fh .pill`), 'Code Orange');
    assert.equal(await page.$$eval('.feedfest .fh .t', els => els[0].textContent), other.name, 'the orange comes first');
    assert.equal(await page.$('.feedfest:has-text("Suwannee Hulaween") .alert'), null, 'the festival you looked at is listed with the rest, with nothing going on');
    await page.click(`${card} .alert`);
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

test('the screen rises once, on a move: data landing later swaps in place with no animation, and an opened fold stays open', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  await page.addInitScript(() => { window.__rises = 0; document.addEventListener('animationstart', e => { if (e.animationName === 'rise') window.__rises++; }, true); });
  const rises = () => page.evaluate(() => window.__rises), reset = () => page.evaluate(() => { window.__rises = 0; });
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('span.eyebrow:has-text("Right now")'); await page.waitForTimeout(500);
    assert.equal(await rises(), 2, 'the walkthrough rose, then the home page: once each, whatever loaded after');
    // A live change reloads the feed, and a plain re-render happens for a busy flag: the content swaps in place.
    await reset();
    store.emit({ festivalId: 'hulaween-2026', kind: 'alerts', at: new Date().toISOString() }); await page.waitForTimeout(500);
    await page.evaluate(() => render()); await page.waitForTimeout(500);
    assert.equal(await rises(), 0, 'no entrance animation for data');
    // Each move is one rise: to the picker, then to the festival page, with none for the forecast that lands after it.
    await openPicker(page); await page.waitForTimeout(400);
    assert.equal(await rises(), 1, 'the picker');
    await reset();
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn'); await page.waitForTimeout(600);
    assert.equal(await rises(), 1, 'the festival page');
    await reset();
    await page.click('.sky.warn'); await page.waitForSelector('details.more');
    await page.click('details.more summary'); assert.ok(await page.$eval('details.more', d => d.open));
    await page.waitForFunction(() => !entering);
    await page.evaluate(() => render()); await page.waitForTimeout(300);
    assert.ok(await page.$eval('details.more', d => d.open), 'the fold stays open through a re-render');
    assert.equal(await rises(), 1, 'the alert screen rose once, on arrival');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('favorites: a heart on the festival page follows its warnings on this phone, several at once, listed first on the home page, and dropped one at a time', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['notifications']);
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  await page.addInitScript(() => {
    const sub = { endpoint: 'https://push.example.test/fav', unsubscribe: async () => { window.__subscribed = false; localStorage.removeItem('__sub'); return true; }, toJSON: () => ({ endpoint: 'https://push.example.test/fav', expirationTime: null, keys: { p256dh: 'p', auth: 'a' } }) };
    window.__subscribed = localStorage.getItem('__sub') === '1';   // a browser keeps its subscription across reloads
    const reg = { pushManager: { getSubscription: async () => (window.__subscribed ? sub : null), subscribe: async () => { window.__subscribed = true; localStorage.setItem('__sub', '1'); return sub; } } };
    Object.defineProperty(navigator.serviceWorker, 'ready', { get: () => Promise.resolve(reg) });
    window.PushManager = function PushManager(){};
  });
  const other = FESTS.find(f => isLive(f) && f.id !== 'hulaween-2026');
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('button.row:has-text("Favorite") .pill'), 'Off');
    await page.click('button.tb.fav'); await page.waitForSelector('button.tb.fav.on');
    await page.waitForFunction(() => document.querySelector('.toast.show')?.textContent.startsWith('Favorited Suwannee Hulaween'));
    assert.equal(await page.textContent('button.row:has-text("Favorite") .pill'), 'On');
    assert.deepEqual(store.subs.map(s => s.festivalId), ['hulaween-2026']);
    // A second favorite: the same phone, one more follow.
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    assert.ok(await page.$('.feedfest.fav:has-text("Suwannee Hulaween") .fh .fav'), 'the favorite wears its heart on the list');
    assert.equal(await page.textContent('.feedfest.fav:has-text("Suwannee Hulaween") .alert .t'), 'Severe Thunderstorm Warning', 'each favorite card carries its alerts');
    assert.equal(await page.$$eval('.feedfest:not(.fav) .fh .t', els => els.map(e => e.textContent)).then(n => n.includes('Suwannee Hulaween')), false, 'and is not listed again below');
    await openPicker(page);
    assert.ok(await page.$('.bubble:has-text("Suwannee Hulaween") .favmark'), 'the list shows it as a bubble under Favorites, with the heart in the corner');
    assert.deepEqual(await page.$$eval('p.h', els => els.map(e => e.textContent).filter(t => t !== 'Alerts')).then(h => h[0]), 'Favorites');
    await page.click(`button:has-text("${other.name}")`); await page.waitForSelector('.sky');
    await page.click('button.row:has-text("Favorite")'); await page.waitForSelector('button.tb.fav.on');
    await page.waitForFunction(() => /^Favorited /.test(document.querySelector('.toast.show')?.textContent || ''));
    assert.deepEqual(store.subs.map(s => s.festivalId).sort(), ['hulaween-2026', other.id].sort());
    assert.ok(store.subs.every(s => s.subscription.endpoint === 'https://push.example.test/fav'), 'one phone, two follows');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.waitForFunction(() => !S.feedBusy);
    assert.deepEqual(await page.$$eval('.feedfest.fav .fh .t', els => els.map(e => e.textContent)).then(n => n.sort()), ['Suwannee Hulaween', other.name].sort(), 'both cards wear the heart');
    assert.equal(await page.textContent(`.feedfest.fav:has-text("${other.name}") .alert .t`), 'Heat Advisory', 'its advisory rides on its card');
    assert.deepEqual(await page.$$eval('.feedfest .fh .t', els => els.slice(0, 2).map(e => e.textContent)), ['Suwannee Hulaween', other.name], 'one code for all: the worst alert first, then the next');
    await shot(page, '27-favorites');
    // Its advisory ends: the card says Clear.
    store.feed = store.feed.filter(x => x.festivalId === 'hulaween-2026');
    await page.click('button[aria-label="Refresh"]'); await page.waitForFunction(() => !S.feedBusy);
    assert.equal(await page.textContent(`.feedfest.fav:has-text("${other.name}") .pill`), 'Clear', 'a favorite with nothing going on says so');
    // On open, every favorite registers again, quietly, once an hour.
    await page.waitForFunction(() => !S.feedBusy && !S.busy);
    await page.evaluate(() => { S.push.checked = 0; save(); });   // through the app's state, so a save landing later keeps it
    store.subs = []; store.calls = [];
    await page.reload(); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.waitForFunction(() => document.querySelectorAll('.feedfest.fav').length === 2);
    for (let i = 0; i < 100 && store.subs.length < 2; i++) await new Promise(r => setTimeout(r, 50));
    assert.deepEqual(store.subs.map(s => [s.festivalId, s.quiet]).sort(), [['hulaween-2026', true], [other.id, true]].sort());
    // Dropping one keeps the other.
    await page.click('.feedfest.fav:has-text("Suwannee Hulaween") button.fh'); await page.waitForSelector('.sky.warn');
    await page.click('button.tb.fav.on'); await page.waitForSelector('button.tb.fav:not(.on)');
    await page.waitForFunction(() => /Removed Suwannee Hulaween/.test(document.querySelector('.toast.show')?.textContent || ''));
    assert.deepEqual(store.subs.map(s => s.festivalId), [other.id]);
    assert.equal(await page.evaluate(() => window.__subscribed), true, 'the browser subscription stays while a favorite remains');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('the radar loop comes from the backend when its cache is current, and from the archive when the cache is stale', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const STEP = 10 * 60000, frames = (newest, n) => Array.from({ length: n }, (_, i) => { const t = newest - (n - 1 - i) * STEP; return { time: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), url: `/radar/hulaween-2026/${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.png` }; });
  const manifest = newest => ({ festivalId: 'hulaween-2026', hours: 12, stepMinutes: 10, size: 512, bounds: { west: 0, south: 0, east: 1, north: 1 }, attribution: 'NOAA NEXRAD via Iowa Environmental Mesonet', frames: frames(newest, 24) });
  try {
    // Last evening's frames: the backend's cache stopped filling. The phone goes to the archive itself, and the loop ends near now.
    store.radar['hulaween-2026'] = manifest(Date.now() - 5 * 3600000);
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky');
    await page.click('button.orb:has-text("Radar")');
    await page.waitForFunction(() => document.querySelectorAll('.frame').length === 48 && document.getElementById('radar-loaded')?.textContent === '');
    assert.equal(seen.frames.length, 48, 'the archive, directly');
    assert.ok(Date.now() - Math.max(...seen.frames.map(t => Date.parse(t))) < 25 * 60000, 'and the newest frame is minutes old, not hours');
    // The cache caught up: the backend's own frames serve, and the archive is not asked.
    store.radar['hulaween-2026'] = manifest(Math.floor((Date.now() - 12 * 60000) / STEP) * STEP);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    await page.click('button.orb:has-text("Radar")');
    await page.waitForFunction(() => document.querySelectorAll('.frame').length === 24 && document.getElementById('radar-loaded')?.textContent === '');
    assert.equal(seen.frames.length, 48, 'no new archive requests');
    assert.ok(store.calls.some(c => /^GET \/radar\/hulaween-2026\/.*\.png$/.test(c)), 'the frames came from the backend');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a festival\'s staff key opens that festival\'s staff rows and nothing admin-wide; the admin issues it from Settings', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['geolocation']);
  await context.setGeolocation({ latitude: 30.4051, longitude: -82.9401 });   // on the Hulaween grounds, a hundred meters from the pin
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const other = FESTS.find(f => isLive(f) && f.id !== 'hulaween-2026');
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&staff=1`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('.sky.warn', { timeout: 10000 });
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'standing on the grounds: the festival opens by itself');
    // The admin issues Hulaween its key.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('#admin');
    await page.fill('#admin', 'k-admin'); await page.locator('#admin').blur();
    await page.waitForSelector('button.row:has-text("Staff key for Suwannee Hulaween")');
    await page.click('button.row:has-text("Staff key for Suwannee Hulaween")');
    await page.waitForSelector('.card:has-text("Shown once")');
    assert.match(await page.textContent('.card:has-text("Shown once")'), /k-hulaween-2026.*f=hulaween-2026&staff=1/s, 'the key and the staff link, once');
    assert.deepEqual(store.partnerKeys, { 'k-hulaween-2026': 'hulaween-2026' });
    // Their safety team puts the key in: their festival's rows, not the admin's.
    await page.fill('#admin', 'k-hulaween-2026'); await page.locator('#admin').blur();
    await page.waitForSelector('.note:has-text("Staff key for Suwannee Hulaween")');
    assert.ok(await page.$('button.row:has-text("Post an update")'), 'their posts');
    assert.ok(await page.$('button.row:has-text("Review reports")'), 'their reports');
    assert.equal(await page.$('button.row:has-text("Festival sources")'), null, 'not the sources');
    assert.equal(await page.$('button.row:has-text("All festivals")'), null, 'not the catalog');
    await page.click('button.row:has-text("Check the backend")'); await page.waitForSelector('button.row:has-text("Check the backend") .pill.on');
    assert.match(await page.textContent('#app'), /Staff key for Suwannee Hulaween/);
    await page.click('button.row:has-text("Post an update")'); await page.waitForSelector('#p-title');
    await page.fill('#p-title', 'Gates open at noon'); await page.fill('#p-body', 'Not eleven. Sound check ran long.'); await page.click('#p-send');
    await page.waitForSelector('.toast.show:has-text("Posted")'); await page.waitForSelector('#admin');
    assert.equal(store.posts[0].key, 'k-hulaween-2026');
    // Standing on the grounds, their staff move the pin to where they stand; the ground is looked up again for the new spot.
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    await page.click('button.row:has-text("Ground and what is standing")'); await page.waitForSelector('h1.title:has-text("Ground")');
    await page.click('details.correct summary'); await page.click('button:has-text("Pin it here")');
    await page.waitForSelector('.toast.show:has-text("Pinned here")');
    assert.deepEqual([store.list.find(f => f.id === 'hulaween-2026').latitude, store.list.find(f => f.id === 'hulaween-2026').longitude], [30.4051, -82.9401]);
    assert.ok(store.calls.includes('PUT /festivals/hulaween-2026') && store.calls.includes('POST /festivals/hulaween-2026/ground/lookup'), `the pin, then the lookups: ${store.calls.slice(-4)}`);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    // Diagnostics: what this phone holds and hears, for the test in the field.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('#admin');
    await page.click('button.row:has-text("Diagnostics")'); await page.waitForSelector('h1.title:has-text("Diagnostics")');
    await page.waitForFunction(() => [...document.querySelectorAll('.kv')].some(k => /Service worker/.test(k.textContent) && !/Checking/.test(k.textContent)));
    const diag = await page.textContent('#app');
    assert.match(diag, /Service worker.*App shell.*Storage.*Suwannee Hulaween.*Weather.*Live stream.*Open.*Warnings.*Location.*On/s, 'every row the field test reads');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('#admin');
    // At another festival the same key does nothing.
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('h1.title:has-text("Festivals")');
    await page.click(`.feedfest:has-text("${other.name}") button.fh`); await page.waitForSelector('.sky');
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('#admin');
    assert.equal(await page.$('button.row:has-text("Post an update")'), null, 'another festival: no staff rows');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a heads-up from the backend opens like any alert, from the home page row and from a link: the timing line first, then the first thing to do', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const onset = new Date(Date.now() + 150 * 60000).toISOString();
  const hu = { id: 'fieldwatch:headsup:hulaween-2026:storms:1', event: 'Storms expected around 5:00 PM', headline: null, body: 'The forecast has a 60% chance of thunder, gusts to 34 mph past the canopy line and 0.6 in of rain.',
    instruction: 'Stake every loop, tie guy lines, weigh the legs by 4:35 PM. Drop pop-up canopies and flags by 4:45 PM.', severity: 'moderate', area: 'Suwannee Hulaween', source: 'Fieldwatch, from the NWS forecast',
    issuedAt: new Date().toISOString(), onset, expiresAt: new Date(Date.now() + 6 * 3600000).toISOString(), channel: 'headsup', hazard: 'storms', minutes: 150, plan: [] };
  store.feed[0].alerts.push(hu);
  store.alerts['hulaween-2026'] = [...store.feed[0].alerts];
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.click('.feedfest:has-text("Suwannee Hulaween") .alert:has-text("Storms expected")');
    await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('.alerthead .eyebrow'), 'Heads-up');
    assert.match(await page.textContent('.alerthead h2'), /Storms expected around 5:00 PM/);
    assert.match(await page.textContent('.donow .t'), /^Secure camp (now\. Charge phones, fill water and pick your shelter|before you turn in\. Charge phones, fill water and know the way to shelter in the dark)$/);   // the evening wording late in the day
    assert.match(await page.textContent('.donow .s'), /^(Drop pop-up canopies and flags|Know where the shelter is and how long the walk takes)\.$/, 'the first task of this festival\'s own list');
    assert.ok(await page.$('.todo'), 'the heads-up\'s own instruction, the camp list by the clock');
    // The link a push carries lands on the same screen, on a phone that has never opened the app.
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026&alert=${encodeURIComponent(hu.id)}`);
    await page.waitForSelector('.alerthead');
    assert.match(await page.textContent('.alerthead h2'), /Storms expected around 5:00 PM/);
    assert.match(await page.textContent('.donow .t'), /^Secure camp (now|before you turn in)/);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a full phone: the settings still save, the weather copy is let go and Diagnostics says so; only what a reload needs is kept at all', async () => {
  const { page, context, seen } = await newPage();
  await page.addInitScript(() => {
    const real = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k, v) { if (k === 'fieldwatch.web' && window.__full && String(v).length > 2000) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return real.call(this, k, v); };
  });
  const { server, base: api } = await fakeBackend([...FESTS]);
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
    await page.waitForFunction(() => { const d = JSON.parse(localStorage.getItem('fieldwatch.web')); return Boolean(d.cache && d.cache['hulaween-2026'] && d.cache['hulaween-2026'].hourly); });
    let kept = await page.evaluate(() => { S.cache['elsewhere-2026'] = { alerts: [], hourly: [] }; S.cache['hulaween-2026'].flashes = { flashes: [] }; save(); return JSON.parse(localStorage.getItem('fieldwatch.web')); });
    assert.deepEqual(Object.keys(kept.cache), ['hulaween-2026'], 'a festival neither chosen nor a favorite is not kept');
    assert.equal('flashes' in kept.cache['hulaween-2026'], false, 'flashes are a minute of satellite, fetched again, never kept');
    assert.ok(kept.cache['hulaween-2026'].hourly.length > 0);
    // The store is full. The settings save without the weather copy, and Diagnostics says so.
    await page.evaluate(() => { window.__full = true; save(); });
    kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fieldwatch.web')));
    assert.equal(kept.fest, 'hulaween-2026', 'the chosen festival survives'); assert.deepEqual(kept.cache, {}); assert.equal(kept.toured, true);
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('h1.title:has-text("Settings")');
    await page.click('button.row:has-text("Diagnostics")'); await page.waitForSelector('h1.title:has-text("Diagnostics")');
    await page.waitForFunction(() => /Storage is full/.test(document.body.textContent));
    assert.equal(await page.textContent('.kv:has(.k:text-is("Saved")) .v'), 'Storage is full, so the last weather is not kept between opens');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('no signal: the radar plays the loop from before it dropped, and says that is what it is', async () => {
  const { page, context, seen, live } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const STEP = 10 * 60000, newest = Math.floor((Date.now() - 12 * 60000) / STEP) * STEP;
  const frames = Array.from({ length: 24 }, (_, i) => { const t = newest - (23 - i) * STEP; return { time: new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z'), url: `/radar/hulaween-2026/${new Date(t).toISOString().slice(0, 16).replace(/[-:]/g, '')}Z.png` }; });
  store.radar['hulaween-2026'] = { festivalId: 'hulaween-2026', hours: 12, stepMinutes: 10, size: 512, bounds: { west: 0, south: 0, east: 1, north: 1 }, attribution: 'NOAA NEXRAD via Iowa Environmental Mesonet', frames };
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky');
    await page.click('button.orb:has-text("Radar")');
    await page.waitForFunction(() => document.querySelectorAll('.frame').length === 24 && document.getElementById('radar-loaded')?.textContent === '');
    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('fieldwatch.web')).cache['hulaween-2026'].radar);
    assert.equal(kept.frames.length, 24, 'the loop that played is kept with the festival');
    // The signal drops: the backend and the archive are out of reach. The frames the service worker kept still answer (stood in for here).
    live.iem = false;
    await page.route(`${api}/**`, r => (/\/radar\/[^/]+\/[^/]+\.png$/.test(r.request().url()) ? r.fulfill({ status: 200, contentType: 'image/png', body: PNG }) : r.abort('failed')));
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    await page.click('button.orb:has-text("Radar")');
    await page.waitForFunction(() => document.getElementById('radar-loaded')?.textContent === 'No signal. This is the loop from before it dropped.');
    assert.equal(await page.$$eval('.frame', els => els.length), 24, 'the kept loop, not the archive\'s 48');
    assert.equal(await page.evaluate(() => radar.loop.kept), true);
    assert.match(await page.textContent('#radar-ago'), /ago/, 'the stamp is honest about the age');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('a warning that lands while the page is open takes the screen with the line to act on; when it ends, the all-clear is a moment, not a blank', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const p = alertFeature().properties, hour = new Date(Date.now() + 3600000).toISOString();
  const storm = { id: p.id, event: p.event, headline: p.headline ?? null, body: p.description ?? '', instruction: p.instruction ?? null, severity: 'severe', area: p.areaDesc ?? '', source: 'NWS', issuedAt: p.effective, expiresAt: hour, channel: 'weather', relayCount: 0 };
  store.alerts['hulaween-2026'] = [storm];
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.$('.takeover'), null, 'what was already there when the page opened does not take the screen');
    // A tornado warning lands: the stream says so, the page pulls, and the warning takes the screen.
    const tornado = { ...storm, id: 'urn:oid:tornado-1', event: 'Tornado Warning', headline: 'Tornado Warning until 5:30 PM', severity: 'extreme' };
    store.alerts['hulaween-2026'] = [tornado, storm];
    store.emit({ festivalId: 'hulaween-2026', kind: 'alerts', at: new Date().toISOString() });
    await page.waitForSelector('.takeover');
    assert.equal(await page.textContent('.takeover h2'), 'Tornado Warning');
    assert.equal(await page.textContent('.takeover .do'), 'Get to the shelter now');
    assert.equal(await page.textContent('.takeover p'), 'Lowest floor of a solid building. Not a tent or a car.');
    await page.click('.takeover button:has-text("Open the alert")'); await page.waitForSelector('.alerthead');
    assert.match(await page.textContent('.alerthead h2'), /Tornado Warning/); assert.equal(await page.$('.takeover'), null);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('.sky h2'), 'Tornado Warning');
    // Both warnings end: the sky says so for a while, with what to do now, and the ended one still opens.
    store.alerts['hulaween-2026'] = [];
    store.emit({ festivalId: 'hulaween-2026', kind: 'alerts', at: new Date().toISOString() });
    await page.waitForSelector('.sky.ok.ended');
    assert.equal(await page.textContent('.sky h2'), 'All clear');
    assert.match(await page.textContent('.sky p'), /^Tornado Warning ended \d{1,2}:\d\d [AP]M\. [A-Z][^.]+\.$/, 'the worst one, when it ended, and the first thing to do now');
    await page.click('.sky'); await page.waitForSelector('.alerthead');
    assert.match(await page.textContent('.alerthead h2'), /Tornado Warning/);
    assert.match(await page.textContent('.alerthead .num'), /^Ended \d{1,2}:\d\d [AP]M$/);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('I heard thunder: a thirty-minute clock from a storm alert, on the festival page, that survives a reload and resets on the next rumble', async () => {
  const { page, context, seen } = await newPage();
  try {
    await pickHulaween(page);
    await page.click('.sky'); await page.waitForSelector('.alerthead');
    await page.click('button.thunderbtn');
    await page.waitForSelector('.thunder');
    assert.match(await page.textContent('.thunder .t'), /^Thunder heard \d{1,2}:\d\d [AP]M$/);
    assert.match(await page.textContent('.thunder .s'), /^Stay in shelter until in (29|30) min$/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    assert.ok(await page.$('.thunder'), 'on the festival page too');
    // A reload opens on the home page; the festival is one tap away, and the clock is still running there.
    await page.reload(); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    await page.click('.feedfest:has-text("Suwannee Hulaween") .alert'); await page.waitForSelector('.alerthead'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    assert.ok(await page.$('.thunder'), 'and after a reload');
    const first = await page.$eval('.thunder .t', el => el.textContent);
    await page.evaluate(() => { S.thunder = { at: new Date(Date.now() - 31 * 60000).toISOString() }; save(); tickCountdowns(); });
    await page.waitForSelector('.thunder.over');
    assert.equal(await page.textContent('.thunder .t'), 'Thirty minutes since the thunder');
    await page.waitForSelector('.toast.show:has-text("Thirty minutes since the thunder")');
    await page.click('.thunder button:has-text("Heard it again")');
    await page.waitForSelector('.thunder:not(.over)');
    assert.match(await page.textContent('.thunder .t'), /^Thunder heard/); assert.notEqual(await page.textContent('.thunder .s'), first);
    await page.click('.thunder button:has-text("Clear")');
    assert.equal(await page.$('.thunder'), null);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('no signal: the card says so at once and the page stops asking; back on the air, it catches up by itself', async () => {
  const { page, context, seen } = await newPage();
  try {
    await pickHulaween(page);
    const before = seen.alerts;
    await context.setOffline(true);
    await page.waitForFunction(() => /^No signal\. Last checked/.test(document.querySelector('.sky .foot')?.textContent || ''));
    assert.ok(await page.$('.sky.stale'), 'the card reads as stale');
    assert.equal(await page.textContent('.sky h2'), 'Severe Thunderstorm Warning', 'what it knows stays up');
    await context.setOffline(false);
    for (let i = 0; i < 50 && seen.alerts === before; i++) await new Promise(r => setTimeout(r, 100));
    assert.ok(seen.alerts > before, 'back online, the page asked again without waiting for a timer');
    await page.waitForFunction(() => /^Checked/.test(document.querySelector('.sky .foot')?.textContent || ''));
    assert.equal(await page.$('.sky.stale'), null);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('late lightning files: the tile says the data is old and holds the code; a red at its all-clear says the all-clear waits for data; no data is said, not hidden', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  const minutesAgo = m => new Date(Date.now() - m * 60000).toISOString();
  store.lightning['hulaween-2026'] = { code: 'yellow', nearestMi: 15, nearestAt: minutesAgo(9), within: { 8: 0, 12: 0, 20: 1 }, lastNearMi: null, lastNearAt: null, allClearAt: null, orangeUntil: null, held: true, stale: true, dataAgeSeconds: 420, at: minutesAgo(0), dataAt: minutesAgo(7), source: 'GOES GLM' };
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.click('button:has-text("Use my location")');
    await openPicker(page);
    await page.click('button:has-text("Suwannee Hulaween")'); await page.waitForSelector('.bolt.yellow');
    assert.match(await page.textContent('.bolt .s'), /· data 7 min old$/, 'a held code says how old its data is');
    store.lightning['hulaween-2026'] = { code: 'red', nearestMi: null, nearestAt: null, within: { 8: 0, 12: 0, 20: 0 }, lastNearMi: 4, lastNearAt: minutesAgo(32), allClearAt: new Date(Date.now() + 8 * 60000).toISOString(), allClearHeld: true, orangeUntil: null, held: false, stale: true, dataAgeSeconds: 420, at: minutesAgo(0), dataAt: minutesAgo(7), source: 'GOES GLM' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'lightning', at: minutesAgo(0) });
    await page.waitForSelector('.bolt.red');
    assert.match(await page.textContent('.bolt .s'), /all-clear waits for data \(data 7 min old\)$/);
    await page.click('.bolt'); await page.waitForSelector('.codehead.red');
    assert.equal(await page.textContent('.codehead b'), 'Waiting for data');
    assert.match(await page.textContent('.codehead .s'), /has not reported for 7 min/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    store.lightning['hulaween-2026'] = { code: 'none', at: minutesAgo(0), dataAt: minutesAgo(12), dataAgeSeconds: 720, on: true, source: 'GOES GLM' };
    store.emit({ festivalId: 'hulaween-2026', kind: 'lightning', at: minutesAgo(0) });
    await page.waitForSelector('.bolt.none');
    assert.equal(await page.textContent('.bolt .t'), 'No lightning data · 12 min');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('the forecast screen says when the sun goes down and comes up here, and the hour strip glyphs follow the sun, not a fixed clock', async () => {
  const { page, context, seen } = await newPage();
  try {
    await pickHulaween(page);
    await page.click('button.orb:has-text("Forecast")'); await page.waitForSelector('h1.title:has-text("Weather")');
    assert.match(await page.textContent('.suntimes'), /^(Sunset \d{1,2}:\d\d [AP]M · Sunrise \d{1,2}:\d\d [AP]M|Sunrise \d{1,2}:\d\d [AP]M · Sunset \d{1,2}:\d\d [AP]M)$/);
    // Live Oak, any day of the year: the sun is never up at half past nine at night nor at six in the morning (a fixed clock called six day), and always up at noon.
    const night = await page.evaluate(() => { const f = fest(), t = new Date(); t.setHours(21, 30, 0, 0); return glyph({ shortForecast: 'Clear', startTime: t.toISOString() }, f) === I.moon; });
    const morning = await page.evaluate(() => { const f = fest(), t = new Date(); t.setHours(6, 0, 0, 0); return glyph({ shortForecast: 'Sunny', startTime: t.toISOString() }, f) === I.moon; });
    const noon = await page.evaluate(() => { const f = fest(), t = new Date(); t.setHours(12, 0, 0, 0); return glyph({ shortForecast: 'Sunny', startTime: t.toISOString() }, f) === I.sun; });
    assert.deepEqual([night, morning, noon], [true, true, true]);
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('the safety team: the key rides in on a scanned link, shelter and medical go on the record and onto every alert, a hold wears the sky, a post can be taken back, and a sign prints', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS.map(f => (f.id === 'hulaween-2026' ? { ...f, isPartner: true, shelter: 'The Music Hall and the cars in Lot B', medical: 'Medical tent by the main gate. ER: Shands Live Oak, 8 minutes north.' } : f))]);
  store.partnerKeys['k-partner-hula'] = 'hulaween-2026';
  store.posts.push({ festival: 'hulaween-2026', key: 'k-partner-hula', title: 'Gates closed', body: 'Until further notice.', severity: 'moderate', kind: 'notice' });
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026&staff=1&key=k-partner-hula`);
    await page.waitForSelector('.sky.warn');
    assert.equal(new URL(page.url()).searchParams.get('key'), null, 'the key is kept and the address is cleaned');
    assert.equal(await page.evaluate(() => S.admin), 'k-partner-hula');
    await page.waitForFunction(() => S.staffScope && S.staffScope.scope === 'partner');
    // Shelter and medical, from the record, on the festival page.
    await page.click('button.row:has-text("Shelter and medical")'); await page.waitForSelector('h1.title:has-text("Shelter and medical")');
    assert.deepEqual(await page.$$eval('.todo .t', els => els.map(e => e.textContent)), ['Shelter', 'Medical']);
    assert.match(await page.textContent('.todo p'), /^The Music Hall/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // The staff screen for it opens on the record as it is, and saves through the backend.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('button:has-text("Post an update")');
    await page.click('button.row:has-text("Shelter and medical")'); await page.waitForSelector('#r-shelter');
    assert.equal(await page.inputValue('#r-shelter'), 'The Music Hall and the cars in Lot B');
    await page.fill('#r-medical', 'Medical tent by the main gate.'); await page.click('#r-save'); await page.waitForSelector('.toast.show:has-text("Saved")');
    assert.equal(store.list.find(f => f.id === 'hulaween-2026').medical, 'Medical tent by the main gate.');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('h1.title:has-text("Settings")'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // A hold the team called wears the sky in its own color, with its own two lines and the shelter on the alert.
    const until = new Date(Date.now() + 45 * 60000).toISOString();
    store.alerts['hulaween-2026'] = [{ id: 'official-hulaween-2026-7', event: 'Shelter in place', headline: null, body: 'Lightning within 8 miles. Get into a vehicle or a building now.', instruction: 'Shelter: The Music Hall and the cars in Lot B', severity: 'severe', area: 'Suwannee Hulaween', source: 'Suwannee Hulaween staff', issuedAt: new Date().toISOString(), expiresAt: until, channel: 'official', kind: 'shelter', minutes: 45, relayCount: 0 }];
    store.emit({ festivalId: 'hulaween-2026', kind: 'alerts', at: new Date().toISOString() });
    await page.waitForSelector('.takeover'); assert.equal(await page.textContent('.takeover .do'), 'Shelter in place now'); await page.click('.takeover button:has-text("Got it")');
    await page.waitForSelector('.sky.hold');
    assert.equal(await page.textContent('.sky .eyebrow'), 'Festival staff'); assert.equal(await page.textContent('.sky h2'), 'Shelter in place');
    assert.equal(await page.textContent('.sky p'), 'Shelter in place now. Festival staff say so. A vehicle or a building. Not a tent, canopy or stage.');
    await page.click('.sky'); await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('.alerthead .eyebrow'), 'Festival staff'); assert.equal(await page.textContent('.donow .t'), 'Shelter in place now');
    assert.equal(await page.textContent('.todo.shelter p'), 'The Music Hall and the cars in Lot B');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.hold');
    // The official screen: what each post is, how far it reached, and the way back.
    await page.evaluate(() => go('official')); await page.waitForSelector('h1.title:has-text("Festival official")');
    await page.waitForSelector('.row:has-text("Gates closed")');
    assert.match(await page.textContent('.row:has-text("Gates closed") .s.num'), /reached 2 phones/);
    await page.click('.row:has-text("Gates closed") button.retract'); await page.waitForSelector('.toast.show:has-text("Taken back")');
    assert.deepEqual(store.retracted, ['1']);
    await page.waitForSelector('.row:has-text("Gates closed")', { state: 'detached' });
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky');
    // A sign for the gates.
    await page.click('button[aria-label="Share"]'); await page.waitForSelector('h1.title:has-text("Suwannee Hulaween")');
    await page.click('button:has-text("Print a sign")'); await page.waitForSelector('.sign');
    assert.equal(await page.textContent('.sign h1'), 'Suwannee Hulaween');
    assert.match(await page.getAttribute('.sign-qr', 'src'), /\/festivals\/hulaween-2026\/qr\.svg$/);
    assert.match(await page.textContent('.sign-url'), /\?f=hulaween-2026$/);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
});

test('hard conditions: sun mode, text size and battery saver from Settings, the phone\'s own back, focus that survives a redraw, a warning said out loud, and targets a thumb can hit', async () => {
  const { page, context, seen } = await newPage();
  try {
    await pickHulaween(page);
    // Every tappable thing is at least 44 px tall.
    const short = await page.$$eval('button, summary, a[href]', els => els.filter(e => e.offsetParent !== null && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < 43.5).map(e => `${e.className || e.tagName}: ${Math.round(e.getBoundingClientRect().height)}`));
    assert.deepEqual(short, [], 'nothing under 44 px');
    // Focus stays where it was when data lands and the screen redraws in place.
    await page.focus('button.row:has-text("Favorite")');
    await page.evaluate(() => render());
    assert.match(await page.evaluate(() => document.activeElement && document.activeElement.textContent), /Favorite/, 'the row kept focus through a redraw');
    // Sun mode, text size and the saver, from Settings, kept across a reload.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('h1.title:has-text("Settings")');
    await page.click('button.row:has-text("Sun mode")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'sun');
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(255, 255, 255)');
    await page.click('button.chip:has-text("Larger")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.text), 'larger');
    await page.click('button.row:has-text("Battery saver")');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.saver), '1');
    assert.equal(await page.textContent('button.row:has-text("Battery saver") .pill'), 'On');
    await page.reload(); await page.waitForSelector('span.eyebrow:has-text("Right now")');
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.text, document.documentElement.dataset.saver]), ['sun', 'larger', '1'], 'kept');
    // In the saver the radar opens on the present, paused.
    await page.click('.feedfest:has-text("Suwannee Hulaween") .alert'); await page.waitForSelector('.alerthead'); await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    await page.click('button.orb:has-text("Radar")'); await page.waitForSelector('#radar-play');
    await page.waitForFunction(() => document.getElementById('radar-play')?.getAttribute('aria-label') === 'Play');
    // The phone's own back pops the screen it came from: the browser's history and the app's stack agree.
    await page.goBack(); await page.waitForSelector('.sky.warn');
    await page.click('button.orb:has-text("Forecast")'); await page.waitForSelector('h1.title:has-text("Weather")');
    await page.goBack(); await page.waitForSelector('.sky.warn');
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('h1.title:has-text("Settings")');
    await page.click('button.row:has-text("Sun mode")'); await page.click('button.chip:has-text("Normal")'); await page.click('button.row:has-text("Battery saver")');
    assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.text, document.documentElement.dataset.saver]), [undefined, undefined, undefined]);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // A warning landing is said out loud to a screen reader, with the line to act on.
    await page.route(/api\.weather\.gov\/alerts\/active/, r => r.fulfill(json({ type: 'FeatureCollection', features: [alertFeature(), alertFeature({ id: 'urn:oid:tornado-2', '@id': 'https://api.weather.gov/alerts/urn:oid:tornado-2', event: 'Tornado Warning', severity: 'Extreme', headline: 'Tornado Warning until 5:30 PM' })] })));
    await page.evaluate(() => refresh(fest()));
    await page.waitForFunction(() => /Tornado Warning/.test(document.getElementById('live')?.textContent || ''));
    assert.equal(await page.textContent('#live'), 'Warning: Tornado Warning. Get to the shelter now.');
    await page.click('.takeover button:has-text("Got it")');
    assert.deepEqual(seen.errors, []);
  } finally { await context.close(); }
});

test('the later tier: storm reports and the warning\'s own area on the radar square, a code the safety team sets, the record as a sheet, the ground under your own spot, the lines to act on in Spanish, and the zone question without a backend', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS.map(f => (f.id === 'hulaween-2026' ? { ...f, isPartner: true } : f))]);
  store.partnerKeys['k-partner-hula'] = 'hulaween-2026';
  const valid = new Date(Date.now() - 20 * 60000).toISOString(), p = alertFeature().properties;
  store.lsr['hulaween-2026'] = [{ kind: 'HAIL', magnitude: 1, unit: 'IN', place: 'Live Oak', at: valid, latitude: 30.549, longitude: -82.9395, mi: 10, heading: 'N', remark: 'Quarter size hail reported by the public.' }];
  // The warning drawn by the forecaster, around the grounds; the other alert names the whole zone and draws nothing.
  const poly = { type: 'Polygon', coordinates: [[[-83.1, 30.3], [-82.8, 30.3], [-82.8, 30.5], [-83.1, 30.5], [-83.1, 30.3]]] };
  const shape = { headline: p.headline, body: p.description, instruction: p.instruction, area: p.areaDesc, source: p.senderName, issuedAt: p.effective, onset: p.onset, expiresAt: new Date(Date.now() + 3600000).toISOString(), channel: 'weather', relayCount: 0 };
  store.alerts['hulaween-2026'] = [{ ...shape, id: p.id, event: p.event, severity: 'severe', geometry: poly }, { ...shape, id: 'urn:oid:zone-wide', event: 'Wind Advisory', severity: 'minor', geometry: null }];
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill(json({ name: 'Live Oak', address: { city: 'Live Oak', county: 'Suwannee County', state: 'Florida' } })));
  try {
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026&staff=1&key=k-partner-hula`);
    await page.waitForSelector('.sky.warn'); await page.waitForFunction(() => S.staffScope && S.staffScope.scope === 'partner');
    // Storm reports under the alerts, in words, with the distance and the side.
    await page.click('button.orb:has-text("Forecast")'); await page.waitForSelector('h1.title:has-text("Weather")');
    await page.waitForSelector('.lsr-row');
    assert.equal(await page.textContent('.lsr-row .t'), 'Hail');
    assert.match(await page.textContent('.lsr-row .s'), /^1 in · Live Oak · 10 mi N · 20 min agoQuarter size hail/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // On the radar square: the warning's outline, a diamond where the hail fell, and a key that names only what is drawn.
    await page.click('button.orb:has-text("Radar")'); await page.waitForSelector('#radar-play');
    assert.equal(await page.$$eval('.rmap .poly path.warn', els => els.length), 1, 'the warning\'s own area');
    assert.equal(await page.$$eval('.rmap .poly path', els => els.length), 1, 'the zone-wide advisory draws nothing');
    assert.equal(await page.$$eval('.rmap .lsr', els => els.length), 1, 'the report where it was seen');
    assert.match(await page.textContent('.note:has-text("Outline")'), /^Outline: the warning's own area · Yellow dots: flashes of the last half hour · Diamonds: storm reports of the last three hours\.$/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    await page.click('.sky'); await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('button.row:has-text("Its area on the radar") .t'), 'Its area on the radar');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // The safety team raises the code with the festival's key, with why; the page says so everywhere; releasing it hands the grade back to the mapper.
    await page.evaluate(() => go('lightning')); await page.waitForSelector('h1.title:has-text("Lightning")');
    await page.click('summary:has-text("Set the code as staff")');
    await page.click('button.chip:has-text("Orange")'); await page.click('button.chip:has-text("2 hours")');
    await page.fill('#staff-note', 'Vendor detection shows a cell building to the west');
    await page.click('#staff-set'); await page.waitForSelector('.toast.show:has-text("Code Orange stands until")');
    assert.equal(store.staff['hulaween-2026'].code, 'orange'); assert.equal(store.staff['hulaween-2026'].note, 'Vendor detection shows a cell building to the west');
    assert.ok(Math.abs(Date.parse(store.staff['hulaween-2026'].until) - Date.now() - 120 * 60000) < 10000, 'two hours');
    await page.waitForSelector('.codehead.orange');
    assert.equal(await page.textContent('.codehead .eyebrow'), 'Set by staff');
    assert.match(await page.textContent('.codehead .motion.staffed'), /^Code Orange set by staff until \d+:\d\d [AP]M: Vendor detection shows a cell building to the west$/);
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.bolt.orange');
    assert.match(await page.textContent('.bolt .s'), /· set by staff$/);
    await page.evaluate(() => go('lightning')); await page.waitForSelector('#staff-release');
    await page.click('#staff-release'); await page.waitForSelector('.toast.show:has-text("Released")');
    assert.deepEqual(store.staff, {}); await page.waitForSelector('.codehead.none');
    assert.equal(await page.textContent('.codehead .eyebrow'), 'GOES lightning mapper');
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // The record comes down as a sheet, fetched with the key.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('button.row:has-text("Download the record")');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('button.row:has-text("Download the record")')]);
    assert.equal(dl.suggestedFilename(), 'hulaween-2026-record.csv');
    assert.match(readFileSync(await dl.path(), 'utf8'), /^at,kind,what,detail\n"2026-10-23T14:02:00Z","alert"/);
    assert.ok(store.calls.includes('GET /festivals/hulaween-2026/log'));
    await page.click('button[aria-label="Back"]'); await page.waitForSelector('.sky.warn');
    // Your own spot gets the ground too, and a row says what the rain already down made of it.
    store.pointGround = { past: { in24: 2.0, in48: 2.6, source: 'IEM' } };
    await page.evaluate(() => { S.here = { latitude: 30.4, longitude: -82.94, at: Date.now() }; goHere(); });
    await page.waitForSelector('.row:has-text("Ground now")');
    assert.ok(store.calls.includes('GET /point/30.4000,-82.9400/ground'), 'asked by where it is');
    assert.equal(await page.textContent('.row:has-text("Ground now") .t'), 'Ground now: Paths are soft and muddy');
    assert.equal(await page.textContent('.row:has-text("Ground now") .s'), '2.6 in of rain in the last two days');
    // pick() moves after a beat (later): wait for the move itself, then for the refresh it started, so Settings is not left under a late navigation.
    await page.evaluate(() => pick('hulaween-2026')); await page.waitForFunction(() => S.fest === 'hulaween-2026' && S.screen === 'home' && !S.busy); await page.waitForSelector('h1.title:has-text("Suwannee Hulaween")');
    // Spanish: the sky's two lines, the orbs and the alert's words; the rest of the page stays as it was. Kept across a reload.
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('button.chip:has-text("Español")'); await page.waitForFunction(() => !S.queueBusy);
    await tapChip(page, 'Español');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'es');
    await backToTop(page); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('.sky .eyebrow'), 'Ahora mismo');
    assert.equal(await page.textContent('.sky p'), 'Entre a un vehículo o un edificio. No una carpa, un toldo ni un escenario.');
    assert.deepEqual(await page.$$eval('.orbrow .orb .l', els => els.map(e => e.textContent)), ['Radar', 'Alertas', 'Pronóstico']);
    await page.click('.sky'); await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('.alerthead .eyebrow'), 'Aviso'); assert.equal(await page.textContent('.donow .t'), 'Entre a un vehículo o un edificio');
    assert.equal(await page.textContent('.alerthead h2'), 'Severe Thunderstorm Warning', 'the weather service\'s own words stay');
    await page.reload(); await page.waitForSelector('.feedfest:has-text("Suwannee Hulaween") .alert');   // without a location the festivals list is the home page
    assert.equal(await page.evaluate(() => S.lang), 'es');
    await page.click('.feedfest:has-text("Suwannee Hulaween") .alert'); await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('.alerthead .eyebrow'), 'Aviso', 'kept across a reload');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
  // Without a backend the page asks the weather service the backend's question: by the county and forecast zone the grounds sit in.
  const second = await newPage();
  try {
    await pickHulaween(second.page);
    assert.ok(second.seen.alertUrls.some(u => /alerts\/active\?zone=FLC121,FLZ024$/.test(u)), `asked by zone: ${second.seen.alertUrls.join(' ')}`);
    assert.ok(second.seen.alertUrls.some(u => /point=/.test(u)), 'the festivals list\'s glance at the others still asks by point: no lookup per festival for a glance');
    assert.deepEqual(second.seen.errors, []);
  } finally { await second.context.close(); }
});

test('metrics: counts with nobody in them on a screen for everyone, seven or thirty days with a sparkline per tile, a festival or all of them, and the season report as a sheet for the staff', async () => {
  const { page, context, seen } = await newPage();
  const { server, store, base: api } = await fakeBackend([...FESTS.map(f => (f.id === 'hulaween-2026' ? { ...f, isPartner: true } : f))]);
  store.partnerKeys['k-partner-hula'] = 'hulaween-2026';
  try {
    // Anyone, no key: the festival's numbers from its Settings, every festival on a tap.
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}&f=hulaween-2026`);
    await page.waitForSelector('.sky.warn'); await page.waitForFunction(() => !S.busy);
    await page.click('button[aria-label="Settings"]'); await page.waitForSelector('button.row:has-text("Metrics")');
    assert.equal(await page.$('button.row:has-text("Season report")'), null, 'the sheet is the staff\'s');
    await page.click('button.row:has-text("Metrics")'); await page.waitForSelector('h1.title:has-text("Metrics")'); await page.waitForSelector('.tile');
    assert.ok(store.calls.includes('GET /festivals/hulaween-2026/stats'), 'the festival\'s own numbers, no key sent');
    assert.equal(await page.textContent('.tile:has-text("Opens") .n'), '134');
    assert.equal(await page.textContent('.tile:has-text("Following") .n'), '57');
    assert.equal(await page.textContent('.tile:has-text("Delivered") .n'), '97%');
    assert.equal(await page.textContent('.tile:has-text("Latency") .n'), '41 s');
    assert.equal(await page.$$eval('.tile:has-text("Opens") .spark path', els => els.length), 1, 'a sparkline per counted tile');
    assert.equal(await page.textContent('.codecard p'), 'Red 25 min · Orange 0 min · Yellow 0 min · Green 600 min');
    assert.equal(await page.$('.tile:has-text("Polling")'), null, 'nothing fleet-wide on a festival\'s view');
    await page.click('button.chip:has-text("30 days")'); await page.waitForFunction(() => S.metrics && S.metrics.days === 30);
    assert.equal(await page.$$eval('.tile:has-text("Opens") .spark path', els => els.length), 1);
    await page.click('button.chip:has-text("All festivals")'); await page.waitForSelector('.tile:has-text("Polling")');
    assert.ok(store.calls.includes('GET /stats') && !store.calls.includes('GET /admin/stats'), 'the public route, never the admin one');
    assert.equal(await page.textContent('.tiles.three .tile:has-text("Lightning") .n'), '2');
    assert.ok((await page.$$eval('.group .row .t', els => els.map(e => e.textContent))).includes('Suwannee Hulaween'), 'by festival');
    assert.deepEqual(await page.$$eval('.chips', els => els.map(e => e.getBoundingClientRect().height < 60)), [true, true], 'each chip row on one line');
    // The festivals list has the row too.
    await backToTop(page); await page.waitForSelector('h1.title:has-text("Settings")'); await backToTop(page); await page.waitForSelector('.sky.warn');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('button.row:has-text("Metrics")');
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
  // The festival's staff: the season report comes down as a sheet.
  const second = await newPage();
  const { server: srv2, store: store2, base: api2 } = await fakeBackend([...FESTS.map(f => (f.id === 'hulaween-2026' ? { ...f, isPartner: true } : f))]);
  store2.partnerKeys['k-partner-hula'] = 'hulaween-2026';
  try {
    await second.page.goto(`${base}/index.html?backend=${encodeURIComponent(api2)}&f=hulaween-2026&staff=1&key=k-partner-hula`);
    await second.page.waitForSelector('.sky.warn'); await second.page.waitForFunction(() => S.staffScope && S.staffScope.scope === 'partner'); await second.page.waitForFunction(() => !S.busy);
    await second.page.click('button[aria-label="Settings"]'); await second.page.waitForSelector('button.row:has-text("Season report")'); await second.page.waitForFunction(() => !S.queueBusy);
    assert.equal(await second.page.$$eval('button.row:has-text("Metrics")', els => els.length), 1, 'one Metrics row, for everyone');
    const [dl] = await Promise.all([second.page.waitForEvent('download'), second.page.click('button.row:has-text("Season report")')]);
    assert.equal(dl.suggestedFilename(), 'hulaween-2026-season-report.csv');
    assert.match(readFileSync(await dl.path(), 'utf8'), /^"Fieldwatch season report"\n/);
    assert.deepEqual(second.seen.errors, []);
  } finally { srv2.closeAllConnections(); srv2.close(); await second.context.close(); }
});

test('the dashboard: tiles a tap opens, every alert in effect, the festivals by code; location on every open; a spot shared as a link that a contact can get warnings for', async () => {
  const { page, context, seen } = await newPage();
  await context.grantPermissions(['geolocation']); await context.setGeolocation({ latitude: 30.404, longitude: -82.9395 });   // on the grounds at Hulaween
  const { server, store, base: api } = await fakeBackend([...FESTS]);
  await page.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill(json({ name: 'Live Oak', address: { city: 'Live Oak', county: 'Suwannee County', state: 'Florida' } })));
  await page.addInitScript(() => { window.__shared = null; navigator.share = async d => { window.__shared = d; }; });
  try {
    // A phone that once said "I'll pick a festival" still gets located on the next open: the festival it stands at opens.
    await page.goto(`${base}/index.html?backend=${encodeURIComponent(api)}`);
    await page.evaluate(() => { S.welcomed = true; S.geoSkip = true; save(); });   // past the walkthrough, having declined location there
    await page.reload(); await page.waitForSelector('.sky.warn', { timeout: 10000 });
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'located on open, the festival you stand at');
    // The dashboard.
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('.tiles.dash'); await page.waitForFunction(() => !S.feedBusy && S.dash);
    const tiles = await page.$$eval('.tiles.dash .kpi', els => els.map(e => [e.querySelector('.k').textContent, e.querySelector('.n').textContent]));
    assert.deepEqual(tiles.map(t => t[0]), ['Festivals', 'Warnings', 'Nearest', 'Lightning', 'Following', 'Pushed'], 'six tiles, one word each');
    assert.equal(tiles[1][1], '1', 'one warning in effect'); assert.equal(tiles[2][1], 'right here', 'the nearest festival is under your feet'); assert.equal(tiles[4][1], '57');
    assert.ok(store.calls.includes('GET /stats'), 'the counts, with nobody in them');
    assert.match(await page.textContent('.dash-alerts .alert .s'), /^Suwannee Hulaween · Warning/, 'every alert in effect, with its festival');
    await page.click('.tiles.dash .kpi:has-text("Nearest")'); await page.waitForSelector('.sky.warn');
    assert.equal(await page.textContent('h1.title'), 'Suwannee Hulaween', 'a tile opens what it counts');
    await page.click('button:has-text("Festivals")'); await page.waitForSelector('.tiles.dash');
    await page.click('.dash-alerts .alert'); await page.waitForSelector('.alerthead');
    assert.equal(await page.textContent('.alerthead h2'), 'Severe Thunderstorm Warning');
    // Share my spot: a link with the position, through the phone's own share sheet.
    await page.evaluate(() => go('feed')); await page.waitForSelector('button.row:has-text("Share my spot")');
    await page.click('button.row:has-text("Share my spot")');
    const shared = await page.evaluate(() => window.__shared);
    assert.match(shared.url, /\?spot=30\.4040,-82\.9395$/, 'the spot, never a name'); assert.match(shared.text, /turn on warnings/);
    assert.deepEqual(seen.errors, []);
  } finally { server.closeAllConnections(); server.close(); await context.close(); }
  // The contact: the link opens on that spot, shared with them, warnings a tap away, and their own position never moves it.
  const second = await newPage();
  await second.context.grantPermissions(['geolocation']); await second.context.setGeolocation({ latitude: 39.7392, longitude: -104.9903 });   // in Denver
  const { server: srv2, store: store2, base: api2 } = await fakeBackend([...FESTS]);
  await second.page.route(/nominatim\.openstreetmap\.org\/reverse/, r => r.fulfill(json({ name: 'Live Oak', address: { city: 'Live Oak', county: 'Suwannee County', state: 'Florida' } })));
  try {
    await second.page.goto(`${base}/index.html?backend=${encodeURIComponent(api2)}&spot=30.4040,-82.9395`);
    await second.page.waitForSelector('.sky.warn', { timeout: 10000 });
    assert.equal(await second.page.textContent('h1.title'), 'Shared spot');
    assert.match(await second.page.textContent('span.eyebrow'), /^Shared with you/);
    await second.page.waitForFunction(() => /Live Oak, Florida/.test(document.querySelector('.sub')?.textContent || ''));
    await second.page.waitForFunction(() => S.here && S.here.latitude > 39);
    assert.deepEqual(await second.page.evaluate(() => [S.hereFest.latitude, S.hereFest.longitude, S.hereFest.shared]), [30.404, -82.9395, true], 'the spot stays where it was shared, not where this phone is');
    assert.ok(await second.page.$('button.row:has-text("Warnings on this phone")'), 'its warnings one tap away');
    assert.equal(await second.page.$('button.row:has-text("Share my spot")'), null, 'a shared spot is not yours to share on');
    assert.deepEqual(second.seen.errors, []);
  } finally { srv2.closeAllConnections(); srv2.close(); await second.context.close(); }
});
