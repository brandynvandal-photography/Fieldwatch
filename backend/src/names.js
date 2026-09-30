// Festival names as ticket sites print them, reduced to the festival: "Rock The South - Thursday - with Zach Top
// (Rescheduled from 06/11/26)" is Rock The South. Shared by the importers (grouping, display) and the validator
// (is this the same festival another source listed).

const DAYS = String.raw`(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?`;
const PASS = String.raw`(?:(?:vip|ga|general admission|premium|platinum|deluxe|super|weekend|day|night|\d+[- ]?day|(?:one|two|three|four|single|multi)[- ]day)\s+)*pass(?:es)?`;
// A segment (after " - ", ": " or " | ") that names a day, a pass, a lineup or a status rather than the festival.
const TAIL = new RegExp(String.raw`^(?:${DAYS}\b|\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b|(?:\d+|one|two|three|four|five|single|multi)[- ]?(?:day|night)s?\b|(?:day|night|weekend)\s*\d|${PASS}\b|w(?:ith|\/)\b|feat(?:uring|\.)?\b|ft\.?\s|starring\b|presented by\b|sponsored by\b|cancell?ed\b|postponed\b|rescheduled\b|sold out\b|\d\d\+|all ages\b|ages?\s+\d|after ?party\b|kick-?off\b|pre-?party\b|late night\b|official\b|tickets?\b|single day\b|admission\b)`, 'i');
const LINEUP = /\s+(?:with|w\/|feat\.?|featuring|ft\.?)\s+.+$/i;
const TRAIL_DATE = new RegExp(String.raw`\s+(?:${DAYS}\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$`, 'i');
const TRAIL_DAYS = new RegExp(String.raw`\s+(?:\d+\s*days?|${PASS}|${DAYS}|20\d\d)$`, 'i');
const LEAD_DAYS = /^(?:\d+|one|two|three|four)[- ]day\s+/i;

/** The festival in a listing's name: no parenthetical, no day, pass, lineup or status, no trailing year. */
export function cleanName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '');
  s = s.replace(LEAD_DAYS, '');
  const parts = s.split(/(\s+[-–—|]\s+|\s+[-–—]\s*|:\s+)/);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) { const seg = parts[i + 1] || ''; if (TAIL.test(seg)) break; out += parts[i] + seg; }
  s = out.replace(LINEUP, '');
  for (let i = 0; i < 3; i++) s = s.replace(TRAIL_DATE, '').replace(TRAIL_DAYS, '');
  s = s.replace(/[\s\-–—:|,]+$/, '').replace(/^[\s\-–—:|,]+/, '').trim();
  return s || String(raw).trim();
}

const NOISE = /\b(20\d\d|(mon|tues|wednes|thurs|fri|satur|sun)day|weekend \d|day \d|\d[- ]?day|(one|two|three|four|single|multi)[- ]day|pass(es)?|vip|ga|general admission|admission|ticket(s)?|presale|early bird|tier \d|late night|after ?party|official|only)\b/gi;
/** What two listings of the same festival share once the day and ticket words are gone. */
export const normalizeName = n => cleanName(n).replace(/[-:|–—(),.!&+/'"]+/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

const STOP = new Set(['music', 'festival', 'fest', 'the', 'a', 'an', 'of', 'and', 'at', 'in', 'on', 'weekend', 'presents', 'annual', 'edition']);
/** The words that make a name its own: "Country Calling Festival" and "Country Calling" share one core. */
export const coreName = n => normalizeName(n).split(' ').filter(w => w && !STOP.has(w) && !/^\d+(st|nd|rd|th)$/.test(w)).join(' ');
/** One core is the other, or the other with a word or two on the end: the same festival named twice. */
export const sameCore = (x, y) => { const a = coreName(x), b = coreName(y); return Boolean(a && b) && (a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `) || a.endsWith(` ${b}`) || b.endsWith(` ${a}`)); };

// A listing is a festival, or something sold beside one, or plainly not one.
export const FESTIVAL_WORD = /\b(fest|festival|festivals|fete|jam|jamboree|jubilee|gathering|revival|revue|roundup|round-up|carnival|fair|palooza|weekender|weekend|campout|camp-out|block party|hoedown|smokeout|smoke-out|fiesta|oktoberfest|brewfest|beerfest|bluesfest|jazzfest|rise up|picnic|rendezvous|powwow|pow-wow|days)\b|fest\b|palooza\b|fest$/i;
export const NOT_A_FESTIVAL = /\b(tour|tribute|concert|symphony|philharmonic|orchestra|comedy|awards?|gala|screening|conference|convention|expo|seminar|worship night)\b/i;
export const CANCELLED = /\b(cancell?ed|postponed)\b/i;
export const ADD_ON = /\b(parking|shuttle|camping|campsite|campground|locker|merch|payment plan|layaway|upgrade|add[- ]?on|glamping|rv pass|car pass|bus pass|car registration|registration|kick-?off|after ?party|pre-?party|fest nights?|meet (and|&) greet|package)\b/i;
/** A name that says festival, and not a tour, tribute or concert unless it also says fest. */
export const looksLikeFestival = name => FESTIVAL_WORD.test(name) && !(NOT_A_FESTIVAL.test(name) && !/fest/i.test(name));
