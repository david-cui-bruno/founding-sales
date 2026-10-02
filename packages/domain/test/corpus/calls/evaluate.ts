import type { CallAnalysisResult, CallProposal, CallTranscriptUtterance } from '@fss/contracts';
import { readCallAnalysisAnswer } from '../../../calls/analysisModel.ts';
import { proposeEffects, type CallPolicyContext } from '../../../calls/analysisPolicy.ts';

/**
 * The C2 evaluation's scoring (slice 3a), shared by `scripts/callAnalysisEval.mjs`, which
 * records answers from the live model, and the corpus replay test, which scores the
 * recorded ones. One answer is read (`readCallAnalysisAnswer`), then proposed
 * (`proposeEffects`), then its proposals become labels; a run fails on any forbidden label
 * the case does not also expect.
 */

export interface CorpusExpectation {
  readonly expected_effects: readonly string[];
  readonly forbidden_effects: readonly string[];
}

export interface CorpusCase extends CorpusExpectation {
  readonly id: string;
  readonly n: number;
  readonly title: string;
  readonly firmName: string;
  readonly contactName: string | null;
  readonly callStartedAt: string;
  readonly callLocalTime: string;
  readonly firmTimeZone: string | null;
  readonly hasOpenOpportunity: boolean;
  readonly utterances: readonly CallTranscriptUtterance[];
  readonly expected_content: Readonly<Record<string, unknown>>;
  readonly with_open_opportunity?: CorpusExpectation;
}

/**
 * The labels a proposal set shows. An action kind offered for review only (the confirmer did
 * not confirm it) is `review:<kind>`: David decides it, so it is never an applied effect.
 */
export function effectLabels(proposals: readonly CallProposal[]): string[] {
  return proposals.map(proposal => {
    if ((proposal.kind === 'buying_signal' || proposal.kind === 'follow_up') && proposal.mode === 'review') return `review:${proposal.kind}`;
    switch (proposal.kind) {
      case 'outcome':
        return `outcome:${proposal.params.outcome}`;
      case 'callback':
        return `callback:${proposal.params.localDate}T${proposal.params.localTime}`;
      case 'task':
        return proposal.params.text.startsWith('Send overview to ') ? 'task:overview' : 'task:commitment';
      default:
        return proposal.kind;
    }
  });
}

function matches(pattern: string, label: string): boolean {
  return pattern.endsWith('*') ? label.startsWith(pattern.slice(0, -1)) : pattern === label;
}

export interface RunVerdict {
  readonly variant: string;
  readonly labels: readonly string[];
  /** Labels the case forbids and does not expect: any one fails the evaluation. */
  readonly forbidden: readonly string[];
  /** Expected labels that did not appear: a miss, not a failure. */
  readonly missing: readonly string[];
}

export function judge(variant: string, labels: readonly string[], expectation: CorpusExpectation): RunVerdict {
  const expected = new Set(expectation.expected_effects);
  return {
    variant,
    labels,
    forbidden: labels.filter(label => !expected.has(label) && expectation.forbidden_effects.some(pattern => matches(pattern, label))),
    missing: expectation.expected_effects.filter(label => !labels.includes(label)),
  };
}

/** Field agreement on content that triggers no action: [agreed, compared]. */
export function contentAgreement(result: CallAnalysisResult, expected: Readonly<Record<string, unknown>>): [number, number] {
  let agreed = 0;
  let compared = 0;
  for (const [field, expectedValue] of Object.entries(expected)) {
    // `{ "oneOf": [...] }`: more than one reading is right (who answered a referral, say).
    const alternatives =
      typeof expectedValue === 'object' && expectedValue !== null && !Array.isArray(expectedValue) && 'oneOf' in expectedValue
        ? ((expectedValue as { oneOf: unknown[] }).oneOf)
        : [expectedValue];
    const want = alternatives[0];
    compared += 1;
    let got: unknown;
    switch (field) {
      case 'reached':
        got = result.reached;
        break;
      case 'interest_level':
        got = result.interest.level;
        break;
      case 'follow_up_kind':
        got = result.followUpRequest?.kind ?? 'none';
        break;
      case 'stop_scope':
        got = result.stop?.scope ?? null;
        break;
      case 'voicemail_left':
        got = result.voicemailLeft;
        break;
      case 'objection_categories':
        got = (want as string[]).every(category => result.objections.some(objection => objection.category === category)) ? want : null;
        break;
      default:
        got = undefined;
    }
    if (field === 'objection_categories') {
      if (got !== null) agreed += 1;
    } else if (alternatives.some(alternative => JSON.stringify(got) === JSON.stringify(alternative))) agreed += 1;
  }
  return [agreed, compared];
}

export interface CaseScore {
  readonly caseId: string;
  readonly read: 'ok' | 'malformed' | 'schema_invalid';
  readonly verdicts: readonly RunVerdict[];
  readonly content: [number, number];
}

function contextOf(corpusCase: CorpusCase, hasOpenOpportunity: boolean): CallPolicyContext {
  return {
    callStartedAt: corpusCase.callStartedAt,
    firmTimeZone: corpusCase.firmTimeZone,
    contactName: corpusCase.contactName,
    hasOpenOpportunity,
  };
}

/**
 * Score one raw answer for one case: the base expectation, the open-opportunity variant
 * (the same answer, the policy run again with an open opportunity).
 */
export function scoreAnswer(corpusCase: CorpusCase, raw: string): CaseScore {
  const read = readCallAnalysisAnswer(raw, corpusCase.utterances);
  if (!read.ok) return { caseId: corpusCase.id, read: read.failure, verdicts: [], content: [0, 0] };
  const verdicts: RunVerdict[] = [];
  const base = proposeEffects(read.result, contextOf(corpusCase, corpusCase.hasOpenOpportunity));
  verdicts.push(judge('base', effectLabels(base.proposals), corpusCase));
  if (corpusCase.with_open_opportunity !== undefined) {
    const open = proposeEffects(read.result, contextOf(corpusCase, true));
    verdicts.push(judge('open_opportunity', effectLabels(open.proposals), corpusCase.with_open_opportunity));
  }
  return {
    caseId: corpusCase.id,
    read: 'ok',
    verdicts,
    content: contentAgreement(read.result, corpusCase.expected_content),
  };
}
