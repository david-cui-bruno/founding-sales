/**
 * The one sentence every view says when the server did not answer (1.0.13).
 *
 * There were seven of these — five identical and two nearly so — one per view model,
 * which is how a product ends up telling somebody three different things about one
 * cable. The banner adds the half that is only true of a view that has something on
 * screen; the sign-in screen and the notice maps say the first sentence alone.
 */
import { reasonSentence } from '@fss/contracts';

export const OFFLINE_SENTENCE = 'Callie cannot reach the server.';

export const OFFLINE_BANNER = `${OFFLINE_SENTENCE} What is here is as it was last read, and changes will fail until it reconnects.`;

/**
 * The sentence a window says after "Callie could not read …" (lanes g69 and g78).
 *
 * One mapping for every window that shows a failed read as a grey line with Retry —
 * Administration's sending section since g69, the sequence editor's slices since g78 —
 * so a code reads the same wherever it appears. The codes a person can act on get a
 * sentence; any other code gets the shared generic sentence, which names the code in
 * parentheses so a screenshot is still something an operator can search the logs for.
 */
const READ_ERROR_SENTENCES: Readonly<Record<string, string>> = Object.freeze({
  offline: 'The server did not answer',
  not_signed_in: 'This Mac is not signed in',
  unreadable_answer: 'The answer was not in the shape this version of Callie reads',
});

export function readErrorSentence(code: string): string {
  const sentence = READ_ERROR_SENTENCES[code];
  return sentence === undefined ? reasonSentence(code) : `${sentence} (${code}).`;
}
