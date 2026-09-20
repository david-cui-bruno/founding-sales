import { describe, expect, it } from 'vitest';
import { applyModelSuggestion, classifyReply, type ReplyMessage } from '@fss/domain';
import { mustCover } from './support/coverage.ts';

/**
 * Appendix G 34: "LLM labels a human reply automated with high confidence;
 * deterministic/human gate prevents release. Malformed output becomes uncertain."
 *
 * 12.4 lists exactly five things a model may not do by itself: release a message as
 * automated, close an opportunity, create a suppression from ambiguous language, commit
 * an extracted callback instant, or resume automation.
 *
 * ## The vacuous-pass trap
 *
 * A gate that discarded every model answer would pass this scenario and be useless. The
 * model exists to label and prioritise ordinary work; a system that threw its output away
 * would be a system with no classifier, and the test would not notice. So "the model
 * changed nothing" is not the assertion — "the model changed the label and not the class"
 * is.
 *
 * Closed by asserting both halves against the same call: the suggestion *is* recorded as a
 * signal and may set the suggested disposition, while the class stays uncertain and still
 * requires confirmation.
 */

const message = (text: string): ReplyMessage => ({
  id: 'm-1',
  headers: { from: 'someone@example.test', subject: 'Re: a note' },
  bodyParts: [{ text }],
});

const HUMAN_REPLY = message('Yes, that sounds useful. Can we talk on Thursday?');

describe('Appendix G 34: what a confident model answer may and may not do', () => {
  mustCover(34, ['applyModelSuggestion', 'requiresConfirmation']);

  it('a confident "automated" never releases an uncertain message', () => {
    const deterministic = classifyReply(HUMAN_REPLY);
    expect(deterministic.class).toBe('uncertain');
    const withModel = applyModelSuggestion(deterministic, {
      class: 'automated',
      disposition: 'interested',
      confidence: 0.99,
    });
    expect(withModel.class).toBe('uncertain');
    expect(withModel.requiresConfirmation).toBe(true);
  });

  it('but the suggestion is still recorded, so the gate is not simply discarding it', () => {
    const withModel = applyModelSuggestion(classifyReply(HUMAN_REPLY), {
      class: 'automated',
      disposition: 'interested',
      confidence: 0.99,
    });
    expect(withModel.signals.some(signal => signal.rule === 'model_suggestion')).toBe(true);
    expect(withModel.suggestedDisposition).toBe('interested');
  });

  it('malformed output becomes uncertain rather than throwing or guessing', () => {
    const withModel = applyModelSuggestion(classifyReply(HUMAN_REPLY), {
      class: 'not-a-class',
      disposition: 'not-a-disposition',
      confidence: Number.NaN,
    });
    expect(withModel.class).toBe('uncertain');
    expect(withModel.requiresConfirmation).toBe(true);
    expect(withModel.signals.some(signal => signal.evidence.includes('unreadable'))).toBe(true);
  });

  it('a deterministic answer is not touched by a model at all', () => {
    const optOut = classifyReply(message('Please stop emailing me.'));
    expect(optOut.class).toBe('opt_out');
    expect(applyModelSuggestion(optOut, { class: 'automated', confidence: 1 })).toEqual(optOut);
  });

  it('a null suggestion leaves the deterministic answer alone', () => {
    const deterministic = classifyReply(HUMAN_REPLY);
    expect(applyModelSuggestion(deterministic, null)).toEqual(deterministic);
  });
});
