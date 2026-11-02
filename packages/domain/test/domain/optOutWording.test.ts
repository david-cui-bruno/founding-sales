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

  it('still suppresses on ordinary language after the presentation change (migration 0024)', () => {
    // David, 29 September 2026, kept exactly this: the mandatory stop line goes and the
    // word ban goes, but "automatic handling of stop requests in ordinary language"
    // stays. Nothing in that change touches `replyClassification.ts`, and this is the
    // test that would notice if it had.
    for (const text of ['please unsubscribe me', 'Please unsubscribe me.', 'stop emailing me', 'Stop emailing me.']) {
      expect(hasExplicitOptOut(authoredText(text)), text).toBe(true);
      expect(classifyReply(message(text)).class, text).toBe('opt_out');
    }
  });

  // The footer invites "If this isn't relevant, just reply and I won't email again.", so
  // the plainest answers to it are requests not to be emailed again (David, November 2026).
  // Both halves in one table, so a rule that suppressed on "relevant" or on any "stop"
  // passes neither.
  it.each([
    'stop',
    'Stop.',
    'Please stop.',
    'please stop please',
    'STOP!',
    'Not relevant.',
    'not relevant',
    'This is not relevant.',
    "It's not relevant to us.",
    'It’s not relevant for our business',
    'Not relevant to me, thanks',
    'No, not relevant. Thanks.',
    'No thanks',
    'No thank you.',
    'No thanks, thank you',
    'Not interested.',
    "We're not interested.",
    'I am not interested, thanks.',
    'Hello, not relevant to us.',
    'Thanks for reaching out. Not relevant.',
    'Not relevant\nThanks,\nBob Example',
    'Not relevant\n\n> If this isn’t relevant, just reply and I won’t email again.',
    'Not relevant\n\nOn Mon, 2 Nov 2026, Sam wrote:\n> If this isn\'t relevant, just reply and I won\'t email again.',
  ])('a one-sentence stop answer suppresses: %j', text => {
    expect(hasExplicitOptOut(authoredText(text)), text).toBe(true);
    const classification = classifyReply(message(text));
    expect(classification.class, text).toBe('opt_out');
    expect(classification.suggestedDisposition, text).toBe('opt_out');
    expect(classification.requiresConfirmation, text).toBe(false);
    expect(classification.signals.map(signal => signal.rule), text).toEqual(['explicit_opt_out']);
  });

  it.each([
    'relevant',
    'This is relevant to us.',
    'It is relevant, call me Tuesday.',
    'Relevant to us. Tell me more.',
    'Stop by our office on Tuesday.',
    'Please stop by.',
    'Not relevant right now, maybe next quarter.',
    'Not interested right now, ask again in the spring.',
    'No thanks, but call me next week.',
    'No thanks to the newsletter, but do call.',
    "If this isn't relevant, just reply and I won't email again.",
    'Please do not stop the service.',
    'I am not the right person, but this is relevant.',
  ])('wording that is not a stop request does not suppress: %j', text => {
    expect(hasExplicitOptOut(authoredText(text)), text).toBe(false);
    expect(classifyReply(message(text)).class, text).not.toBe('opt_out');
    expect(classifyReply(message(text)).requiresConfirmation, text).toBe(true);
  });

  it('a truncated body cannot prove an opt-out', () => {
    // 12.3 fetches a bounded body. A sentence that was cut off may continue, so the
    // conservative answer is confirmation rather than an irreversible suppression.
    const classification = classifyReply(message('Please stop emailing me', true));
    expect(classification.requiresConfirmation).toBe(true);
  });
});
