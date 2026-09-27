// Turns raw scanner traffic into something worth interrupting an attendee for.
// Everything here is deliberately conservative: a missed incident is a lost
// alert, a false one is a crowd of people running for no reason.

/** Incidents older than this are not served to phones. */
export const INCIDENT_WINDOW_MS = 48 * 3600_000;

const CATEGORIES = [
  ['threat',     /\b(shots? fired|gun|firearm|weapon|knife|stabb\w*|active shooter|armed)\b/i,                          'warning'],
  ['evacuation', /\b(evacuat\w*|shelter in place|clear the (area|field|stage)|shut ?down the stage|stop the show)\b/i,   'warning'],
  ['weather',    /\b(lightning|tornado|severe (storm|weather)|high winds?|wind hold|weather hold|hail)\b/i,           'warning'],
  ['flood',      /\b(flood\w*|under ?water|washed out|standing water|the tunnel is)\b/i,                                 'advisory'],
  ['fire',       /\b(fire|smoke|burning|propane)\b/i,                                                                'advisory'],
  ['missing',    /\b(missing (child|kid|person|juvenile)|lost (child|kid)|amber)\b/i,                                 'advisory'],
  ['medical',    /\b(unresponsive|not breathing|overdose|narcan|seizure|cardiac|mass casualty|multiple patients)\b/i, 'advisory'],
  ['crowd',      /\b(crowd (crush|surge|collapse)|barricade (down|breach)|stampede|crush)\b/i,                        'warning'],
  ['traffic',    /\b(road (closed|closure)|route \d+ (closed|blocked)|gate (closed|closure)|gridlock)\b/i,            'advisory'],
];

export function classify(text) {
  const t = String(text || '');
  for (const [category, re, level] of CATEGORIES) if (re.test(t)) return { category, level };
  return null;
}

/** Scanner traffic only becomes an incident if it matches a safety category. */
export function isSafetyRelevant(text) { return classify(text) !== null; }

/** Strip the things that make a clip about a person instead of a hazard. */
export function redact(text) {
  return String(text || '')
    .replace(/\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, '[number]')       // phone numbers
    .replace(/\b[A-Z]{1,3}[- ]?\d{3,4}[- ]?[A-Z]{0,3}\b/g, '[plate]')  // plate-shaped tokens
    .replace(/\b(?:dob|date of birth)\b.{0,20}/gi, '[dob]')
    .replace(/\b(?:name is|last name|first name)\b.{0,30}/gi, '[name]')
    .trim();
}

/** Short, plain-language line for the card. First sentence, capped. */
export function summarize(text) {
  const clean = redact(text).replace(/\s+/g, ' ');
  const first = clean.split(/(?<=[.!?])\s/)[0] || clean;
  return first.length > 160 ? first.slice(0, 157) + '...' : first;
}

/** Optional server-side transcription when the node couldn't do it. */
export async function transcribe(buffer, filename) {
  if (!process.env.OPENAI_API_KEY) return null;
  const form = new FormData();
  form.append('file', new Blob([buffer]), filename);
  form.append('model', 'whisper-1');
  form.append('prompt', 'Two-way radio dispatch traffic at a music festival. Unit numbers, stage names, medical, security.');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription ${res.status}`);
  return (await res.json()).text;
}
