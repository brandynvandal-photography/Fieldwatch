import { test } from 'node:test';
import assert from 'node:assert/strict';

// The old placeholder, as a stale .env would still have it, and a site of our own.
process.env.DB_PATH = ':memory:';
process.env.NWS_USER_AGENT = 'Fieldwatch/0.1 (you@example.com)';
process.env.SITE_URL = 'https://fieldwatch.test/app';
const { DEFAULT_USER_AGENT, SITE, USER_AGENT, placeholderAgent, userAgent } = await import('../src/site.js');
const { productToken } = await import('../src/importers/wikidata.js');

test('who we are: the site with a trailing slash, and an agent that names it unless a real one is set', () => {
  assert.equal(SITE, 'https://fieldwatch.test/app/');
  assert.match(DEFAULT_USER_AGENT, /^Fieldwatch\/\d+\.\d+\.\d+ \(\+https:\/\/fieldwatch\.test\/app\/\)$/);
  assert.equal(USER_AGENT, DEFAULT_USER_AGENT, 'the placeholder in the environment counts as unset');
  for (const bad of [undefined, null, '', '   ', 'Fieldwatch/0.1 (you@example.com)', 'Fieldwatch (ops@EXAMPLE.COM)']) {
    assert.equal(placeholderAgent(bad), true, JSON.stringify(bad));
    assert.equal(userAgent(bad), DEFAULT_USER_AGENT, JSON.stringify(bad));
  }
  assert.equal(placeholderAgent('Fieldwatch/1.0 (ops@fieldwatch.test)'), false);
  assert.equal(userAgent('  Fieldwatch/1.0 (ops@fieldwatch.test) '), 'Fieldwatch/1.0 (ops@fieldwatch.test)');
  assert.equal(productToken(DEFAULT_USER_AGENT), 'fieldwatch', 'robots.txt names us by the first word');
});
