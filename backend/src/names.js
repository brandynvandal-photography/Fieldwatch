// Festival names as ticket sites print them, reduced to the festival: "Rock The South - Thursday - with Zach Top
// (Rescheduled from 06/11/26)" is Rock The South. Shared by the importers (grouping, display) and the validator
// (is this the same festival another source listed).

const DAYS = String.raw`(?:mon|tue|tues|wed|wednes|thu|thur|thurs|fri|sat|satur|sun)(?:day)?`;
const PASS = String.raw`(?:(?:vip|ga|general admission|premium|platinum|deluxe|super|weekend|day|night|\d+[- ]?day|(?:one|two|three|four|single|multi)[- ]day)\s+)*pass(?:es)?`;
// A segment (after " - ", ": " or " | ") that names a day, a pass, a lineup or a status rather than the festival.
const TAIL = new RegExp(String.raw`^(?:${DAYS}\b|\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b|(?:\d+|one|two|three|four|five|single|multi)[- ]?(?:day|night)s?\b|(?:day|night|weekend)\s*(?:\d|one|two|three|four|five)\b|${PASS}\b|w(?:ith|\/)\b|feat(?:uring|\.)?\b|ft\.?\s|starring\b|presented by\b|sponsored by\b|cancell?ed\b|postponed\b|rescheduled\b|sold out\b|\d\d\+|all ages\b|ages?\s+\d|after ?party\b|kick-?off\b|pre-?party\b|late night\b|official\b|tickets?\b|single day\b|admission\b)`, 'i');
const LINEUP = /\s+(?:with|w\/|feat\.?|featuring|ft\.?)\s+.+$/i;
const TRAIL_DATE = new RegExp(String.raw`\s+(?:${DAYS}\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$`, 'i');
const TRAIL_DAYS = new RegExp(String.raw`\s+(?:\d+\s*days?|${PASS}|${DAYS}|20\d\d|(?:day|night)\s+(?:one|two|three|four|five|\d))$`, 'i');
const LEAD_DAYS = /^(?:\d+|one|two|three|four)[- ]day\s+/i;
const BY_LINE = /\s+(?:presented|sponsored|powered|brought to you) by\s+.*$/i;

/** The festival in a listing's name: no parenthetical, no day, pass, lineup or status, no trailing year. */
export function cleanName(raw) {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  s = s.replace(/\s*\([^)]*\)/g, '').replace(/\s*\[[^\]]*\]/g, '');
  s = s.replace(LEAD_DAYS, '').replace(/^20\d\d\s+/, '').replace(/\s+20\d\d\b/g, '');
  // "Voltaege Fest, Kept on Hold, WIPEOUT, Follow The Protocol": a fest before the first comma and a bill after it.
  const comma = s.indexOf(',');
  if (comma > 0 && /fest/i.test(s.slice(0, comma)) && (s.slice(comma + 1).match(/,/g) || []).length >= 2) s = s.slice(0, comma);
  const parts = s.split(/(\s+[-–—|]\s+|\s+[-–—]\s*|:\s+)/);
  let out = parts[0];
  for (let i = 1; i < parts.length; i += 2) { const seg = parts[i + 1] || ''; if (TAIL.test(seg)) break; out += parts[i] + seg; }
  s = out.replace(LINEUP, '').replace(BY_LINE, '');
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
const alike = (a, b) => a === b || a.startsWith(`${b} `) || b.startsWith(`${a} `) || a.endsWith(` ${b}`) || b.endsWith(` ${a}`);
const SMALL = new Set(['a', 'an', 'the', 'of', 'and']);
const initials = words => words.map(w => w[0]).join('');
/**
 * What a word of one name stands for in the other, or the word itself: "acl" is Austin City Limits (the initials of
 * the core), "lib" Lightning in a Bottle (the initials once only the small words are gone), "lolla" Lollapalooza (the
 * front of its first word, four letters or more). Ticket sites sell a festival's side shows under the short name.
 */
function standsFor(word, core, full) {
  const words = core.split(' ');
  if (/^[a-z]{3,}$/.test(word) && words.length >= 2 && (word === initials(words) || word === initials(full.split(' ').filter(w => !SMALL.has(w))))) return core;
  if (word.length >= 4 && words[0].length > word.length && words[0].startsWith(word)) return words[0];
  return word;
}
/** One core is the other, or the other with a word or two on the end, or says the other by its nickname: the same festival named twice. */
export function sameCore(x, y) {
  const a = coreName(x), b = coreName(y);
  if (!a || !b) return false;
  if (alike(a, b)) return true;
  const fullA = normalizeName(x), fullB = normalizeName(y);
  return alike(a.split(' ').map(w => standsFor(w, b, fullB)).join(' '), b) || alike(a, b.split(' ').map(w => standsFor(w, a, fullA)).join(' '));
}

// A listing is a festival, or something sold beside one, or plainly not one.
export const FESTIVAL_WORD = /\b(fest|festival|festivals|fete|jam|jamboree|jubilee|gathering|revival|revue|roundup|round-up|carnival|fair|palooza|weekender|weekend|campout|camp-out|block party|hoedown|smokeout|smoke-out|fiesta|oktoberfest|brewfest|beerfest|bluesfest|jazzfest|rise up|picnic|rendezvous|powwow|pow-wow|days)\b|fest\b|palooza\b|fest$/i;
export const NOT_A_FESTIVAL = /\b(tour|tribute|concert|symphony|philharmonic|orchestra|comedy|awards?|gala|screening|conference|convention|expo|seminar|worship night)\b/i;
export const CANCELED = /\b(cancell?ed|postponed)\b/i;
// Sold beside a festival rather than the festival: a pass for the lot or the campground, a kick-off or an afterparty,
// and the late-night shows and aftershows a festival puts on in clubs across town under its own name.
export const ADD_ON = /\b(parking|shuttle|camping|campsite|campground|locker|merch|payment plan|layaway|upgrade|add[- ]?on|glamping|rv pass|car pass|bus pass|car registration|registration|kick-?off|after ?party|pre-?party|fest nights?|late[- ]?night|after[- ]?shows?|meet (and|&) greet|package)\b/i;
/** A name that says festival, and not a tour, tribute or concert unless it also says fest. */
export const looksLikeFestival = name => FESTIVAL_WORD.test(name) && !plainlyNotFestival(name);
// What no festival word redeems: a traveling show, a benefit concert, an orchestra, an awards night, or a
// promoter presenting an act ("Hawaii's Finest Presents High Watah") with no festival named.
const NEVER_A_FESTIVAL = /\b(tour|benefit concert|concerto|symphony|philharmonic|orchestra|awards?)\b/i;
export const plainlyNotFestival = name => NEVER_A_FESTIVAL.test(name) || (!/fest/i.test(name) && (NOT_A_FESTIVAL.test(name) || /\bpresents?\b/i.test(name)));
