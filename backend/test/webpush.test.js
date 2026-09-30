import { test } from 'node:test';
import assert from 'node:assert/strict';

// No keys in the environment: the server must make its own pair and keep it.
process.env.DB_PATH = ':memory:';
delete process.env.VAPID_PUBLIC_KEY; delete process.env.VAPID_PRIVATE_KEY;

const { q } = await import('../src/db.js');
const { vapidPublicKey, webPushEnabled } = await import('../src/webpush.js');

test('with no VAPID keys configured, a pair is made on boot and kept in the database', () => {
  assert.equal(webPushEnabled(), true);
  const key = vapidPublicKey();
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/, 'a URL-safe base64 P-256 public key');
  const stored = JSON.parse(q.setting('vapid'));
  assert.equal(stored.publicKey, key);
  assert.match(stored.privateKey, /^[A-Za-z0-9_-]{40,}$/);
});

test('a push keeps whole sentences up to its limit', async () => {
  const { sentences } = await import('../src/webpush.js');
  assert.equal(sentences('Short.', 160), 'Short.');
  const long = 'The forecast has a 60% chance of thunder. Move the car to hard ground by 4:45 PM. Paths will be soft and muddy: 0.8 in of rain on grass over clay, after 1.1 in already down.';
  assert.equal(sentences(long, 100), 'The forecast has a 60% chance of thunder. Move the car to hard ground by 4:45 PM.');
  assert.equal(sentences('A'.repeat(200), 50), 'A'.repeat(50), 'no sentence end at all: a plain cut');
});
