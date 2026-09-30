import { hasReasonSentence, reasonSentence } from '@fss/contracts';

/**
 * The call view's words (slice C1). Every refusal is a sentence from `reasonSentence`,
 * the one map, which carries the call-session codes and the Mac's own start refusals
 * too. A code with no sentence there — a transport failure (`offline`, `http_503`), an
 * envelope refusal — is the call-failed sentence, never the generic one with the code in
 * parentheses (review of C1, fold 3).
 */

export const MICROPHONE_DENIED_SENTENCE =
  'Callie can’t use your microphone. Open System Settings, then Privacy & Security, then Microphone, turn on Callie, and press Call again.';

export const CALL_FAILED_SENTENCE = 'The call could not be connected. Check your internet connection and press Call again.';

export function callRefusalSentence(code: string): string {
  return hasReasonSentence(code) ? reasonSentence(code) : CALL_FAILED_SENTENCE;
}

/** The Voice SDK's microphone refusals (31401 permission, 31402 acquisition) and the browser's own. */
export function isMicrophoneDenied(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name } = error as { code?: unknown; name?: unknown };
  return code === 31401 || code === 31402 || name === 'NotAllowedError' || name === 'PermissionDeniedError';
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function callTimer(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h > 0 ? `${String(h)}:${String(m).padStart(2, '0')}:${s}` : `${String(m)}:${s}`;
}

/** "Attempt 2 of 4", or the parked line. */
export function attemptLabel(cadence: { readonly nextAttempt: number | null; readonly limit: number; readonly parked: boolean }): string {
  if (cadence.parked || cadence.nextAttempt === null) {
    return `${String(cadence.limit)} calls went unanswered. Calling is parked for review.`;
  }
  return `Attempt ${String(cadence.nextAttempt)} of ${String(cadence.limit)}`;
}
