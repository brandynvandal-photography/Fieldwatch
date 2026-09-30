import './env.js';
import { app } from './app.js';
import { startPolling } from './poller.js';
import { startRadarLoop } from './radar.js';
import { seedIfEmpty } from './seed.js';
import { startImporters } from './importers/index.js';
import { startLightning } from './lightning.js';

const seeded = seedIfEmpty();
if (seeded) console.log(`Empty database; seeded ${seeded} festivals from data/festivals.json`);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Fieldwatch backend on :${port}; database ${process.env.DB_PATH || 'fieldwatch.db'}${process.env.RAILWAY_VOLUME_MOUNT_PATH ? ' (on the Railway volume)' : ''}`);
  startPolling();
  startRadarLoop();
  if (startImporters()) console.log('Festival imports on (Wikidata, plus any source with a key)');
  console.log(startLightning() ? `Lightning on: GOES GLM from ${process.env.GLM_BUCKETS || 'noaa-goes19,noaa-goes18'} every ${process.env.LIGHTNING_SECONDS || 60} s while a festival is on` : 'Lightning off (LIGHTNING=false)');
});
