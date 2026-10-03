// Where the web build lives, and who we are to every service we read. Both have defaults, so nobody has to set a
// thing: the weather service, the radar archive, Wikidata and the festival sites each ask for a User-Agent that says
// who to reach, and a website is a contact (the weather service and Wikimedia both say so), so the default names this
// app's own page. NWS_USER_AGENT replaces it, for a deployment that would rather give a mailbox; the example.com
// placeholder an old .env carried counts as unset.
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const SITE = (process.env.SITE_URL || 'https://brandynvandal-photography.github.io/Fieldwatch/').replace(/\/?$/, '/');
export const DEFAULT_USER_AGENT = `Fieldwatch/${version} (+${SITE})`;
/** Unset, blank, or the placeholder an old .env.example carried. */
export const placeholderAgent = ua => !String(ua ?? '').trim() || /example\.com/i.test(ua);
/** The agent to send: the one set, else the default. */
export const userAgent = (ua = process.env.NWS_USER_AGENT) => (placeholderAgent(ua) ? DEFAULT_USER_AGENT : String(ua).trim());
export const USER_AGENT = userAgent();
