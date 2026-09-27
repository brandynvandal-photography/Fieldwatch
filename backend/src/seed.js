import './env.js';
import { readFileSync } from 'node:fs';
import { q } from './db.js';

const festivals = JSON.parse(readFileSync(new URL('../data/festivals.json', import.meta.url), 'utf8'));
for (const f of festivals) q.upsertFestival(f);
console.log(`Seeded ${festivals.length} festivals`);
