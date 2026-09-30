// Reads ../.env into process.env when the file exists. Variables already set in
// the environment win, which is what deployment platforms expect. Entry points
// (server.js, seed.js, poller.js) import this first so db.js sees DB_PATH.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) {
  if (typeof process.loadEnvFile === 'function') process.loadEnvFile(envPath);
  else console.warn('Node 20.12+ reads .env automatically; on older Node start with: node --env-file=.env src/server.js');
}

// A Railway volume announces its mount path. Unless told otherwise, the database, radar frames and
// clips live there, so attaching a volume is the whole setup and a redeploy keeps what phones subscribed.
const volume = process.env.RAILWAY_VOLUME_MOUNT_PATH;
if (volume) {
  process.env.DB_PATH ||= join(volume, 'fieldwatch.db');
  process.env.RADAR_DIR ||= join(volume, 'radar');
  process.env.AUDIO_DIR ||= join(volume, 'audio');
}
