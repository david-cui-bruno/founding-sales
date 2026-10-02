/**
 * The confirmer (slice 3a, reviews S3A1 and S3A1F): a WHITELIST.
 *
 * An action-critical reading — a stop, a buying signal, a follow-up request or an agreed
 * offer, a callback and its agreement, an exact callback time and day, a promised task — is
 * confirmed only when the speaker's whole line is made, entirely, of a small set of complete,
 * simple forms. Anything else is unknown, and unknown is review. Nothing here tries to work
 * out the polarity or the scope of free text: a line is either built from known pieces, or it
 * is not confirmed.
 *
 * ## How a line is read
 *
 *   1. Normalised: lower case, straight apostrophes, "a.m."/"p.m." as am/pm, "e-mail" as
 *      email, and "between X and Y" kept as one piece.
 *   2. Split into sentences at `.`, `?`, `!` and `;`. A sentence that is, as a whole, one of
 *      the known harmless sentences (`BENIGN`, `BUSY`) is set aside — one with a negation or
 *      contrast in it ("Not right now.") only before anything else was said.
 *   3. Every other sentence is split into clauses at commas, dashes and "and", and **every**
 *      clause must be one of the action's own templates (or another action's request template,
 *      or a harmless sentence). One unknown clause — "but…", "unless…", "actually…", "don't…" —
 *      and the line confirms nothing.
 *
 * The templates are anchored at both ends, and their vocabularies hold no negation,
 * condition or contrast word, so a clause that matches one says what it says and nothing
 * else. `MARKERS` is checked over every non-harmless clause as well, belt and braces.
 */

// ---------------------------------------------------------------------------
// Reading a line
// ---------------------------------------------------------------------------

/** One line as the confirmer reads it: its harmless sentences set aside, its other clauses. */
export interface ReadLine {
  /** The clauses of the line's non-harmless sentences, normalised, in order. */
  readonly clauses: readonly string[];
  /** The whole line, normalised (for a withdrawal or a stop phrase anywhere in it). */
  readonly text: string;
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘`]/gu, "'")
    .replace(/\b([ap])\.\s?m\b\.?/gu, '$1m')
    .replace(/\be-?\s?mail/gu, 'email')
    .replace(/\bbetween (\S+) and (\S+)/gu, 'between $1 to $2')
    .replace(/[“”"()[\]{}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** A clause without its edge punctuation and spacing. */
function tidy(clause: string): string {
  return clause
    .replace(/[^a-z0-9':\- ]+/gu, ' ')
    .replace(/(^|\s)-+(\s|$)/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** Words that open or close a clause without changing it. */
const LEADING_FILLER = /^(?:just|please|so|oh|well|um|uh|hey|ok so|okay so) /u;
const TRAILING_FILLER = / (?:please|then|thanks|thank you)$/u;

function strip(clause: string): string {
  let out = clause;
  for (let i = 0; i < 3; i += 1) {
    const next = out.replace(LEADING_FILLER, '').replace(TRAILING_FILLER, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

/** One-word (or two-word) clauses that carry nothing: "No more calls, please." */
const FILLER_CLAUSES: ReadonlySet<string> = new Set(['please', 'thanks', 'thank you', 'um', 'uh', 'oh', 'so', 'well', 'ok', 'okay', 'yes', 'yeah', 'sure', 'hi', 'hello']);

export function readLine(line: string): ReadLine {
  const text = normalise(line);
  const clauses: string[] = [];
  for (const sentence of text.split(/[.?!;]+/u)) {
    const whole = tidy(sentence);
    if (whole.length === 0) continue;
    // A harmless sentence is set aside; one with a negation or contrast in it ("Not right
    // now.", "Good timing, actually.") only as a preamble, before anything else was said —
    // after a request ("Call me Tuesday. Not really.") it is read, and confirms nothing.
    if (isHarmless(whole) && (clauses.length === 0 || !MARKERS.test(whole))) continue;
    for (const piece of sentence.split(/,|\s+-+\s+|\s+—\s+|\s+and\s+/u)) {
      const clause = strip(tidy(piece));
      if (clause.length > 0 && !FILLER_CLAUSES.has(clause)) clauses.push(clause);
    }
  }
  return { clauses, text: tidy(text) };
}

// ---------------------------------------------------------------------------
// Harmless sentences
// ---------------------------------------------------------------------------

/** Whole sentences that carry no instruction: greetings, acknowledgements, "not now". */
const BENIGN: ReadonlySet<string> = new Set([
  'ok',
  'okay',
  'sure',
  'yes',
  'yeah',
  'yep',
  'hi',
  'hello',
  'hey',
  'thanks',
  'thank you',
  'thanks bye',
  'bye',
  'great',
  'perfect',
  'got it',
  'that works',
  'sounds good',
  'huh',
  'um',
  'uh',
  'oh',
  'it is',
  'not right now',
  'not now',
  'not really',
  'now is not a good time',
  "now's not a good time",
  'good timing',
  'good timing actually',
  "i'll be at my desk then",
  "i'll look at it",
  "i'll take a look",
]);

/** "I'm driving right now", "She's out of the office": the speaker cannot talk now. */
const BUSY =
  /^(?:sorry )?(?:i'm|i am|we're|we are|she's|she is|he's|he is) (?:busy|slammed|swamped|driving|in a meeting|in the middle of something|on another call|on the other line|out|out of the office|at lunch|with a (?:client|tenant|customer)|about to (?:walk|head|go) into (?:a|an) [a-z]+)(?: right now| today| at the moment| this week)?$/u;

function isHarmless(sentence: string): boolean {
  const flat = sentence.replace(/,/gu, ' ').replace(/\s+/gu, ' ').trim();
  return BENIGN.has(flat) || BUSY.test(flat);
}

/** Negation, condition, contrast and correction words. None is in any template. */
const MARKERS =
  /\b(?:not|no|never|nothing|none|nobody|neither|nor|without|refrain|cannot|[a-z]+n't|dont|cant|wont|isnt|arent|doesnt|didnt|wasnt|werent|shouldnt|wouldnt|couldnt|if|unless|provided|providing|assuming|assume|suppose|supposing|whether|depending|depends|maybe|perhaps|might|possibly|probably|only|but|though|although|however|except|instead|rather|actually|otherwise|yet|whereas|anyway|wait|mean|sorry)\b/u;

/** A line with negation, condition or contrast anywhere in it (a commitment's test). */
export function hasMarkers(line: string): boolean {
  return MARKERS.test(tidy(normalise(line)));
}

/** True when every clause matches one of `templates` (and at least one clause does). */
function builtFrom(read: ReadLine, own: readonly RegExp[], companions: readonly RegExp[] = []): boolean {
  let ownCount = 0;
  for (const clause of read.clauses) {
    if (MARKERS.test(clause)) return false;
    if (own.some(template => template.test(clause))) ownCount += 1;
    // A harmless clause with no marker ("I'm driving right now", "I'll look at it").
    else if (!companions.some(template => template.test(clause)) && !isHarmless(clause)) return false;
  }
  return ownCount > 0;
}

// ---------------------------------------------------------------------------
// Plain yes and withdrawal
// ---------------------------------------------------------------------------

const YES = new Set(['yes', 'yeah', 'yep', 'sure', 'ok', 'okay', 'please', 'yes please', 'sure thing', 'sounds good', 'that works', 'go ahead']);

/**
 * The plain-yes rule: the WHOLE reply is one or more of `YES`, optionally followed by
 * "thanks" or "thank you". Nothing else on the line.
 */
export function plainYes(line: string): boolean {
  const pieces = normalise(line)
    .split(/[.?!;,]+/u)
    .map(piece => tidy(piece))
    .filter(piece => piece.length > 0);
  if (pieces.length === 0) return false;
  let yes = 0;
  for (const [index, piece] of pieces.entries()) {
    const thanks = piece === 'thanks' || piece === 'thank you';
    if (thanks && index === pieces.length - 1 && yes > 0) continue;
    const withoutThanks = piece.replace(/ (?:thanks|thank you)$/u, '');
    if (!YES.has(withoutThanks)) return false;
    yes += 1;
  }
  return yes > 0;
}

/**
 * A later Them line that takes something back: a withdrawal, or any contrast or correction
 * marker at all ("Hmm, actually I will look at your website instead"). Over-withdrawal only
 * routes the reading to review.
 */
const WITHDRAWAL =
  /\b(?:never mind|nevermind|forget (?:it|that|about it)|scratch that|on second thought|(?:don't|dont|do not) bother|no need|cancel (?:that|it)|changed my mind|(?:don't|dont|do not) (?:send|email|call)|actually|instead|but|however|though|rather|wait|i mean)\b/u;

/** Whether any of these later lines takes something back. */
export function withdrawn(laterLines: readonly string[]): boolean {
  return laterLines.some(line => WITHDRAWAL.test(tidy(normalise(line))));
}

// ---------------------------------------------------------------------------
// Request templates (what a prospect asks for)
// ---------------------------------------------------------------------------

const NUMBER_WORD = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty)';
const WHEN_WORD = `(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight|later|sometime|soon|next|this|week|month|morning|afternoon|evening|at|on|in|the|a|an|around|about|after|before|by|ish|noon|midday|half|past|quarter|o'clock|am|pm|again|back|between|to|or|few|couple|of|minutes|hour|hours|days|first|thing|${NUMBER_WORD}|\\d{1,2}(?::\\d{2})?(?:am|pm)?|\\d{1,2}-\\d{1,2})`;
const WHEN = `${WHEN_WORD}(?: ${WHEN_WORD})*`;
const ASK = '(?:(?:can|could|would) you |you can |)';

/** Them asks to be called (the call goes to them). */
const CALLBACK_REQUEST: readonly RegExp[] = [
  new RegExp(`^${ASK}(?:call|ring|phone) (?:me|us)(?: back)?(?: ${WHEN})?$`, 'u'),
  new RegExp(`^${ASK}give (?:me|us) a (?:call|ring)(?: back)?(?: ${WHEN})?$`, 'u'),
  new RegExp(`^${ASK}try (?:me|us)(?: again| back)?(?: ${WHEN})?$`, 'u'),
  new RegExp(`^try (?:again |back )?(?:${WHEN})$`, 'u'),
  new RegExp(`^call (?:back )?(?:${WHEN})$`, 'u'),
];

/** David offers to call (agreed only by a plain yes). */
const CALLBACK_OFFER: readonly RegExp[] = [
  new RegExp(`^(?:can|could|may|shall|should) i (?:call|ring|try) you(?: back)?(?: ${WHEN})?$`, 'u'),
  new RegExp(`^(?:i'll|i will|let me) (?:call|try) you(?: back)?(?: ${WHEN})?$`, 'u'),
];

const OBJECT =
  "(?:(?:a|an|the|some|our|your|more) )?(?:(?:short|quick|brief) )?(overview|one pager|one-pager|brochure|deck|info|information|details|pricing|price sheet|link|summary|something)(?: on (?:it|that|this|callie|pricing|you|your product))?";

/** Them asks to be sent something (Them is the recipient). Group 1 is the thing. */
const FOLLOW_UP_REQUEST: readonly RegExp[] = [
  new RegExp(`^${ASK}(?:send|email|forward|shoot) (?:me|us) (?:over )?${OBJECT}(?: over)?(?: by email)?(?: to look at)?$`, 'u'),
  new RegExp(`^${ASK}(?:send|email|forward) ${OBJECT}(?: over)?(?: to (?:me|us))?(?: by email)?$`, 'u'),
  new RegExp(`^${ASK}(?:send|email) (?:me|us) (it|that|something) over$`, 'u'),
  /^email (?:me|us)$/u,
];

/** David offers to send something (agreed only by a plain yes). Group 1 is the thing. */
const FOLLOW_UP_OFFER: readonly RegExp[] = [
  new RegExp(`^(?:can|could|may|shall|should) i (?:send|email|forward) you ${OBJECT}(?: by email)?$`, 'u'),
  new RegExp(`^(?:want me to|would you like me to|do you want me to) (?:send|email) you ${OBJECT}(?: by email)?$`, 'u'),
  new RegExp(`^(?:i can|i could|let me) (?:send|email) you ${OBJECT}(?: by email)?$`, 'u'),
];

/** The frozen qualifying forms (Q3): a demo or trial, their own evaluation, how it would fit them. */
const BUYING: readonly RegExp[] = [
  /^(?:we're|we are|i'm|i am) (?:currently )?(?:evaluating|comparing|looking at) (?:(?:a couple of|a few|some|two|three|four|several|\d+) )?(?:tools|options|vendors|systems|platforms|solutions)(?: for this)?(?: right now| now| at the moment)?$/u,
  /^(?:can|could) (?:you|we|i) (?:show|give) (?:us|me) (?:a )?(?:quick )?(?:demo|walkthrough)$/u,
  /^(?:can|could) (?:we|i) (?:see|get|set up|book|schedule|have) (?:a )?(?:quick )?(?:demo|trial|walkthrough|pilot)$/u,
  /^(?:i'd|i would|we'd|we would) (?:like|love) (?:to )?(?:see|get|set up|book|schedule|try|have) (?:a |the )?(?:quick )?(?:demo|trial|pilot|walkthrough|it)$/u,
  /^put (?:us|me) down for (?:a )?(?:demo|trial|pilot)$/u,
  /^(?:we're|we are) (?:looking at|thinking about|considering) (?:switching|replacing|moving off)(?: (?:our|the) (?:system|portal|software|tool|vendor))?$/u,
  /^how would (?:our|my) (?:techs|technicians|vendors|tenants|team|owners) (?:get|see|use|submit|receive) (?:work orders|requests|jobs|it)$/u,
  /^would it replace (?:our|my) (?:portal|system|software)$/u,
];

/** Every request template: a companion clause that never weakens another request. */
const REQUESTS: readonly RegExp[] = [...CALLBACK_REQUEST, ...FOLLOW_UP_REQUEST, ...BUYING];

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/** The stop forms, whole clauses. `personal` when they name only the speaker or this number. */
const STOP_FORMS: readonly { readonly form: RegExp; readonly personal: boolean }[] = [
  { form: /^stop (?:calling|contacting)(?: (?:me|this number))?$/u, personal: true },
  { form: /^stop (?:calling|contacting) (?:us|here|this office)$/u, personal: false },
  { form: /^(?:don't|do not) (?:call|contact) (?:me|this number)(?: again| anymore)?$/u, personal: true },
  { form: /^(?:don't|do not) (?:call|contact) (?:us|here|anyone here|anybody here|anyone|anybody)(?: again| anymore)?$/u, personal: false },
  { form: /^take (?:me|my number|this number) off (?:your|the) (?:list|call list|calling list)$/u, personal: true },
  { form: /^take (?:us|our number) off (?:your|the) (?:list|call list|calling list)$/u, personal: false },
  { form: /^remove (?:me|my number|this number)(?: from (?:your|the) (?:list|call list|calling list))?$/u, personal: true },
  { form: /^remove (?:us|our number)(?: from (?:your|the) (?:list|call list|calling list))?$/u, personal: false },
  { form: /^(?:put|add) (?:me|this number) (?:on|to) (?:your|the) do not call list$/u, personal: true },
  { form: /^(?:i|we) (?:don't|do not) want (?:these|your|any more|any) calls$/u, personal: false },
  { form: /^no more calls$/u, personal: false },
];

/** Sentences beside a stop that do not change it. */
const STOP_COMPANIONS: readonly RegExp[] = [
  /^(?:we|i) get too many of these$/u,
  /^(?:we're|we are|i'm|i am) not interested$/u,
  /^not interested$/u,
  /^no thanks?$/u,
  /^(?:we|i) (?:don't|do not) want any of this$/u,
];

/** Stop language anywhere in a line (the safety net, which only ever asks for review). */
const STOP_LANGUAGE =
  /\b(?:stop (?:calling|contacting)(?: (?:me|us|here|this number))?|(?:don't|dont|do not|never) (?:call|contact|ring|phone) (?:me|us|here|anyone|anybody|this number|again)|take (?:me|us|my number|our number|this number) off|remove (?:me|us|my number|our number|this number)|(?:don't|dont|do not) want (?:these|your|any|any more) (?:phone )?calls|no more calls|do not call list|lose (?:my|our|this) number)\b/u;

export interface StopPhrase {
  readonly quote: string;
  /** The words do not name only the speaker or this number. */
  readonly general: boolean;
}

/** Stop language in a line, negated or not: the net under the model's reading (review only). */
export function stopLanguageOf(line: string): StopPhrase | null {
  const text = tidy(normalise(line));
  const match = STOP_LANGUAGE.exec(text);
  if (match === null) return null;
  const quote = match[0];
  const personal = /\b(?:me|my|this number)\b/u.test(quote) && !/\b(?:us|our|anyone|anybody|here|these|your|no more)\b/u.test(quote);
  return { quote, general: !personal };
}

/**
 * A model-read stop, judged on its whole Them line: confirmed when the line is built only
 * from stop forms and the sentences that go with a stop, with no e-mail or sending in it.
 * `general` when a confirmed form names more than the speaker or this number.
 */
export function confirmStop(line: string): { readonly confirmed: boolean; readonly general: boolean } {
  const read = readLine(line);
  if (/\b(?:email|send|mail|text)\b/u.test(read.text)) return { confirmed: false, general: false };
  let forms = 0;
  let general = false;
  for (const clause of read.clauses) {
    const stop = STOP_FORMS.find(entry => entry.form.test(clause));
    if (stop !== undefined) {
      forms += 1;
      if (!stop.personal) general = true;
      continue;
    }
    if (!STOP_COMPANIONS.some(companion => companion.test(clause))) return { confirmed: false, general: false };
  }
  return { confirmed: forms > 0, general };
}

// ---------------------------------------------------------------------------
// Buying signal
// ---------------------------------------------------------------------------

const PRICE = /\b(?:cost|costs|price|priced|pricing|how much|charge|fee|fees|per month|per door|rate|rates|expensive|cheap)\b/u;
const ADDRESSES_THE_ANALYSIS = /\b(?:buying signal|instructions|ignore)\b/u;

/**
 * A qualifying signal, judged on its whole Them line: `confirmed` when the line is built
 * from the frozen qualifying forms (and other request forms or harmless sentences);
 * `price_only` when it asks about price and is not; otherwise `unconfirmed` (review only).
 */
export function confirmBuyingSignal(line: string): 'confirmed' | 'price_only' | 'unconfirmed' {
  const read = readLine(line);
  if (!ADDRESSES_THE_ANALYSIS.test(read.text) && builtFrom(read, BUYING, REQUESTS)) return 'confirmed';
  return PRICE.test(read.text) && !read.clauses.some(clause => BUYING.some(template => template.test(clause))) ? 'price_only' : 'unconfirmed';
}

// ---------------------------------------------------------------------------
// Follow-up
// ---------------------------------------------------------------------------

export type FollowUpVerdict =
  | { readonly kind: 'confirmed'; readonly overview: boolean }
  | { readonly kind: 'unconfirmed' }
  | { readonly kind: 'none' };

const SENDING = /\b(?:send|sending|email|mail|forward|shoot)\b/u;

function thingOf(read: ReadLine, templates: readonly RegExp[]): string | null {
  for (const clause of read.clauses) {
    for (const template of templates) {
      const match = template.exec(clause);
      if (match !== null) return match[1] ?? 'something';
    }
  }
  return null;
}

/**
 * Them's request, on its whole line: confirmed when the line is built from request forms
 * (Them the recipient) and harmless sentences and nothing later takes it back; `none` when
 * the line names no sending at all; otherwise unconfirmed (review only). `overview` comes
 * from the words, never from the model's kind.
 */
export function confirmFollowUpRequest(line: string, laterThemLines: readonly string[]): FollowUpVerdict {
  const read = readLine(line);
  if (!SENDING.test(read.text)) return { kind: 'none' };
  if (!builtFrom(read, FOLLOW_UP_REQUEST, REQUESTS) || withdrawn(laterThemLines)) return { kind: 'unconfirmed' };
  return { kind: 'confirmed', overview: thingOf(read, FOLLOW_UP_REQUEST) === 'overview' };
}

/**
 * David's offer to send, answered by a Them line: confirmed only when one clause of the
 * offer is an offer form, the answer is a plain yes, and no later Them line takes it back.
 */
export function confirmFollowUpOffer(offer: string, answer: string, laterThemLines: readonly string[]): FollowUpVerdict {
  const read = readLine(offer);
  const thing = thingOf(read, FOLLOW_UP_OFFER);
  if (thing === null) return SENDING.test(read.text) ? { kind: 'unconfirmed' } : { kind: 'none' };
  if (!plainYes(answer) || withdrawn(laterThemLines)) return { kind: 'unconfirmed' };
  return { kind: 'confirmed', overview: thing === 'overview' };
}

// ---------------------------------------------------------------------------
// Callback: the request, its exact time and its day
// ---------------------------------------------------------------------------

export interface CallbackCheck {
  /** Them asked to be called (or agreed plainly to David's offer), and did not take it back. */
  readonly confirmed: boolean;
  /** The clauses the time and the day are read from: the request, or the offer and its yes. */
  readonly clauses: readonly string[];
}

/** A callback Them asked for, on its whole line, with the Them lines after it. */
export function confirmCallbackRequest(line: string, laterThemLines: readonly string[]): CallbackCheck {
  const read = readLine(line);
  const confirmed = builtFrom(read, CALLBACK_REQUEST, REQUESTS) && !withdrawn(laterThemLines);
  return { confirmed, clauses: read.clauses };
}

/** A callback David offered, agreed by Them's reply, with the Them lines after the reply. */
export function confirmCallbackOffer(offer: string, answer: string, laterThemLines: readonly string[]): CallbackCheck {
  const read = readLine(offer);
  const clauses = read.clauses.filter(clause => CALLBACK_OFFER.some(template => template.test(clause)));
  const confirmed = clauses.length > 0 && plainYes(answer) && !withdrawn(laterThemLines);
  return { confirmed, clauses };
}

const TIME_TOKEN = /\b(\d{1,2})(?::(\d{2}))?(?: ?(am|pm))?\b/gu;
const HALF_PAST = /\bhalf past (\d{1,2})\b/gu;
const NOT_EXACT =
  /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|half|quarter|ish|about|around|after|before|by|until|till|or|to|between|morning|afternoon|evening|night|tonight|o'clock|actually|wait|instead|mean|sorry)\b|-/u;

function clock(hour: number, minute: number, meridiem: string | undefined): string | null {
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  let h = hour;
  if (h > 12) {
    if (meridiem !== undefined) return null;
  } else if (meridiem === 'am') {
    if (h === 12) h = 0;
  } else if (meridiem === 'pm') {
    if (h !== 12) h += 12;
  } else if (h >= 1 && h <= 6) h += 12;
  else if (h === 0) return null;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * The exact time a callback's clauses say, as `HH:MM`, or null. Exact only when they hold
 * exactly one time token — `h`, `h:mm`, `h am|pm`, `noon`, `half past h` — and no other digit,
 * number word, approximation, alternative, modifier or correction. A bare hour 1-6 is PM,
 * 7-11 AM, 12 noon.
 */
export function exactTimeOf(clauses: readonly string[]): string | null {
  const text = clauses.join(' | ');
  const halves = [...text.matchAll(HALF_PAST)];
  const rest = text.replace(HALF_PAST, ' ');
  const noon = [...rest.matchAll(/\b(?:noon|midday)\b/gu)];
  const tokens = [...rest.matchAll(TIME_TOKEN)];
  if (halves.length + noon.length + tokens.length !== 1) return null;
  const residue = rest.replace(/\b(?:noon|midday)\b/gu, ' ').replace(TIME_TOKEN, ' ');
  if (NOT_EXACT.test(residue) || /\d/u.test(residue)) return null;
  if (noon.length === 1) return '12:00';
  const half = halves[0];
  if (half !== undefined) return clock(Number(half[1]), 30, undefined);
  const token = tokens[0];
  if (token === undefined) return null;
  return clock(Number(token[1]), token[2] === undefined ? 0 : Number(token[2]), token[3]);
}

const DAY_WORD = /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tomorrow|tonight)\b/gu;
const DAY_QUALIFIER = /\b(?:next|this|after|following|week|weeks|in|not|coming|from|other|every|last)\b/u;

/**
 * Whether the callback's clauses name exactly one day — a bare weekday, today or tomorrow,
 * the one the model chose — with no qualifier word anywhere in them: `null` when they do;
 * `next` for "next <weekday>"; `ambiguous` for anything else.
 */
export function dayQualifierOf(day: string | null, clauses: readonly string[]): 'next' | 'ambiguous' | null {
  if (day === null) return null;
  const text = clauses.join(' | ');
  if (/\bnext (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/u.test(text)) return 'next';
  const days = [...text.matchAll(DAY_WORD)].map(match => match[0]);
  if (days.length === 0 || new Set(days).size !== 1 || days[0] !== day) return 'ambiguous';
  if (DAY_QUALIFIER.test(text)) return 'ambiguous';
  return null;
}

/** A spoken clock time as `HH:MM`, or null (the same rules as `exactTimeOf`, one token). */
export function parseSpokenTime(words: string): string | null {
  return exactTimeOf([tidy(normalise(words))]);
}
