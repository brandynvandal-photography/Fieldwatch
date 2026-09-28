import './env.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { q } from './db.js';

const festivals = () => JSON.parse(readFileSync(new URL('../data/festivals.json', import.meta.url), 'utf8'));

/** Load data/festivals.json; entries that already exist are updated in place. The curated list is the featured one. */
export function seedAll() {
  const list = festivals();
  for (const f of list) q.upsertFestival({ origin: 'curated', status: 'published', featured: true, ...f });
  return list.length;
}

/** A fresh database gets the festival list without a separate step, so a first deploy just works. */
export function seedIfEmpty() {
  return q.allFestivals().length ? 0 : seedAll();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(`Seeded ${seedAll()} festivals`);
}
