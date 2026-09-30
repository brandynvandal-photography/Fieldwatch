import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

// env.js runs at import, so each case is its own process; a backend/.env would win over the volume, as it should.
const run = env => JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  "await import('./src/env.js'); console.log(JSON.stringify([process.env.DB_PATH, process.env.RADAR_DIR, process.env.AUDIO_DIR].map(v => v ?? null)))"],
{ cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH, ...env }, encoding: 'utf8' }).trim());

test('on Railway an attached volume holds the database, radar frames and clips unless a variable says otherwise', () => {
  assert.deepEqual(run({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }), ['/data/fieldwatch.db', '/data/radar', '/data/audio']);
  assert.deepEqual(run({ RAILWAY_VOLUME_MOUNT_PATH: '/data', DB_PATH: 'elsewhere.db', AUDIO_DIR: '/clips' }), ['elsewhere.db', '/data/radar', '/clips']);
  assert.deepEqual(run({}), [null, null, null], 'no volume, no defaults: db.js, radar.js and app.js pick theirs');
});
