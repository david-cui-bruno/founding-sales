import { describe, expect, it } from 'vitest';
import {
  authoredText,
  classifyReply,
  hasExplicitOptOut,
  type ReplyMessage,
} from '../../src/rules/replyClassification.ts';

/**
 * Appendix G 35: "Ambiguous opt-out wording holds for review; explicit stop wording
 * suppresses immediately."
 *
 * 12.4: "Explicit deterministic opt-out language suppresses immediately. Ambiguous
 * opt-out language stays held for confirmation." Invariant 4 makes the first half
 * irreversible for a prospect-originated request, which is exactly why the second half
 * may not lean towards it.
 *
 * ## The vacuous-pass trap
 *
 * A rule that held everything would pass the ambiguous half on its own; a rule that
 * suppressed on any mention of stopping would pass the explicit half on its own. Both are
 * real product failures — the first never honours an opt-out, the second suppresses a
 * prospect who said "stop sending me the newsletter, but do call".
 *
 * Closed by asserting both halves against the same function in the same file, so neither
 * degenerate rule survives.
 */

const message = (text: string, truncated = false): ReplyMessage => ({
  id: 'm-1',
  headers: { from: 'someone@example.test', subject: 'Re: a note' },
  bodyParts: [{ text, truncated }],
});

describe('Appendix G 35: explicit stop suppresses, ambiguity holds', () => {
  it('explicit stop wording is an opt-out', () => {
    for (const text of ['Please stop emailing me.', 'Unsubscribe me.', 'Remove me from your list.']) {
      expect(hasExplicitOptOut(authoredText(text)), text).toBe(true);
      expect(classifyReply(message(text)).class, text).toBe('opt_out');
    }
  });

  it('ambiguous wording is not an opt-out and asks for confirmation', () => {
    for (const text of [
      'Not right now, maybe later in the year.',
      'I am not the right person for this.',
      'We are pausing all vendor conversations this quarter.',
    ]) {
      expect(hasExplicitOptOut(authoredText(text)), text).toBe(false);
      const classification = classifyReply(message(text));
      expect(classification.class, text).not.toBe('opt_out');
      expect(classification.requiresConfirmation, text).toBe(true);
    }
  });

  it('a stop request scoped to one channel is not a blanket opt-out', () => {
    // 9.1's do-not-call row makes the same distinction for the phone: suppress the
    // firm "only when the request covers all Callie contact". A sentence that names a
    // channel is a scoped request, and scoping is a decision a person makes.
    const text = 'Please take me off the newsletter, but do call me next quarter.';
    expect(hasExplicitOptOut(authoredText(text))).toBe(false);
    expect(classifyReply(message(text)).class).not.toBe('opt_out');
  });

  it('a truncated body cannot prove an opt-out', () => {
    // 12.3 fetches a bounded body. A sentence that was cut off may continue, so the
    // conservative answer is confirmation rather than an irreversible suppression.
    const classification = classifyReply(message('Please stop emailing me', true));
    expect(classification.requiresConfirmation).toBe(true);
  });
});
