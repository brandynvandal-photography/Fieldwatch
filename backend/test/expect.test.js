// A body against a shape: what is kept, what is cut, what is refused and why.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expect } from '../src/expect.js';

test('strings are trimmed and capped, numbers must be numbers, choices come from the list, unknown fields are dropped', () => {
  const shape = { title: 'string:20', body: 'string?:50', severity: ['minor', 'moderate', 'severe', null], kind: ['notice', 'shelter'], minutes: 'number?', loud: 'boolean?' };
  assert.deepEqual(expect({ title: '  Gates   closed ', kind: 'notice', minutes: '45', extra: 'x' }, shape), { value: { title: 'Gates closed', kind: 'notice', minutes: 45 } });
  assert.deepEqual(expect({ title: 'x'.repeat(21), kind: 'notice' }, shape), { error: 'title is too long (20 characters at most)' });
  assert.deepEqual(expect({ kind: 'notice' }, shape), { error: 'title required' });
  assert.deepEqual(expect({ title: '   ', kind: 'notice' }, shape), { error: 'title required' });
  assert.deepEqual(expect({ title: 'x', kind: 'siren' }, shape), { error: 'kind must be one of notice, shelter' });
  assert.deepEqual(expect({ title: 'x' }, shape), { error: 'kind must be one of notice, shelter' });
  assert.deepEqual(expect({ title: 'x', kind: 'notice', severity: 'loud' }, shape), { error: 'severity must be one of minor, moderate, severe' });
  assert.deepEqual(expect({ title: 'x', kind: 'notice', minutes: 'soon' }, shape), { error: 'minutes must be a number' });
  assert.deepEqual(expect({ title: 'x', kind: 'notice', loud: 'yes' }, shape), { error: 'loud must be true or false' });
  assert.deepEqual(expect({ title: { a: 1 }, kind: 'notice' }, shape), { error: 'title must be text' });
  assert.deepEqual(expect(null, { title: 'string?:5' }), { value: {} });
  assert.throws(() => expect({}, { x: 'nonsense' }), /bad rule/);
});
