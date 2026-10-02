/**
 * The confirmer (slice 3a, review S3A1): CONFIRM OR REVIEW.
 *
 * An action-critical reading — a stop, a buying signal, a follow-up request or an agreed
 * offer, a callback's agreement, an exact callback time and day — is applied on David's click
 * only when a conservative deterministic check over the **full** speaker line(s), never the
 * model's quote span, confirms it independently. Anything that does not confirm becomes a
 * review item (or, where the words say the opposite, nothing at all). The model's category,
 * quote and agreement pointer say *where* to look; this module decides what the line says.
 *
 * One function per action kind, used by the reader (`readCallAnalysisAnswer`), whose result
 * records each verdict, and through it by the policy. Every rule here is conservative: when
 * a line is unclear it does not confirm.
 *
 * The text is compared lower-cased with typographic apostrophes straightened; punctuation is
 * kept, because a clause ends at it and a negation reaches only to the end of its clause.
 */

/** Lower case, straight apostrophes, single spaces; punctuation kept. */
export function norm(text: string): string {
  return text.toLowerCase().replace(/[’‘]/gu, "'").replace(/\s+/gu, ' ').trim();
}

/** The words of the clause before `index`: back to the last `.`, `,`, `;`, `!`, `?` or dash. */
function clausePrefix(text: string, index: number): string {
  const before = text.slice(0, index);
  const boundary = Math.max(...['.', ',', ';', '!', '?', ' - ', ' — '].map(mark => before.lastIndexOf(mark)));
  return before.slice(boundary + 1);
}

const NEGATION = /\b(?:not|never|don't|dont|do not|doesn't|didn't|isn't|wasn't|no need to|won't)\b/u;
const SELF_SUBJECT = /\b(?:i'll|i will|i shall|i can|i'm going to|i am going to|we'll|we will|we can|we're going to|we are going to|let me)\b/u;

function negatedAt(text: string, index: number): boolean {
  return NEGATION.test(clausePrefix(text, index));
}

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

/** Stop phrases, without their own negation guard: the clause decides (`negatedAt`). */
const STOP_PATTERNS: readonly RegExp[] = [
  /\b(?:stop|quit) (?:calling|phoning|ringing|contacting)(?: (?:me|us|here|this number|my \w+|our \w+))?\b/gu,
  /\b(?:don't|dont|do not|never) (?:call|phone|ring|contact) (?:me|us|here|anyone|anybody|this number|again|anymore|my \w+|our \w+)\b/gu,
  /\btake (?:me|us|my \w+|our \w+|this number) off\b/gu,
  /\bremove (?:me|us|my \w+|our \w+|this number)\b/gu,
  /\b(?:don't|dont|do not) want (?:these|your|any|any more|anymore|more) (?:phone )?calls\b/gu,
  /\bno more calls\b/gu,
  /\bdo[- ]not[- ]call list\b/gu,
  /\blose (?:my|our|this) number\b/gu,
];

export interface StopPhrase {
  readonly quote: string;
  /** The words do not name only the speaker or this number. */
  readonly general: boolean;
}

export interface StopCheck {
  /** Un-negated stop phrases in the line. */
  readonly phrases: readonly StopPhrase[];
  /** Stop phrases the line negates ("don't take me off anything"). */
  readonly negated: number;
}

/** The stop phrases of one full Them line, and how many of them it negates. */
export function checkStop(line: string): StopCheck {
  const text = norm(line);
  const phrases: StopPhrase[] = [];
  let negated = 0;
  for (const pattern of STOP_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      if (negatedAt(text, match.index)) {
        negated += 1;
        continue;
      }
      const quote = match[0];
      const personal = /\b(?:me|my|this number)\b/u.test(quote) && !/\b(?:us|our|anyone|anybody|here|these|your|no more)\b/u.test(quote);
      phrases.push({ quote, general: !personal });
    }
  }
  return { phrases, negated };
}

/**
 * A model-read stop, judged on its whole Them line: `confirmed` when the line has an
 * un-negated stop phrase and no negated one; `negated` when it only negates one ("don't take
 * me off anything": no stop at all); `ambiguous` when it has both; `unconfirmed` when it has
 * neither. Only `confirmed` may be applied.
 */
export function confirmStop(line: string): 'confirmed' | 'negated' | 'ambiguous' | 'unconfirmed' {
  const check = checkStop(line);
  if (check.phrases.length > 0) return check.negated > 0 ? 'ambiguous' : 'confirmed';
  return check.negated > 0 ? 'negated' : 'unconfirmed';
}

// ---------------------------------------------------------------------------
// Buying signal
// ---------------------------------------------------------------------------

/**
 * The frozen qualifying patterns: a demo or trial, their own evaluation or switching, how it
 * would work in their own operation, their own units or volume. A price question is none of
 * these (Q3, David, 2 October 2026), and neither is a line that addresses the analysis itself.
 */
const QUALIFYING: readonly RegExp[] = [
  /\b(?:demo|demonstration|walkthrough|walk-through|trial|pilot|test drive)\b/gu,
  /\b(?:evaluat\w*|compar\w*|shopping around)\b/gu,
  /\blooking at (?:options|tools|vendors|software|systems|a few|a couple)\b/gu,
  /\b(?:switch\w*|replac\w*|migrat\w*|moving off|move off)\b/gu,
  /\bhow (?:would|does|do|could|will) (?:it|this|that|our|my|we|they)\b[^.?!]*\b(?:techs?|technicians?|tenants?|vendors?|work orders?|units?|doors?|properties|portal|team|owners?|maintenance|requests?)\b/gu,
  /\b(?:our|my) (?:techs|technicians|tenants|vendors|units|doors|properties|portal|team|owners|work orders)\b/gu,
  /\b(?:\d+|hundred|thousand|dozen) (?:units|doors|properties|buildings)\b/gu,
];

const ADDRESSES_THE_ANALYSIS = /\b(?:buying signal|your instructions|ignore (?:your|all|the|previous))\b/u;

const PRICE = /\b(?:cost|costs|price|priced|pricing|how much|charge|fee|fees|per month|per door|rate|rates|expensive|cheap)\b/u;

/**
 * A qualifying signal, judged on its whole Them line: `confirmed` when an un-negated frozen
 * qualifying pattern is in it; `price_only` when it asks about price and nothing qualifies
 * (Q3: no buying signal at all); otherwise `unconfirmed` (review only).
 */
export function confirmBuyingSignal(line: string): 'confirmed' | 'price_only' | 'unconfirmed' {
  const text = norm(line);
  if (!ADDRESSES_THE_ANALYSIS.test(text)) {
    for (const pattern of QUALIFYING) {
      for (const match of text.matchAll(pattern)) {
        if (!negatedAt(text, match.index)) return 'confirmed';
      }
    }
  }
  return PRICE.test(text) ? 'price_only' : 'unconfirmed';
}

// ---------------------------------------------------------------------------
// Agreement, retraction, follow-up
// ---------------------------------------------------------------------------

/** A plain yes at the start of the line. */
const AGREES = /^(?:yes|yeah|yep|sure|ok|okay|please|absolutely|definitely|of course|go ahead|sounds good|that works|that would be great|that'd be great|that'd help|please do)\b/u;
/** A reply that declines or hedges is not agreement, whatever it starts with. */
const HEDGES = /\b(?:no|not|don't|dont|maybe|we'll see|not sure|i'll think|think about it|later|but|unless|if)\b/u;

/** The plain-yes rule: a whole line that starts with a yes and neither hedges nor declines. */
export function plainYes(line: string): boolean {
  const text = norm(line).replace(/^[^a-z0-9']+/u, '');
  return AGREES.test(text) && !HEDGES.test(text);
}

const RETRACTS = /\b(?:(?:don't|dont|do not|no need to) (?:send|e-?mail|mail|bother)|never mind|nevermind|scratch that|forget (?:it|that|about it)|on second thought)\b/u;

/** Whether any of these texts takes a request back. */
export function retracted(texts: readonly string[]): boolean {
  return texts.some(text => RETRACTS.test(norm(text)));
}

const SEND = /\b(?:send|sending|e-?mail|email|mail|forward|shoot)\b/gu;
const REQUEST: readonly RegExp[] = [
  /\b(?:send|e-?mail|email|mail|forward|shoot)(?: (?:it|that|this|something|one|over|along))? (?:me|us)\b/gu,
  /\b(?:send|e-?mail|email|forward) (?:an?|the|some|your|over) \w+/gu,
  /\b(?:send|e-?mail|email|forward|shoot) (?:it|that|this|something|them|those|info|information|details)(?: over| along)?\b/gu,
];

export type FollowUpVerdict = 'confirmed' | 'refused' | 'unconfirmed';

/**
 * A request Them made, on one full Them line, with the Them lines after it.
 *
 * Confirmed: an un-negated request to be sent something whose clause is not the speaker's own
 * offer, not taken back later in the line or the call. Refused: every sending word in the
 * line is negated or the speaker's own offer, or the request is taken back. Otherwise
 * unconfirmed. A line that names no sending at all is not a request to be sent anything:
 * refused.
 */
export function confirmFollowUpRequest(line: string, laterThemLines: readonly string[]): FollowUpVerdict {
  const text = norm(line);
  if (!new RegExp(SEND.source, 'u').test(text)) return 'refused';
  let requestAt = -1;
  for (const pattern of REQUEST) {
    for (const match of text.matchAll(pattern)) {
      const prefix = clausePrefix(text, match.index);
      if (NEGATION.test(prefix) || SELF_SUBJECT.test(prefix)) continue;
      requestAt = requestAt === -1 ? match.index : Math.min(requestAt, match.index);
    }
  }
  if (requestAt !== -1) {
    return retracted([text.slice(requestAt), ...laterThemLines]) ? 'refused' : 'confirmed';
  }
  const sends = [...text.matchAll(SEND)];
  if (sends.length > 0 && sends.every(match => negatedAt(text, match.index) || SELF_SUBJECT.test(clausePrefix(text, match.index)))) {
    return 'refused';
  }
  return retracted([text, ...laterThemLines]) ? 'refused' : 'unconfirmed';
}

/**
 * David's offer to send, answered by a Them line. Confirmed only when the offer names the
 * sending, the answer passes the plain-yes rule, and nothing from the answer on takes it back.
 */
export function confirmFollowUpOffer(offer: string, answer: string, laterThemLines: readonly string[]): FollowUpVerdict {
  const text = norm(offer);
  const names = [...text.matchAll(SEND)].some(match => !negatedAt(text, match.index));
  if (!names || !plainYes(answer) || retracted([answer, ...laterThemLines])) return 'refused';
  return 'confirmed';
}

// ---------------------------------------------------------------------------
// Exact time and day
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Readonly<Record<string, number>> = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
});
const NUM = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const MERIDIEM = "(?:\\s*(?:a\\.?m\\.?|p\\.?m\\.?)(?![a-z]))";
const MINUTES_WORD = "(?:thirty|fifteen|forty[- ]five|o'clock)";

/** One time expression, longest forms first; matched left to right without overlap. */
const TIME_EXPRESSION = new RegExp(
  [
    `\\b(?:at )?\\d{1,2}:\\d{2}${MERIDIEM}?`,
    `\\b(?:at )?\\d{1,2}${MERIDIEM}`,
    '\\b(?:at )?(?:noon|midday)\\b',
    `\\b(?:half|quarter) past (?:\\d{1,2}|${NUM})\\b`,
    `\\bat (?:\\d{1,2}|${NUM})(?: ${MINUTES_WORD})?(?![:\\d])\\b${MERIDIEM}?`,
    `\\b${NUM} ${MINUTES_WORD}\\b${MERIDIEM}?`,
  ].join('|'),
  'gu',
);
/** A time followed by another: a range or an alternative. */
const RANGE_AFTER = new RegExp(`^\\s*(?:-|–|to|or|and|through|till|until)\\s*(?:\\d|${NUM}|noon|midday)`, 'u');

/**
 * A spoken clock time as `HH:MM`, or null. An explicit am/pm wins; otherwise a bare hour
 * 1-6 is afternoon, 7-11 morning, 12 noon (the hours a sales callback is placed at).
 */
export function parseSpokenTime(words: string): string | null {
  let text = norm(words)
    .replace(/[.,!?]/gu, ' ')
    .replace(/(\d)([a-z])/gu, '$1 $2')
    .replace(/\bat\b/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (text === 'noon' || text === 'midday') return '12:00';
  let meridiem: 'am' | 'pm' | null = null;
  const marker = /\b(a ?m|p ?m|in the morning|in the afternoon|in the evening)\b/u.exec(text.replace(/\./gu, ''));
  if (marker !== null) {
    meridiem = marker[1]?.startsWith('a') === true || marker[1] === 'in the morning' ? 'am' : 'pm';
    text = text.replace(/\./gu, '').replace(marker[0], ' ').replace(/\s+/gu, ' ').trim();
  }
  let hour: number | null = null;
  let minute = 0;
  const digits = /^(\d{1,2})(?:[: ](\d{2}))?$/u.exec(text);
  if (digits !== null) {
    hour = Number(digits[1]);
    if (digits[2] !== undefined) minute = Number(digits[2]);
  } else {
    const past = /^(half|quarter) past (\w+)$/u.exec(text);
    if (past !== null) {
      const base = past[2] ?? '';
      hour = NUMBER_WORDS[base] ?? (/^\d{1,2}$/u.test(base) ? Number(base) : null);
      minute = past[1] === 'half' ? 30 : 15;
    } else {
      const [first, ...rest] = text.split(' ');
      hour = NUMBER_WORDS[first ?? ''] ?? (first !== undefined && /^\d{1,2}$/u.test(first) ? Number(first) : null);
      const tail = rest.join(' ').replace('-', ' ');
      if (tail.length > 0) {
        const words: Readonly<Record<string, number>> = { "o'clock": 0, oclock: 0, fifteen: 15, thirty: 30, 'forty five': 45 };
        const m = words[tail] ?? (/^\d{2}$/u.test(tail) ? Number(tail) : undefined);
        if (m === undefined) return null;
        minute = m;
      }
    }
  }
  if (hour === null || !Number.isInteger(hour) || minute < 0 || minute > 59 || hour > 23) return null;
  if (hour > 12) {
    if (meridiem === 'am') return null;
  } else if (meridiem === 'am') {
    if (hour === 12) hour = 0;
  } else if (meridiem === 'pm') {
    if (hour !== 12) hour += 12;
  } else if (hour >= 1 && hour <= 6) hour += 12;
  else if (hour === 0) return null;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

/**
 * The exact time the callback's lines name, as `HH:MM`, or null. Exact only when the lines
 * hold **one** complete time expression (h, h:mm, h am/pm, noon …), with no range or
 * alternative ("between", "2 to 4", "2 or 3"), and the model said a time.
 */
export function confirmedCallbackTime(lines: readonly string[], modelTime: string | null): string | null {
  if (modelTime === null) return null;
  const expressions: string[] = [];
  for (const line of lines) {
    const text = norm(line);
    if (/\bbetween\b/u.test(text)) return null;
    for (const match of text.matchAll(TIME_EXPRESSION)) {
      if (RANGE_AFTER.test(text.slice(match.index + match[0].length))) return null;
      expressions.push(match[0]);
    }
  }
  if (expressions.length !== 1) return null;
  // The line's own expression, minutes kept: the model's words only say a time was meant
  // ("9" quoted out of "9:30" resolves to 09:30, never 09:00).
  return parseSpokenTime(expressions[0] ?? '');
}

const WEEKDAY = '(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)';
const DAY_EXPRESSION = new RegExp(`\\b(?:${WEEKDAY}|today|tomorrow|tonight)\\b`, 'gu');
const CORRECTION = /\b(?:no wait|wait no|actually|sorry|i mean|make that|or rather|scratch that|instead)\b/u;

export type DayQualifier = 'next' | 'next_week' | 'this' | 'ambiguous';

/**
 * How the callback's day is qualified in its own lines, read whole. `ambiguous` applies to
 * any day ("tomorrow, no wait, Thursday"); the others to a weekday only.
 *
 *   * `next` — any "next <weekday>" in the lines: which week is ambiguous.
 *   * `ambiguous` — a negation or a correction within three words of a day ("not next week
 *     Tuesday", "Tuesday, no wait, Wednesday"), more than one day said, or "next week" not
 *     beside the weekday.
 *   * `next_week` — "next week <weekday>" / "<weekday> next week", the only day said.
 *   * `this` — "this" or "coming" before the weekday.
 *   * null — a bare weekday.
 */
export function dayQualifierOf(day: string | null, lines: readonly string[]): DayQualifier | null {
  if (day === null) return null;
  const weekday = new RegExp(`^${WEEKDAY}$`, 'u').test(day);
  const text = lines.map(norm).join(' \u0000 ');
  if (weekday && new RegExp(`\\bnext ${WEEKDAY}\\b`, 'u').test(text)) return 'next';
  const days = new Set([...text.matchAll(DAY_EXPRESSION)].map(match => match[0])).size;
  // Up to three words apart within one sentence (a comma does not end it; a full stop does).
  const gap = "[^\\w'.!?\\u0000]+";
  const near = `(?:${gap}[\\w']+){0,3}?${gap}(?:${WEEKDAY}|today|tomorrow|tonight|next week)\\b`;
  if (new RegExp(`\\b(?:not|no|don't|dont|never|isn't|can't|cannot|won't)\\b${near}`, 'u').test(text)) return 'ambiguous';
  if (new RegExp(`${CORRECTION.source}${near}`, 'u').test(text)) return 'ambiguous';
  if (new RegExp(`\\b(?:${WEEKDAY}|today|tomorrow|tonight)\\b(?:${gap}[\\w']+){0,3}?${gap}${CORRECTION.source}`, 'u').test(text)) return 'ambiguous';
  if (days > 1) return 'ambiguous';
  if (!weekday) return null;
  if (/\bnext week\b/u.test(text)) {
    const adjacent = new RegExp(`\\bnext week(?: on)? ${day}\\b|\\b${day}(?: of)? next week\\b`, 'u').test(text);
    return adjacent ? 'next_week' : 'ambiguous';
  }
  if (new RegExp(`\\b(?:this|this coming|coming) ${day}\\b`, 'u').test(text)) return 'this';
  return null;
}
