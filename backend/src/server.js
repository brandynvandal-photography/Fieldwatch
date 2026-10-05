import './env.js';
import { adminKeyBoot, app } from './app.js';
import { USER_AGENT } from './site.js';
import { startPolling } from './poller.js';
import { startRadarLoop } from './radar.js';
import { seedIfEmpty } from './seed.js';
import { startImporters } from './importers/index.js';
import { startLightning } from './lightning.js';
import { startBackups } from './backup.js';
import { startHousekeeping } from './housekeeping.js';
import { startFreshness } from './metrics.js';

const seeded = seedIfEmpty();
if (seeded) console.log(`Empty database; seeded ${seeded} festivals from data/festivals.json`);
if (adminKeyBoot.key) console.log(`\n==== Admin key, shown this once (kept hashed from here on) ====\n${adminKeyBoot.key}\nPaste it into the web build's Settings (open it with ?staff=1). Lost it: set ADMIN_KEY in the variables, or run npm run admin-key.\n====\n`);
else console.log(`Admin key from the ${adminKeyBoot.source}${adminKeyBoot.madeAt ? `, made ${adminKeyBoot.madeAt}` : ''}`);
console.log(`As ${USER_AGENT} to the weather service, the radar archive, Wikidata and the festival sites`);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Fieldwatch backend on :${port}; database ${process.env.DB_PATH || 'fieldwatch.db'}${process.env.RAILWAY_VOLUME_MOUNT_PATH ? ' (on the Railway volume)' : ''}`);
  startPolling();
  startRadarLoop();
  startBackups();
  startHousekeeping();
  startFreshness();
  if (startImporters()) console.log('Festival imports on (Wikidata, plus any source with a key)');
  console.log(startLightning() ? `Lightning on: GOES GLM from ${process.env.GLM_BUCKETS || 'noaa-goes19,noaa-goes18'} every ${process.env.LIGHTNING_SECONDS || 60} s while a festival is on` : 'Lightning off (LIGHTNING=false)');
});
