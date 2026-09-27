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
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript' };
const SHOTS = process.env.SHOTS;
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const shot = (page, name) => SHOTS ? page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: false }) : Promise.resolve();

let server, base, browser;
before(async () => {
  server = http.createServer((req, res) => {
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
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: 'America/New_York', locale: 'en-US' });
  const page = await context.newPage();
  const seen = { alerts: 0, points: 0, hourly: 0, frames: [], tiles: 0, errors: [] };
  const live = { nws: true, iem: true };
  page.on('pageerror', e => seen.errors.push(String(e)));
  // Aborted requests log 'Failed to load resource'; that is the network, not the page, so only script errors count.
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) seen.errors.push(m.text()); });
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

test('the picker lists the real festivals, dated and grouped by how soon they start', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('button.row');
  const names = await page.$$eval('button.row .t', els => els.map(e => e.textContent));
  assert.equal(names.length, 11);
  assert.ok(names.includes('Suwannee Hulaween') && names.includes('Escape Halloween') && names.includes('Austin City Limits, Weekend 2'));
  const headings = await page.$$eval('p.h', els => els.map(e => e.textContent));
  assert.deepEqual(headings, ['Coming up', 'Later this season']);
  assert.match(await page.textContent('body'), /Oct 1 – Oct 4/, 'Aftershock ends on the 4th, not at the midnight stamp on the 5th');
  assert.match(await page.textContent('button.row:has-text("Sick New World")'), /Oct 24(?! –)/, 'a one-day festival shows one date');
  assert.match(await page.textContent('p.note'), /checked 2026-09-27/);
  await shot(page, '1-picker');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('picking a festival pulls live alerts and the hourly forecast from the weather service', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.click('button.row:has-text("Suwannee Hulaween")');
  await page.waitForSelector('.status.warn');
  assert.equal(await page.textContent('.status h2'), 'Severe Thunderstorm Warning');
  assert.match(await page.textContent('.status p'), /Take shelter now/);
  assert.match(await page.textContent('.pill'), /^Live/);
  assert.equal(seen.alerts, 1); assert.equal(seen.points, 1); assert.equal(seen.hourly, 1);
  await shot(page, '2-channels');

  await page.click('button.row:has-text("Weather")');
  await page.waitForSelector('.hourly .hr');
  assert.equal(await page.$$eval('.hourly .hr', els => els.length), 24, 'the strip shows the next 24 of the 36 fetched hours');
  assert.match(await page.textContent('.hourly .hr .tp'), /84°/);
  const alertRow = page.locator('button.row:has-text("Severe Thunderstorm Warning")');
  assert.match(await alertRow.textContent(), /Until Oct 23, 3:00 PM/);
  assert.match(await page.textContent('p.note:last-of-type'), /National Weather Service\. Checked/);
  await shot(page, '3-weather');

  await alertRow.click();
  assert.equal(await page.textContent('.alerthead h2'), 'Severe Thunderstorm Warning');
  assert.match(await page.textContent('.body'), /near Live Oak/);
  assert.match(await page.textContent('.group'), /NWS Jacksonville FL/);
  await shot(page, '4-alert');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('the radar screen asks the archive for 48 frames, newest first, and plays them', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.click('button.row:has-text("Suwannee Hulaween")');
  await page.waitForSelector('.status.warn');
  await page.click('button.row:has-text("Weather")');
  await page.click('button.row:has-text("Radar")');
  await page.waitForFunction(() => document.querySelectorAll('.frame').length === 48 && document.getElementById('radar-loaded')?.textContent === '');
  assert.equal(seen.frames.length, 48);
  const times = seen.frames.map(t => Date.parse(t));
  assert.ok(times[0] > times[1] && times[0] === Math.max(...times), 'newest frame requested first');
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) assert.equal(sorted[i] - sorted[i - 1], 15 * 60000);
  assert.ok(Date.now() - sorted.at(-1) >= 10 * 60000 && Date.now() - sorted.at(-1) < 25 * 60000, 'newest frame is 10 to 25 minutes old');
  assert.ok(seen.tiles >= 4, 'map tiles under the square');
  assert.ok(await page.$('.frame.on'), 'a frame is showing');
  assert.match(await page.textContent('#radar-time'), /ago|just now/);
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
  await page.goto(`${base}/index.html`);
  await page.click('button.row:has-text("Suwannee Hulaween")');
  await page.waitForSelector('.status.warn');
  live.nws = false;
  await page.click('button[aria-label="Refresh"]');
  await page.waitForSelector('.pill.off');
  assert.match(await page.textContent('.pill'), /^Offline, updated/);
  assert.equal(await page.textContent('.status h2'), 'Severe Thunderstorm Warning', 'the cached alert is still shown');
  assert.match(await page.textContent('.status .tap'), /before signal dropped/);
  await shot(page, '6-offline');

  await page.reload();
  await page.waitForSelector('.status.warn');
  assert.match(await page.textContent('.status h2'), /Severe Thunderstorm Warning/, 'the cache survives a reload');
  assert.deepEqual(seen.errors, []);
  await context.close();
});

test('without a festival chosen, a fresh browser opens on the picker and nothing is fetched', async () => {
  const { page, context, seen } = await newPage();
  await page.goto(`${base}/index.html`);
  await page.waitForSelector('h1.large');
  assert.equal(await page.textContent('h1.large'), 'Which festival?');
  assert.equal(seen.alerts + seen.points + seen.hourly + seen.frames.length, 0);
  await context.close();
});
