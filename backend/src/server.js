import './env.js';
import { app } from './app.js';
import { startPolling } from './poller.js';
import { startRadarLoop } from './radar.js';
import { seedIfEmpty } from './seed.js';

const seeded = seedIfEmpty();
if (seeded) console.log(`Empty database; seeded ${seeded} festivals from data/festivals.json`);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Fieldwatch backend on :${port}`);
  startPolling();
  startRadarLoop();
});
