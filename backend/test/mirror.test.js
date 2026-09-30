// The weather logic lives in backend/src/incoming.js and is copied, byte for byte, into web/index.html between the same
// markers. This is the test that makes "keep them in step by hand" hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const block = s => { const m = /\/\/ ==== shared: start ====\n([\s\S]*?)\/\/ ==== shared: end ====/.exec(s); return m && m[1]; };
test('the weather logic in the web build is the backend\'s, byte for byte', () => {
  const be = block(readFileSync(new URL('../src/incoming.js', import.meta.url), 'utf8'));
  const web = block(readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8'));
  assert.ok(be && web, 'both carry the shared block between its markers');
  assert.equal(web, be, 'web/index.html has drifted from backend/src/incoming.js: copy the block between the markers across');
});
