import { callAnalysisResponseSchema, callAnalysisResultSchema, reviewListResponseSchema, type CallProposal, type ReviewItem } from '@fss/contracts';

/**
 * Analysis answers as `GET /calls/analysis` and `GET /review` send them (slice 3a): the same
 * shapes the API's own tests parse, built here once so a desktop test and the contract cannot
 * drift. No real person, firm or number: the numbers are in the NANP 555-01XX block.
 */

export const SESSION_ID = '11111111-1111-4111-8111-1111111111aa';
export const OTHER_SESSION_ID = '22222222-2222-4222-8222-2222222222bb';
export const ANALYSIS_ID = '33333333-3333-4333-8333-3333333333cc';
export const FIRM_ID = '44444444-4444-4444-8444-4444444444dd';
export const SHA = 'a'.repeat(64);
export const HASH = 'b'.repeat(64);
export const TASK_KEY = 'task:0123456789abcdef';

const ref = (quote: string, side: 'you' | 'them' = 'them', line = 2) => ({ line, side, start: 4, end: 9, quote });

export const QUOTES = {
  outcome: ref('Sure, tell me more'),
  callback: ref('Call me Tuesday at 2'),
  followUp: ref('Could you send me an overview by email?'),
  buying: ref('We want to try it on our own portfolio'),
  stop: ref('Take us off your list'),
  task: ref("I'll send you the pricing sheet today", 'you', 4),
  number: ref('Wrong number, try 617 555 0199'),
  phrase: ref('Call me after lunch'),
};

export const PROPOSALS = {
  outcome: {
    key: 'outcome',
    kind: 'outcome',
    mode: 'apply',
    reason: 'They talked it through and asked for more.',
    params: { outcome: 'interested', evidence: [QUOTES.outcome] },
  },
  stopOutcome: {
    key: 'outcome',
    kind: 'outcome',
    mode: 'apply',
    reason: 'They asked not to be called.',
    params: { outcome: 'do_not_call', evidence: [QUOTES.stop] },
  },
  callback: {
    key: 'callback',
    kind: 'callback',
    mode: 'apply',
    reason: 'They gave a day and a time.',
    params: { localDate: '2026-10-06', localTime: '14:00', dueAt: '2026-10-06T18:00:00.000Z', sourceTimeZone: 'America/New_York', evidence: [QUOTES.callback] },
  },
  followUp: {
    key: 'follow_up',
    kind: 'follow_up',
    mode: 'apply',
    reason: 'They asked for an overview.',
    params: { requestKind: 'overview_email', evidence: [QUOTES.followUp] },
  },
  buyingSignal: {
    key: 'buying_signal',
    kind: 'buying_signal',
    mode: 'apply',
    reason: 'They want to evaluate Callie.',
    params: { evidence: [QUOTES.buying] },
  },
  task: {
    key: TASK_KEY,
    kind: 'task',
    mode: 'apply',
    reason: 'You promised something.',
    params: { text: 'Send the pricing sheet', quote: QUOTES.task.quote, duePhrase: 'today', evidence: [QUOTES.task] },
  },
  correctedNumber: {
    key: 'corrected_number',
    kind: 'corrected_number',
    mode: 'review',
    reason: 'They said the number is wrong and gave another.',
    params: { spokenNumber: '617 555 0199', evidence: [QUOTES.number] },
  },
  zoneUnknown: {
    key: 'callback_zone_unknown',
    kind: 'callback_zone_unknown',
    mode: 'review',
    reason: 'A callback with no time zone to place it in.',
    params: { phrase: QUOTES.phrase.quote, evidence: [QUOTES.phrase] },
  },
  stopScope: {
    key: 'stop_scope',
    kind: 'stop_scope',
    mode: 'review',
    reason: 'They asked to stop; who it covers is unclear.',
    params: { spokenScope: 'unclear', evidence: [QUOTES.stop] },
  },
  referral: {
    key: 'referral_contact',
    kind: 'referral_contact',
    mode: 'review',
    reason: 'They pointed to a colleague.',
    params: { name: 'Sam Placeholder', role: 'Operations', evidence: [ref('Talk to Sam Placeholder in operations')] },
  },
  stopWithEmail: {
    key: 'stop_with_email',
    kind: 'stop_with_email',
    mode: 'review',
    reason: 'They asked to stop calling but to send an e-mail.',
    params: { requestKind: 'overview_email', evidence: [QUOTES.stop] },
  },
  outcomeUnclear: {
    key: 'outcome_unclear',
    kind: 'outcome_unclear',
    mode: 'review',
    reason: 'The call did not settle on an outcome.',
    params: { evidence: [ref('Hm, maybe')] },
  },
} satisfies Record<string, CallProposal>;

export function resultOf() {
  return callAnalysisResultSchema.parse({
    reached: 'person',
    summary: 'You reached Dana. She asked for an overview.',
    facts: [{ text: 'Twelve properties.', ref: { line: 2, side: 'them', start: 4, end: 9 } }],
    interest: { level: 'curious', signals: [] },
    objections: [],
    followUpRequest: null,
    callback: null,
    stop: null,
    wrongNumber: null,
    referral: null,
    voicemailLeft: false,
    commitments: [],
    coaching: null,
    stopPhrases: [],
    dropped: {},
  });
}

export interface AnalysisOptions {
  readonly proposals?: readonly CallProposal[];
  readonly state?: 'completed' | 'pending' | 'failed';
  readonly summary?: string;
  readonly facts?: readonly string[];
}

/** `GET /calls/analysis`, parsed with the contract's own schema. */
export function analysisAnswer(options: AnalysisOptions = {}) {
  const state = options.state ?? 'completed';
  const proposals = options.proposals ?? [PROPOSALS.outcome, PROPOSALS.callback, PROPOSALS.followUp, PROPOSALS.buyingSignal, PROPOSALS.task];
  return callAnalysisResponseSchema.parse({
    callSessionId: SESSION_ID,
    current:
      state === 'completed'
        ? { analysisId: ANALYSIS_ID, version: 1, origin: 'model', notes: { summary: options.summary ?? 'You reached Dana. She asked for an overview.', facts: options.facts ?? ['Twelve properties.'] } }
        : null,
    notesVersion: state === 'completed' ? 1 : null,
    authoritative:
      state === 'completed'
        ? { analysisId: ANALYSIS_ID, version: 1, transcriptSha256: SHA, proposalHash: HASH, policyVersion: 'call_policy.5', proposals, result: resultOf() }
        : null,
    pending: state === 'pending' ? { analysisId: ANALYSIS_ID, version: 1, createdAt: '2026-10-02T14:00:00.000Z' } : null,
    failure: state === 'failed' ? { analysisId: ANALYSIS_ID, version: 1, reason: 'schema_invalid' } : null,
    versions: [
      {
        analysisId: ANALYSIS_ID,
        version: 1,
        origin: 'model',
        state,
        requestedReason: 'transcript',
        model: 'claude-haiku-4-5-20251001',
        transcriptSha256: SHA,
        failureReason: state === 'failed' ? 'schema_invalid' : null,
        createdAt: '2026-10-02T14:00:00.000Z',
        completedAt: state === 'pending' ? null : '2026-10-02T14:01:00.000Z',
      },
    ],
  });
}

/** `GET /review`, parsed with the contract's own schema. */
export function reviewAnswer(items: readonly object[]) {
  return reviewListResponseSchema.parse({ items });
}

export function proposalItem(proposal: CallProposal, extra: Partial<Extract<ReviewItem, { source: 'proposal' }>> = {}): Extract<ReviewItem, { source: 'proposal' }> {
  return {
    source: 'proposal',
    reviewKind: proposal.kind,
    analysisId: ANALYSIS_ID,
    version: 1,
    proposalHash: HASH,
    callSessionId: SESSION_ID,
    firmId: FIRM_ID,
    proposal,
    completedAt: '2026-10-02T14:01:00.000Z',
    ...extra,
  };
}

export const HOLD_ITEM: ReviewItem = {
  source: 'pending_hold',
  holdId: '55555555-5555-4555-8555-5555555555ee',
  callSessionId: SESSION_ID,
  firmId: FIRM_ID,
  openedAt: '2026-10-02T09:00:00.000Z',
};

export const STAGE_ITEM: ReviewItem = {
  source: 'stage',
  itemId: '66666666-6666-4666-8666-6666666666ff',
  firmId: FIRM_ID,
  opportunityId: null,
  evidenceKind: 'meeting.booked',
  reason: 'no_matching_rule',
  createdAt: '2026-10-02T09:00:00.000Z',
};
