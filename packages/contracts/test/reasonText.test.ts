import { describe, expect, it } from 'vitest';
import {
  CALL_SESSION_REFUSAL_CODES,
  CALL_SESSION_REFUSAL_SENTENCES,
  CRM_REFUSAL_CODES,
  CRM_REFUSAL_SENTENCES,
  DIAL_REFUSAL_SENTENCES,
  FOLLOW_UP_PERMISSION_REFUSAL_SENTENCES,
  FOLLOW_UP_PREVIEW_REFUSAL_SENTENCES,
  GRANT_REFUSAL_CODES,
  HOLD_REASON_CODES,
  HOLD_REASON_SENTENCES,
  MAIL_REFUSAL_SENTENCES,
  MAILBOX_SWITCH_REFUSAL_CODES,
  RESEARCH_REFUSAL_CODES,
  RESEARCH_REFUSAL_SENTENCES,
  STAGE_REVIEW_REASONS,
  STAGE_REVIEW_SENTENCES,
  dialCheckResponseSchema,
  hasReasonSentence,
  liveWorkPresentSentence,
  reasonSentence,
} from '../src/index.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * `FOLLOW_UP_PREVIEW_REFUSALS` lives in `@fss/domain`, which this package may not import
 * (and a relative import drags the domain's own sources into this package's typecheck).
 * Its list is read from the source text instead, so it is still the domain's own list.
 */
const FOLLOW_UP_PREVIEW_REFUSALS: readonly string[] = (() => {
  const source = readFileSync(fileURLToPath(new URL('../../domain/dial/followUpPreview.ts', import.meta.url)), 'utf8');
  const block = /export const FOLLOW_UP_PREVIEW_REFUSALS = \[([\s\S]*?)\] as const;/u.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/gu)].map(match => match[1] ?? '');
})();

/** The domain's `StageReviewReason` union, read from its source for the reason above. */
const DOMAIN_STAGE_REVIEW_REASONS: readonly string[] = (() => {
  const source = readFileSync(fileURLToPath(new URL('../../domain/crm/stageEvidence.ts', import.meta.url)), 'utf8');
  const block = /export type StageReviewReason =([\s\S]*?);/u.exec(source)?.[1] ?? '';
  return [...block.matchAll(/'([a-z_]+)'/gu)].map(match => match[1] ?? '');
})();

/**
 * Every code a window may show has a sentence (call-to-booking A3). The lists are read
 * from their contracts, so a code added there without words fails here.
 */

it('found the domain list', () => {
  expect(FOLLOW_UP_PREVIEW_REFUSALS.length).toBeGreaterThan(5);
});

const dialCodes = dialCheckResponseSchema.shape.advice.shape.reasons.element.options;

function missing(codes: readonly string[]): string[] {
  return codes.filter(code => !hasReasonSentence(code));
}

describe('reasonSentence covers every list of codes', () => {
  it.each([
    ['hold reason codes', HOLD_REASON_CODES],
    ['dial refusals', dialCodes],
    ['CRM refusals', CRM_REFUSAL_CODES],
    ['research refusals', RESEARCH_REFUSAL_CODES],
    ['follow-up preview refusals', FOLLOW_UP_PREVIEW_REFUSALS],
    ['mailbox switch refusals', MAILBOX_SWITCH_REFUSAL_CODES],
    ['grant refusals', GRANT_REFUSAL_CODES],
    ['call session refusals', CALL_SESSION_REFUSAL_CODES],
    ['stage review reasons', STAGE_REVIEW_REASONS],
    ['review item and mailbox lock words', ['stage_review', 'mailbox_busy']],
    ['mailbox_already_connected and its siblings', ['mailbox_already_connected', 'mailbox_not_connected']],
  ] as const)('%s', (_name, codes) => {
    expect(missing(codes)).toEqual([]);
  });

  it('keeps each typed map to exactly its list', () => {
    expect(Object.keys(HOLD_REASON_SENTENCES).sort()).toEqual([...HOLD_REASON_CODES].sort());
    expect(Object.keys(DIAL_REFUSAL_SENTENCES).sort()).toEqual([...dialCodes].sort());
    expect(Object.keys(CRM_REFUSAL_SENTENCES).sort()).toEqual([...CRM_REFUSAL_CODES].sort());
    expect(Object.keys(RESEARCH_REFUSAL_SENTENCES).sort()).toEqual([...RESEARCH_REFUSAL_CODES].sort());
    expect(Object.keys(FOLLOW_UP_PREVIEW_REFUSAL_SENTENCES).sort()).toEqual([...FOLLOW_UP_PREVIEW_REFUSALS].sort());
    for (const code of GRANT_REFUSAL_CODES) expect(Object.keys(MAIL_REFUSAL_SENTENCES)).toContain(code);
    expect(Object.keys(CALL_SESSION_REFUSAL_SENTENCES).sort()).toEqual([...CALL_SESSION_REFUSAL_CODES].sort());
    expect(DOMAIN_STAGE_REVIEW_REASONS.length).toBeGreaterThan(3);
    expect([...DOMAIN_STAGE_REVIEW_REASONS].sort()).toEqual([...STAGE_REVIEW_REASONS].sort());
    expect(Object.keys(STAGE_REVIEW_SENTENCES).sort()).toEqual([...STAGE_REVIEW_REASONS, 'stage_review'].sort());
  });

  it('covers the follow-up permission hold codes', () => {
    for (const code of Object.keys(FOLLOW_UP_PERMISSION_REFUSAL_SENTENCES)) expect(hasReasonSentence(code)).toBe(true);
    for (const code of ['cold_legacy', 'follow_up_not_permitted', 'follow_up_expired', 'follow_up_scope_exhausted', 'firm_already_enrolled']) {
      expect(hasReasonSentence(code)).toBe(true);
    }
  });

  it('writes a sentence, never the code, for every known code', () => {
    const all = [
      ...HOLD_REASON_CODES,
      ...dialCodes,
      ...CRM_REFUSAL_CODES,
      ...RESEARCH_REFUSAL_CODES,
      ...FOLLOW_UP_PREVIEW_REFUSALS,
      ...GRANT_REFUSAL_CODES,
      ...CALL_SESSION_REFUSAL_CODES,
      ...STAGE_REVIEW_REASONS,
      'stage_review',
      'mailbox_busy',
    ];
    for (const code of all) {
      const sentence = reasonSentence(code);
      expect(sentence, code).not.toContain('_');
      expect(sentence, code).toMatch(/[.]$/u);
      expect(sentence.length, code).toBeGreaterThan(30);
    }
  });

  it('says the sentences the brief gives', () => {
    expect(reasonSentence('coverage_incomplete')).toBe('Callie is still reading this mailbox and won’t send from it until it has caught up.');
    expect(reasonSentence('cold_outreach_mailbox_required')).toContain('Call this firm instead');
    expect(reasonSentence('mailbox_switch_pending_sends')).toBe('A message is still being sent from the current mailbox. Try again in a few minutes.');
  });

  it('no longer says Google refused when the grant failed', () => {
    const sentence = reasonSentence('grant_refused');
    expect(sentence).toBe('Callie couldn’t finish connecting that account. Your mailbox did not change. Try again in a minute.');
    expect(sentence).not.toContain('Google');
  });

  it('names the live enrollments in the live_work_present sentence', () => {
    expect(liveWorkPresentSentence(undefined)).toBe(reasonSentence('live_work_present'));
    expect(liveWorkPresentSentence([])).toBe(reasonSentence('live_work_present'));
    const one = liveWorkPresentSentence([{ sequenceName: 'Spring follow-up', stepNumber: 2 }]);
    expect(one).toContain('Spring follow-up, step 2');
    const two = liveWorkPresentSentence([{ sequenceName: 'Spring follow-up', stepNumber: 2 }, { sequenceName: 'Intro', stepNumber: null }]);
    expect(two).toContain('Spring follow-up, step 2; Intro');
    expect(two).not.toMatch(/[0-9a-f]{8}-/u);
  });

  it('answers an unknown code generically, with the code in parentheses', () => {
    const sentence = reasonSentence('brand_new_code');
    expect(sentence).toContain('(brand_new_code)');
    expect(sentence).not.toBe('brand_new_code');
    // Not a prototype property either.
    expect(reasonSentence('__proto__')).toContain('(__proto__)');
    expect(reasonSentence('constructor')).toContain('(constructor)');
  });
});

// Slice M1: the match command's refusals.
describe('the meeting match refusals', () => {
  it('has a sentence for every code, and no code in any of them', async () => {
    const { MEETING_MATCH_REFUSAL_CODES, MEETING_MATCH_REFUSAL_SENTENCES } = await import('../src/index.ts');
    expect(Object.keys(MEETING_MATCH_REFUSAL_SENTENCES).sort()).toEqual([...MEETING_MATCH_REFUSAL_CODES].sort());
    for (const code of MEETING_MATCH_REFUSAL_CODES) {
      expect(hasReasonSentence(code), code).toBe(true);
      expect(reasonSentence(code), code).not.toContain('_');
    }
  });
});

// Slice C2: the transcription refusals.
describe('the transcription refusals', () => {
  it('has a sentence for every code, and no code in any of them', async () => {
    const { TRANSCRIPTION_REFUSAL_CODES, TRANSCRIPTION_REFUSAL_SENTENCES } = await import('../src/index.ts');
    expect(Object.keys(TRANSCRIPTION_REFUSAL_SENTENCES).sort()).toEqual([...TRANSCRIPTION_REFUSAL_CODES].sort());
    for (const code of TRANSCRIPTION_REFUSAL_CODES) {
      expect(hasReasonSentence(code), code).toBe(true);
      expect(reasonSentence(code), code).not.toContain('_');
    }
  });
});
