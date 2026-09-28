import { describe, expect, it } from 'vitest';
import { judgeFirm, type JudgmentInput } from '../../research/judgments.ts';
import { buildCallBrief, generatedPartsOf, type FirmFactDto } from '../../research/brief.ts';
import { PRICE_CENTS_PER_MILLION, UnpricedModelError, centsOf, worstCaseRunCents } from '../../research/pricing.ts';

/**
 * The four judgments, the brief they go on, and the price the ceilings compare.
 *
 * All pure: no database, no clock, no provider. The matrix below is the whole
 * decision table, and the two things it must never do — say `no` from silence, and
 * infer a budget — are tests rather than comments.
 */

const AT = '2026-09-28T14:00:00.000Z';

/** A fact as both the judgment input and the brief read it: one shape, two views. */
const fact = (
  key: string,
  quote = 'a sentence the firm published',
  id = key,
): FirmFactDto & JudgmentInput['facts'][number] => ({
  id,
  key: key as JudgmentInput['facts'][number]['key'],
  quote,
  blockId: 'b1',
  sourceReference: 'https://example.test/',
  retrievedAt: AT,
  confidence: null,
});

const base: JudgmentInput = { facts: [], hasPhoneRoute: false, suppressed: false, contacts: [] };
const withFacts = (...keys: string[]): JudgmentInput => ({
  ...base,
  facts: keys.map(key => fact(key)),
});

describe('fit', () => {
  it('is yes when the firm’s own site says it manages property for owners', () => {
    expect(judgeFirm(withFacts('target_fit')).fit).toBe('yes');
  });

  it('is no when the site says otherwise, and `not_target` beats `target_fit`', () => {
    expect(judgeFirm(withFacts('not_target')).fit).toBe('no');
    expect(judgeFirm(withFacts('target_fit', 'not_target')).fit).toBe('no');
  });

  it('is unknown when the pages did not say', () => {
    expect(judgeFirm(withFacts('ownership', 'operating_footprint')).fit).toBe('unknown');
  });
});

describe('evidence of a relevant problem', () => {
  it('is yes from a maintenance workflow or a maintenance job posting', () => {
    expect(judgeFirm(withFacts('maintenance_workflow')).problemEvidence).toBe('yes');
    expect(judgeFirm(withFacts('hiring_maintenance')).problemEvidence).toBe('yes');
  });

  it('is never no from silence', () => {
    expect(judgeFirm(withFacts('target_fit', 'portfolio_size')).problemEvidence).toBe('unknown');
    expect(judgeFirm(base).problemEvidence).toBe('unknown');
  });
});

describe('timing', () => {
  it('is yes from something the firm says changed, or a role it is advertising', () => {
    expect(judgeFirm(withFacts('recent_change')).timing).toBe('yes');
    expect(judgeFirm(withFacts('hiring_maintenance')).timing).toBe('yes');
  });

  it('is unknown otherwise, never no', () => {
    expect(judgeFirm(withFacts('target_fit')).timing).toBe('unknown');
  });
});

describe('reachability', () => {
  it('is yes from a recorded route, a published number, or a named person', () => {
    expect(judgeFirm({ ...base, hasPhoneRoute: true }).reachability).toBe('yes');
    expect(judgeFirm(withFacts('phone_listed')).reachability).toBe('yes');
    expect(judgeFirm(withFacts('named_role')).reachability).toBe('yes');
  });

  it('is unknown when nothing names a number or a person', () => {
    expect(judgeFirm(withFacts('target_fit')).reachability).toBe('unknown');
  });

  it('is no under an active firm-wide suppression, whatever the firm publishes', () => {
    const suppressed = judgeFirm({ ...withFacts('phone_listed'), hasPhoneRoute: true, suppressed: true });
    expect(suppressed.reachability).toBe('no');
    expect(suppressed.reasons.reachability).toContain('do-not-contact');
  });
});

describe('call_first, and what it deliberately ignores', () => {
  it('is true for a firm that fits and can be reached', () => {
    expect(judgeFirm({ ...withFacts('target_fit'), hasPhoneRoute: true }).callFirst).toBe(true);
  });

  it('is true even with no problem evidence and no timing: a call is how you find out', () => {
    const judged = judgeFirm({ ...withFacts('target_fit'), hasPhoneRoute: true });
    expect(judged.problemEvidence).toBe('unknown');
    expect(judged.timing).toBe('unknown');
    expect(judged.callFirst).toBe(true);
  });

  it('is false when the firm does not fit, and when it may not be contacted', () => {
    expect(judgeFirm({ ...withFacts('not_target'), hasPhoneRoute: true }).callFirst).toBe(false);
    expect(judgeFirm({ ...withFacts('target_fit'), hasPhoneRoute: true, suppressed: true }).callFirst).toBe(false);
    // Unknown fit is not a queue for a first call either.
    expect(judgeFirm({ ...base, hasPhoneRoute: true }).callFirst).toBe(false);
  });
});

describe('the reasons, and the likely person', () => {
  it('cites the fact ids behind each judgment', () => {
    const judged = judgeFirm({
      ...base,
      facts: [fact('target_fit', 'We manage property.', 'f1'), fact('recent_change', 'We opened an office.', 'f2')],
    });
    expect(judged.reasons.fit).toContain('f1');
    expect(judged.reasons.timing).toContain('f2');
    for (const reason of Object.values(judged.reasons)) expect(reason.length).toBeLessThanOrEqual(300);
  });

  it('picks the contact whose title a role fact names, and null otherwise', () => {
    const contacts = [
      { contactId: 'c1', fullName: 'A Person', title: 'Owner' },
      { contactId: 'c2', fullName: 'Another', title: 'Maintenance Coordinator' },
    ];
    const matched = judgeFirm({
      ...base,
      contacts,
      facts: [fact('role', 'Our maintenance coordinator handles every request.', 'f1')],
    });
    expect(matched.likelyContactId).toBe('c2');
    expect(judgeFirm({ ...base, contacts }).likelyContactId).toBeNull();
  });

  it('has no judgment, field or reason about budget or intent', () => {
    const judged = judgeFirm(withFacts('software_evidence', 'hiring_maintenance'));
    const serialized = JSON.stringify(judged).toLowerCase();
    expect(serialized).not.toContain('budget');
    expect(serialized).not.toContain('intent');
    expect(Object.keys(judged).sort()).toEqual([
      'callFirst',
      'fit',
      'likelyContactId',
      'problemEvidence',
      'reachability',
      'reasons',
      'timing',
    ]);
  });
});

describe('the call brief', () => {
  const judgments = {
    fit: 'yes' as const,
    problemEvidence: 'yes' as const,
    timing: 'unknown' as const,
    reachability: 'yes' as const,
    reasons: {},
    callFirst: true,
    likelyContactId: null,
    judgedAt: AT,
    runId: 'r1',
  };

  it('takes at most three why-fit quotes and two what-changed quotes, with their sources', () => {
    const facts: FirmFactDto[] = [
      fact('target_fit', 'one', 'f1'),
      fact('maintenance_workflow', 'two', 'f2'),
      fact('portfolio_description', 'three', 'f3'),
      fact('portfolio_size', 'four', 'f4'),
      fact('recent_change', 'five', 'f5'),
      fact('hiring_maintenance', 'six', 'f6'),
    ];
    const brief = buildCallBrief({ facts, judgments, revision: 2, runBrief: null, likelyPerson: null });
    expect(brief.whyFit.map(quote => quote.quote)).toEqual(['one', 'two', 'three']);
    expect(brief.whatChanged.map(quote => quote.quote)).toEqual(['five', 'six']);
    for (const quote of brief.whyFit) {
      expect(quote.sourceReference).toBe('https://example.test/');
      expect(quote.retrievedAt).toBe(AT);
    }
    expect(brief.sources).toEqual([{ sourceReference: 'https://example.test/', retrievedAt: AT }]);
  });

  it('is not generated when nothing was generated', () => {
    const brief = buildCallBrief({ facts: [], judgments, revision: 1, runBrief: null, likelyPerson: null });
    expect(brief.generated).toBe(false);
    expect(brief.questions).toBeNull();
    expect(brief.opening).toBeNull();
  });

  it('is generated when the model wrote the questions or the opening', () => {
    const withQuestions = buildCallBrief({
      facts: [],
      judgments,
      revision: 1,
      runBrief: { questions: ['How do you take work orders?', 'Who handles them?'], opening: 'Hello', generated: true },
      likelyPerson: null,
    });
    expect(withQuestions.generated).toBe(true);
    expect(withQuestions.questions).toEqual(['How do you take work orders?', 'Who handles them?']);
    expect(withQuestions.opening).toBe('Hello');
  });

  it('ignores a stored brief that is not the shape it claims', () => {
    expect(generatedPartsOf({ questions: ['only one'], opening: 42 })).toEqual({ questions: null, opening: null });
    expect(generatedPartsOf(null)).toEqual({ questions: null, opening: null });
  });
});

describe('what a run may cost', () => {
  it('rounds up to whole cents, and a call that happened costs at least one', () => {
    expect(centsOf('claude-haiku-4-5', { inputTokens: 1_000_000, outputTokens: 0 })).toBe(100);
    expect(centsOf('claude-haiku-4-5', { inputTokens: 0, outputTokens: 1_000_000 })).toBe(500);
    // 1 000 input tokens is a tenth of a cent, which is one cent.
    expect(centsOf('claude-haiku-4-5', { inputTokens: 1_000, outputTokens: 0 })).toBe(1);
    expect(centsOf('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it('cannot price a model with no reviewed row', () => {
    expect(Object.keys(PRICE_CENTS_PER_MILLION)).toEqual(['claude-haiku-4-5']);
    expect(() => centsOf('claude-opus-5', { inputTokens: 1, outputTokens: 1 })).toThrowError(UnpricedModelError);
  });

  it('bounds the worst case by the parse cap, not by max_page_bytes', () => {
    // Four pages of a megabyte each would be about a dollar, which the default
    // fifty-cent daily ceiling would refuse for ever. The parse never offers the
    // extractor more than twelve thousand characters a page.
    const worst = worstCaseRunCents({ modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 1_000_000 });
    expect(worst).toBe(2);
    expect(worstCaseRunCents({ modelName: 'claude-haiku-4-5', maxPagesPerFirm: 8, maxPageBytes: 1_000_000 })).toBe(3);
  });
});
