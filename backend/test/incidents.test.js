import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { classify, redact, summarize } from '../src/incidents.js';

// Shared with node/test_uploader.py so the two hand-synced category lists cannot drift apart silently.
const samples = JSON.parse(readFileSync(new URL('./fixtures/hazard-samples.json', import.meta.url), 'utf8'));

test('classify agrees with the shared hazard samples', () => {
  for (const s of samples) {
    const got = classify(s.text);
    if (s.category === null) assert.equal(got, null, `"${s.text}" should be dropped`);
    else assert.deepEqual(got, { category: s.category, level: s.level }, `"${s.text}"`);
  }
});

test('classify picks the first matching hazard category with its level', () => {
  assert.deepEqual(classify('Units be advised, lightning within eight miles, weather hold on the main stage'), { category: 'weather', level: 'warning' });
  assert.deepEqual(classify('Medic 2, unresponsive male behind stage two'), { category: 'medical', level: 'advisory' });
  assert.deepEqual(classify('Shots fired near the north gate'), { category: 'threat', level: 'warning' });
  assert.equal(classify('Engine 4 clear, returning to quarters'), null);
  assert.equal(classify(''), null);
  assert.equal(classify(null), null);
});

test('redact removes phone numbers, plate-shaped tokens and name phrases', () => {
  const t = redact('Caller at 352-555-0142 says the tunnel is under water, plate ABC 1234, last name Johnson');
  assert.ok(!t.includes('352-555-0142'), 'phone number stayed');
  assert.ok(!t.includes('ABC 1234'), 'plate stayed');
  assert.ok(!t.includes('Johnson'), 'name stayed');
  assert.ok(t.includes('under water'), 'the hazard text must survive redaction');
});

test('summarize keeps the first sentence and caps at 160 characters', () => {
  assert.equal(summarize('Flooding on the camp road. Units responding.'), 'Flooding on the camp road.');
  const long = summarize('x'.repeat(400));
  assert.equal(long.length, 160);
  assert.ok(long.endsWith('...'));
});
