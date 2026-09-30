import { describe, expect, it } from 'vitest';
import { reasonSentence } from '@fss/contracts';
import { enrolRefusalSentence } from '../src/renderer/today/followUpView.ts';

/** A refusal the card has no words of its own for reads as a sentence, never the raw code. */
describe('enrolRefusalSentence', () => {
  it('keeps its own words for the codes it knows', () => {
    expect(enrolRefusalSentence('stale_preview')).toBe('the dates changed after you previewed them');
  });

  it('falls back to reasonSentence, not the code', () => {
    expect(enrolRefusalSentence('follow_up_expired')).toBe(reasonSentence('follow_up_expired'));
    expect(enrolRefusalSentence('something_new')).not.toBe('something_new');
  });
});
