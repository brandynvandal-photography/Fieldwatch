// Runs every configured source, at boot and then every IMPORT_HOURS, or once from the command line:
//   node src/importers/index.js
import '../env.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importTicketmaster } from './ticketmaster.js';
import { importSeatGeek } from './seatgeek.js';
import { importEdmtrain } from './edmtrain.js';
import { importWikidata, skipReason as wikidataSkipped } from './wikidata.js';
import { importFeeds } from './feeds.js';

// Wikidata needs no key and is on unless switched off (or NWS_USER_AGENT is still the placeholder), so imports run on a bare deployment.
export const importsConfigured = () => !wikidataSkipped() || Boolean(process.env.TICKETMASTER_KEY || process.env.SEATGEEK_CLIENT_ID || process.env.EDMTRAIN_KEY || process.env.FESTIVAL_FEEDS);
export const imports = { last: null, running: false };
let running = null;

/** One run of every source. A second call while one runs joins it instead of starting another. */
export function runImports(opts = {}) {
  if (running) return running;
  imports.running = true;
  running = (async () => {
    const report = { startedAt: new Date().toISOString() };
    // Widest source first: a festival on several sites is kept once, from the first that listed it.
    try { report.ticketmaster = await importTicketmaster(opts.ticketmaster); } catch (e) { report.ticketmaster = { error: e.message }; }
    try { report.seatgeek = await importSeatGeek(opts.seatgeek); } catch (e) { report.seatgeek = { error: e.message }; }
    try { report.edmtrain = await importEdmtrain(opts.edmtrain); } catch (e) { report.edmtrain = { error: e.message }; }
    try { report.wikidata = await importWikidata(opts.wikidata); } catch (e) { report.wikidata = { error: e.message }; }
    try { report.feeds = await importFeeds(opts.feeds); } catch (e) { report.feeds = { error: e.message }; }
    report.finishedAt = new Date().toISOString();
    imports.last = report;
    console.log(`imports: ${JSON.stringify(report)}`);
    return report;
  })().finally(() => { running = null; imports.running = false; });
  return running;
}

export function startImporters(hours = Number(process.env.IMPORT_HOURS || 24)) {
  if (!importsConfigured()) return false;
  runImports();
  setInterval(runImports, hours * 3_600_000);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  console.log(JSON.stringify(await runImports(), null, 2));
  process.exit(0);
}
