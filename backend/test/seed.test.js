import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DB_PATH = ':memory:';
const { seedIfEmpty, seedAll } = await import('../src/seed.js');
const { q } = await import('../src/db.js');

test('an empty database is seeded once from data/festivals.json, and never re-seeded over itself', () => {
  assert.equal(q.allFestivals().length, 0);
  assert.equal(seedIfEmpty(), 11);
  assert.equal(q.allFestivals().length, 11);
  assert.equal(seedIfEmpty(), 0, 'already has festivals');
  assert.equal(seedAll(), 11, 'an explicit seed updates in place');
  assert.equal(q.allFestivals().length, 11);
});
