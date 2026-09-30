import { describe, expect, it } from 'vitest';
import {
  CALL_CONSUMPTION_REFUSAL_SENTENCES,
  CALL_SESSION_REFUSAL_CODES,
  CRM_REFUSAL_CODES,
  DIAL_REFUSAL_SENTENCES,
  hasReasonSentence,
} from '@fss/contracts';
import { CALL_FAILED_SENTENCE, callRefusalSentence } from '../src/renderer/calling/callText.ts';

/**
 * Every code a Call press can come back with is a sentence, never the generic one with
 * the code in parentheses (review of C1, fold 3). The codes are the ones `startCall` in
 * `src/main/todayBridge.ts` answers: its own, the server's for `/calls/calling`,
 * `/calls/session` and `/calls/access-token`, and the API clients' transport failures.
 */

/** `startCall`'s own refusals, and the ones it passes through from the card it reads. */
const BRIDGE_CODES = ['call_cancelled', 'calling_off', 'route_missing', 'identity_missing'] as const;

/** `createCallSession`'s refusals (`DialRefusalCode | CallSessionRefusalCode | 'invalid_input'`), and the route's. */
const SERVER_CODES = [
  ...CALL_SESSION_REFUSAL_CODES,
  ...Object.keys(DIAL_REFUSAL_SENTENCES),
  ...Object.keys(CALL_CONSUMPTION_REFUSAL_SENTENCES),
  ...CRM_REFUSAL_CODES,
  'invalid_input',
  'firm_unknown',
] as const;

/** The API clients' own (`apiClient.ts`, `authedClient.ts`) and the envelope's refusals. */
const TRANSPORT_CODES = [
  'offline',
  'unreadable_answer',
  'refused',
  'not_signed_in',
  'http_500',
  'http_503',
  'not_found',
  'malformed_body',
  'unauthenticated',
  'internal_error',
  'database_busy',
  'not_ready',
  'integration_unconfigured',
] as const;

describe('the call view’s refusal sentences', () => {
  it('has a sentence of its own for every refusal the bridge and the call-session route make', () => {
    for (const code of [...BRIDGE_CODES, ...SERVER_CODES]) {
      expect(hasReasonSentence(code), code).toBe(true);
    }
  });

  it('never shows a code, in parentheses or otherwise, for any code a Call press can answer', () => {
    for (const code of [...BRIDGE_CODES, ...SERVER_CODES, ...TRANSPORT_CODES, 'some_future_code']) {
      const sentence = callRefusalSentence(code);
      expect(sentence, code).not.toContain(`(${code})`);
      expect(sentence, code).not.toContain(code);
      expect(sentence.length, code).toBeGreaterThan(10);
    }
  });

  it('says a transport failure as the call-failed sentence', () => {
    for (const code of TRANSPORT_CODES) {
      if (!hasReasonSentence(code)) expect(callRefusalSentence(code), code).toBe(CALL_FAILED_SENTENCE);
    }
  });
});
