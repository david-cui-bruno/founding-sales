import { describe, expect, it } from 'vitest';
import { judgeFirm, type JudgmentInput } from '../../research/judgments.ts';
import { buildCallBrief, generatedPartsOf, type FirmFactDto } from '../../research/brief.ts';
import {
  MAX_EXTRACTION_OUTPUT_TOKENS,
  PRICE_CENTS_PER_MILLION,
  UnpricedModelError,
  centsOf,
  withinWorstCase,
  worstCaseInputTokens,
  worstCaseRunCents,
} from '../../research/pricing.ts';
import {
  EXTRACTION_OUTPUT_SCHEMA,
  EXTRACTION_SYSTEM_TEXT,
  extractionUserText,
} from '../../research/extractionPrompt.ts';
import { FACT_KEYS, FACT_KEY_DEFINITIONS } from '../../research/facts.ts';
import { MAX_BLOCKS, MAX_TEXT_CHARACTERS } from '../../research/pageText.ts';

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
  quote: string | null = 'a sentence the firm published',
  id = key,
  firstParty = true,
): FirmFactDto & JudgmentInput['facts'][number] => ({
  id,
  key: key as JudgmentInput['facts'][number]['key'],
  quote,
  firstParty,
  blockId: 'b1',
  sourceReference: firstParty ? 'https://example.test/' : 'https://news.test/piece',
  retrievedAt: AT,
  confidence: null,
});

/** The same fact, read off a page on somebody else's host. */
const thirdPartyFact = (
  key: string,
  quote: string | null = 'a sentence somebody else published',
  id = key,
): FirmFactDto & JudgmentInput['facts'][number] => fact(key, quote, id, false);

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

  it('picks the contact whose title a role block names, and null otherwise', () => {
    const contacts = [
      { contactId: 'c1', fullName: 'A Person', title: 'Owner' },
      { contactId: 'c2', fullName: 'Another', title: 'Maintenance Coordinator' },
    ];
    // The text comes in as `roleBlocks`, not off the fact: a `role` fact stores no
    // quote, because the block it names is a block naming a person.
    const matched = judgeFirm({
      ...base,
      contacts,
      facts: [fact('role', null, 'f1')],
      roleBlocks: ['Our maintenance coordinator handles every request.'],
    });
    expect(matched.likelyContactId).toBe('c2');
    expect(judgeFirm({ ...base, contacts }).likelyContactId).toBeNull();
    // A `role` fact with no block text offered is no match, and never a guess.
    expect(judgeFirm({ ...base, contacts, facts: [fact('role', null, 'f1')] }).likelyContactId).toBeNull();
  });

  it('never lets a page on somebody else’s host decide fit or reachability', () => {
    // A trade article calling a brokerage a property manager is not the firm saying so,
    // and a directory listing a number is not the firm publishing one.
    const third = judgeFirm({ ...base, facts: [thirdPartyFact('target_fit'), thirdPartyFact('phone_listed', null)] });
    expect(third.fit).toBe('unknown');
    expect(third.reachability).toBe('unknown');
    expect(third.callFirst).toBe(false);
    // No fact id is cited for a judgment the fact was not allowed to reach.
    expect(third.reasons.fit).not.toContain('target_fit');
    // The same two facts on the firm's own site do decide both.
    const own = judgeFirm({ ...base, facts: [fact('target_fit'), fact('phone_listed', null)] });
    expect(own.fit).toBe('yes');
    expect(own.reachability).toBe('yes');
    // And a third-party page may still be evidence of a problem and of timing: those
    // two are about the world, not about what the firm claims to be.
    const problem = judgeFirm({ ...base, facts: [thirdPartyFact('hiring_maintenance')] });
    expect(problem.problemEvidence).toBe('yes');
    expect(problem.timing).toBe('yes');
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

  it('attributes a third-party quote to its host, and the firm’s own to nobody', () => {
    const facts = [
      fact('target_fit', 'We manage property for owners.', 'f1'),
      thirdPartyFact('recent_change', 'The firm opened a second office, we hear.', 'f2'),
    ];
    const brief = buildCallBrief({ facts, judgments, revision: 2, runBrief: null, likelyPerson: null });
    expect(brief.whyFit[0]).toMatchObject({ firstParty: true, attribution: null });
    // Rendered beside the quote, so the brief cannot present somebody else's sentence
    // as the firm's own words.
    expect(brief.whatChanged[0]).toMatchObject({ firstParty: false, attribution: 'per news.test' });
  });

  it('renders no quote for a key whose block names a person', () => {
    // There is nothing to render: `named_role`, `phone_listed` and `role` store no
    // quote at all, and an empty quotation line would be worse than none.
    const brief = buildCallBrief({
      facts: [fact('named_role', null, 'f1'), fact('phone_listed', null, 'f2')],
      judgments,
      revision: 1,
      runBrief: null,
      likelyPerson: null,
    });
    expect(brief.whyFit).toEqual([]);
    expect(brief.whatChanged).toEqual([]);
    expect(brief.sources).toEqual([]);
  });

  it('carries how many runs have failed since the last one that completed', () => {
    // A provider failure completes its job, so the retry is the sweep's. Without this
    // the firm page would show a brief three days stale and no hint why.
    expect(buildCallBrief({ facts: [], judgments, revision: 1, runBrief: null, likelyPerson: null }).failedTries).toBe(0);
    expect(
      buildCallBrief({ facts: [], judgments, revision: 1, runBrief: null, likelyPerson: null, failedTries: 3 })
        .failedTries,
    ).toBe(3);
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
    expect(worst).toBe(3);
    expect(worstCaseRunCents({ modelName: 'claude-haiku-4-5', maxPagesPerFirm: 8, maxPageBytes: 1_000_000 })).toBe(6);
  });

  it('measures the prompt’s own size rather than guessing it', () => {
    // The figure used to be a round 2 000 tokens somebody chose, which meant widening
    // the system text or adding a fact key moved the real request without moving the
    // price — and the price is what a ceiling compares against. Now the bound is
    // computed from the constants themselves, so the request cannot outgrow it in
    // silence. One page's worth of the bound is the parse cap plus the markers:
    const onePage = worstCaseInputTokens({ maxPagesPerFirm: 1, maxPageBytes: 1_000_000 });
    const twoPages = worstCaseInputTokens({ maxPagesPerFirm: 2, maxPageBytes: 1_000_000 });
    const perPage = twoPages - onePage;
    expect(perPage).toBe(Math.ceil(MAX_TEXT_CHARACTERS / 2.5) + MAX_BLOCKS * 8 + 300);
    // And the fixed part is the measured length of the three constant strings.
    const dictionary = FACT_KEYS.map(key => `- ${key}: ${FACT_KEY_DEFINITIONS[key]}`).join('\n');
    const fixed =
      EXTRACTION_SYSTEM_TEXT.length + dictionary.length + JSON.stringify(EXTRACTION_OUTPUT_SCHEMA).length;
    expect(onePage - perPage).toBe(Math.ceil(fixed / 2.5));
  });

  it('bounds a real request built at the maximum, marker for marker', () => {
    // The vacuous-pass trap this whole item is about: a bound that was never compared
    // with a request. So the request is built — the actual prompt, the actual
    // dictionary, the actual schema, four pages of a hundred full blocks each with its
    // `[b12]` marker and a 500-character source URL — and measured against the bound
    // the ceiling authorized it with.
    const settings = { modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 1_000_000 } as const;
    const url = `https://example.test/${'p'.repeat(460)}`;
    const sources = Array.from({ length: settings.maxPagesPerFirm }, (_, page) => ({
      sourceReference: `${url}-${String(page)}`,
      firstParty: true,
      blocks: Array.from({ length: MAX_BLOCKS }, (_, index) => ({
        id: `b${String(index + 1)}`,
        // A hundred blocks of a hundred and twenty characters is the parse cap exactly.
        text: 'x'.repeat(120),
      })),
    }));
    const request = { sources, firmName: 'A Firm With A Deliberately Long Registered Name LLC' };
    const characters =
      EXTRACTION_SYSTEM_TEXT.length +
      JSON.stringify(EXTRACTION_OUTPUT_SCHEMA).length +
      extractionUserText(request).length;
    const tokens = Math.ceil(characters / 2.5);
    expect(tokens).toBeLessThanOrEqual(worstCaseInputTokens(settings));
    expect(withinWorstCase(settings, { inputTokens: tokens, outputTokens: MAX_EXTRACTION_OUTPUT_TOKENS })).toBe(true);
  });

  it('is exceeded by the same request in dense script, which is why the count is exact', () => {
    // The adversarial case for a characters-per-token ratio. Japanese and Chinese text
    // tokenizes at roughly one token a character, not 2.5, so the maximal request the
    // settings allow can count about two and a half times the bound the ceiling
    // authorized it against. The ratio therefore sizes the *reservation* and never
    // admits the call: `finishFirmResearch` asks the provider for the exact count,
    // drops trailing blocks, and records `over_budget` rather than calling over it.
    const settings = { modelName: 'claude-haiku-4-5', maxPagesPerFirm: 4, maxPageBytes: 1_000_000 } as const;
    const sources = Array.from({ length: settings.maxPagesPerFirm }, (_, page) => ({
      sourceReference: `https://example.test/${String(page)}`,
      firstParty: true,
      blocks: Array.from({ length: MAX_BLOCKS }, (_, index) => ({
        id: `b${String(index + 1)}`,
        // 120 characters of Japanese: the same parse cap as the test above.
        text: '物件管理会社の業務'.repeat(13).slice(0, 120),
      })),
    }));
    const request = { sources, firmName: '不動産管理株式会社' };
    const characters = EXTRACTION_SYSTEM_TEXT.length + JSON.stringify(EXTRACTION_OUTPUT_SCHEMA).length + extractionUserText(request).length;
    // What the ratio would have believed, against what a tokenizer of dense script
    // actually returns for the same text.
    const ratioEstimate = Math.ceil(characters / 2.5);
    const dense = [...extractionUserText(request)].filter(character => (character.codePointAt(0) ?? 0) > 0x2e7f).length;
    expect(ratioEstimate).toBeLessThanOrEqual(worstCaseInputTokens(settings));
    expect(dense).toBeGreaterThan(worstCaseInputTokens(settings));
  });

  it('bounds a run that reported every usage category, cached tokens included', () => {
    // The bound is what `claimResearchClearance` authorized the run against, so a call
    // whose actual usage came in over it would mean the ceiling authorized a price it
    // had not seen. Maximum pages, maximum output, and every category reported.
    const settings = { modelName: 'claude-haiku-4-5', maxPagesPerFirm: 8, maxPageBytes: 1_000_000 } as const;
    // 8 pages × 12 000 characters is 96 000 characters. Real tokenizers give well under
    // one token per 2.5 characters for page text; this is that figure plus every extra.
    const reported = {
      inputTokens: 30_000,
      outputTokens: MAX_EXTRACTION_OUTPUT_TOKENS,
      cacheWriteTokens: 1_000,
      cacheReadTokens: 4_000,
    };
    expect(withinWorstCase(settings, reported)).toBe(true);
    // A cache write is *dearer* than an ordinary token, and priced as such.
    expect(centsOf('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 })).toBe(125);
    expect(centsOf('claude-haiku-4-5', { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 })).toBe(10);
    // And a run that did come in over the bound is recorded at what it cost, never
    // truncated: the ledger is the thing that would have to show the overrun.
    const over = { inputTokens: 10_000_000, outputTokens: 0 };
    expect(withinWorstCase(settings, over)).toBe(false);
    expect(centsOf('claude-haiku-4-5', over)).toBe(1_000);
  });
});
