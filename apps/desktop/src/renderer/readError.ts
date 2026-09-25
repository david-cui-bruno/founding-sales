/**
 * The sentence a window says after "Callie could not read …" (lanes g69 and g78).
 *
 * One mapping for every window that shows a failed read as a grey line with Retry —
 * Administration's sending section since g69, the sequence editor's slices since g78 —
 * so a code reads the same wherever it appears. The codes a person can act on get a
 * sentence; any other code is named as it is, so the line is something an operator can
 * search the logs for.
 */
const READ_ERROR_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'The server did not answer',
  not_signed_in: 'This Mac is not signed in',
  unreadable_answer: 'The answer was not in the shape this version of Callie reads',
});

export function readErrorSentence(code: string): string {
  const sentence = READ_ERROR_SENTENCES[code];
  return sentence === undefined ? `The server answered ${code}.` : `${sentence} (${code}).`;
}
