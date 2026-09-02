/**
 * Display-only text transforms. The database keeps raw values; these run at
 * render time so shouting registry imports ("FOX WILLIAM P ETAL") read like
 * names and machine enums ("non_discretionary_overdue") read like language.
 */

/** Known all-caps suffix/entity tokens that stay capitalized. */
const KEEP_CAPS_SUFFIXES = new Set([
  'LLC',
  'LLP',
  'LP',
  'TR',
  'TS',
  'II',
  'III',
  'IV',
  'JR',
  'SR',
]);

const isAllCapsWord = (word: string): boolean =>
  /[A-Z]/.test(word) && word === word.toUpperCase();

const titleCaseWord = (word: string): string =>
  word
    .split('-')
    .map((segment) =>
      segment.length === 0
        ? segment
        : segment[0]!.toUpperCase() + segment.slice(1).toLowerCase(),
    )
    .join('-');

/**
 * Title-cases display names that arrive fully capitalized from imports.
 *
 * Heuristics:
 * - Mixed-case names pass through untouched (someone typed them that way,
 *   including intentional caps like "AKG Holdings").
 * - In a shouting name, all-caps words longer than 3 characters title-case.
 * - Short all-caps tokens (≤3 chars) stay caps only when they are known
 *   suffixes (LLC/LLP/TR/TS/II/III...); other short tokens title-case, which
 *   keeps single initials like "P" readable.
 * - Punctuation such as "&" and digits pass through unchanged.
 */
export const titleCaseDisplayName = (name: string): string => {
  if (name.trim().length === 0) {
    return name;
  }

  const words = name.split(' ');
  const capsWords = words.filter(isAllCapsWord);
  const letterWords = words.filter((word) => /[a-zA-Z]/.test(word));
  // Only rewrite names that are shouting: every lettered word is all-caps.
  if (letterWords.length === 0 || capsWords.length !== letterWords.length) {
    return name;
  }

  return words
    .map((word) => {
      if (!isAllCapsWord(word)) {
        return word;
      }
      if (word.length <= 3) {
        return KEEP_CAPS_SUFFIXES.has(word) ? word : titleCaseWord(word);
      }
      return titleCaseWord(word);
    })
    .join(' ');
};

/**
 * Explicit dictionary for enums whose humanized label is not a mechanical
 * snake_case conversion. Everything else falls back to Sentence case.
 */
const ENUM_LABELS: Readonly<Record<string, string>> = Object.freeze({
  inbound_demo: 'Inbound demo',
  no_answer: 'No answer',
  voicemail: 'Voicemail',
  spoke: 'Spoke',
  interview_booked: 'Interview booked',
  not_interested: 'Not interested',
  opted_out: 'Opted out',
  marked_in_error: 'Marked in error',
  snooze: 'Snoozed',
  callback: 'Callback promised',
  frbo: 'FRBO',
  rireig: 'RIREIG',
  lost_nurture: 'Lost · Nurture',
  unreviewed: 'Unreviewed',
  ready: 'Ready',
  contacted: 'Contacted',
  interviewed: 'Interviewed',
  offered: 'Offered',
  won: 'Won',
});

/**
 * Humanizes a machine enum for display: dictionary first, then a generic
 * snake_case -> Sentence case fallback. Already-human text passes through.
 */
export const humanizeEnumLabel = (value: string): string => {
  if (value.length === 0) {
    return value;
  }
  const known = ENUM_LABELS[value];
  if (known !== undefined) {
    return known;
  }
  if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(value)) {
    return value;
  }
  const sentence = value.replaceAll('_', ' ');
  return sentence[0]!.toUpperCase() + sentence.slice(1);
};
