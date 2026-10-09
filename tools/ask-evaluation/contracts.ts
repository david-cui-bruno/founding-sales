/**
 * #492 evaluation-local contracts — frozen by the integration owner after #491.
 * Derived from plan c8a plus root-approved vector grouping amendment; primary plan SHA256
 * 21493a2672b49d6543fed0138a5ecace53ec21ec03944f89a3711fbb09e196cf.
 * No production contract export, migration, granting adapter or real call.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  askReadSchema,
  askResponseSchema,
  canonicalSourceReferenceSchema,
} from '@fss/contracts';

const fixtureId = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/u);
const version = z.string().min(1).max(100);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const gitCommit = z.string().regex(/^[a-f0-9]{40}$/u);
const finite = z.number().finite();
const count = z.number().int().min(0).max(1_000_000);
// Observed time may exceed a deadline when scheduling is delayed; never clamp evidence.
const milliseconds = finite.min(0).max(Number.MAX_SAFE_INTEGER);
const ratio = finite.min(0).max(1);
const sourceKind = canonicalSourceReferenceSchema.shape.kind;
export const categorySchema = z.enum([
  'exact_state', 'topic', 'identity', 'citation', 'evidence_quality',
  'access_lifecycle', 'injection', 'operations',
]);
export const failureCodeSchema = z.enum([
  'unauthenticated', 'source_unavailable', 'source_changed', 'access_refused',
  'audit_refused', 'canonical_quote_mismatch', 'unknown_citation',
  'unsupported_claim', 'exact_state_mismatch', 'unexpected_mutation',
  'duplicate_publication', 'corpus_bound', 'truncated_baseline',
  'manifest_mismatch', 'invalid_adapter_output', 'invalid_vector',
  'vector_dimension_mismatch', 'vector_zero_norm', 'vector_overflow',
  'call_limit', 'token_limit', 'spend_limit', 'case_timeout', 'run_timeout',
  'adapter_unavailable', 'unknown_acceptance', 'real_purpose_unverified',
]);
export const stageSchema = z.enum([
  'manifest', 'fixture', 'baseline', 'canonical_read', 'embedding',
  'vector_sql', 'fusion', 'answer', 'final_read', 'scoring', 'report',
]);
const failureSchema = z.strictObject({ code: failureCodeSchema, stage: stageSchema });

// Reuse product source identity; do not invent an evaluation ACL/source format.
export const evaluationSourceSchema = canonicalSourceReferenceSchema.extend({
  contentHash: sha256,
  locator: z.string().min(1).max(200),
  availability: z.literal('available'),
  completeness: z.enum(['selected_excerpt', 'complete', 'partial']),
}).strict();
export const frozenWindowSchema = z.strictObject({
  id: fixtureId,
  source: evaluationSourceSchema,
  textSha256: sha256,
  chunkerVersion: z.literal('lexical-original-v1'),
  ordinal: z.number().int().min(0).max(999),
});
export const sourceFixtureSchema = z.strictObject({
  id: fixtureId,
  kind: sourceKind,
  // Closed recipes only; no arbitrary SQL/script/credential/file path in manifest.
  setupId: z.enum(['synthetic_selected_note', 'synthetic_copied_mail',
    'synthetic_call_transcript', 'synthetic_meeting_transcript']),
  originalSha256: sha256,
  windows: z.array(frozenWindowSchema).min(1).max(1000),
});
const goldClaimSchema = z.strictObject({
  id: fixtureId,
  acceptableTextVariants: z.array(z.string().min(1).max(2000)).min(1).max(10),
  supportedBy: z.array(fixtureId).min(1).max(50),
  forbiddenTextVariants: z.array(z.string().min(1).max(2000)).max(10),
});
export const expectedRefusalSchema = z.strictObject({stage:z.enum(['canonical_read','final_read']),
 code:z.literal('source_unavailable'),scenario:z.enum(['delete_before','delete_during','revision_during','reassign_during','audit_refusal'])});
export const labeledCaseSchema = z.strictObject({
  id: fixtureId,
  category: categorySchema,
  actorFixtureId: fixtureId,
  corpusId: fixtureId,
  request: askReadSchema,
  relevance: z.array(z.strictObject({ windowId: fixtureId,
    grade: z.union([z.literal(0), z.literal(1), z.literal(2)]) })).max(1000),
  acceptableClaims: z.array(goldClaimSchema).max(50),
  mustAbstain: z.boolean(),
  exactExpected: askResponseSchema.nullable(),
  labelVersion: version,
  labelAuthoringState: z.literal('independent_before_candidate_outputs'),
  expectedRefusal: expectedRefusalSchema.nullable().optional(),
  lifecycleScenario: z.enum(['none', 'delete_before', 'delete_during',
    'reassign_during', 'revision_during', 'audit_refusal']),
});
export const frozenCorpusSchema = z.strictObject({
  id: fixtureId,
  fixtureVersion: version,
  sources: z.array(sourceFixtureSchema).min(1).max(10),
  cases: z.array(labeledCaseSchema).min(1).max(120),
  corpusSha256: sha256,
});
export const frozenSplitSchema = z.strictObject({
  developmentCaseIds: z.array(fixtureId).length(80),
  holdoutCaseIds: z.array(fixtureId).length(40),
  labelSha256: sha256,
  splitSha256: sha256,
});
export const envelopeSchema = z.strictObject({
  version: z.literal('synthetic-orchestration-v1'),
  criticalFailureCeiling: z.literal(0),
  exactMismatchCeiling: z.literal(0),
  canonicalCitationFailureCeiling: z.literal(0),
  duplicatePublicationCeiling: z.literal(0),
  maxCallsPerRun: z.literal(5000),
  maxInputTokensPerRun: z.literal(1_000_000),
  maxOutputTokensPerRun: z.literal(100_000),
  maxSpendCents: z.literal(0),
  maxCaseWallTimeMs: z.literal(10_000),
  maxRunWallTimeMs: z.literal(600_000),
  maxWindowsPerCorpus: z.literal(1000),
  maxScoredWindowsPerCorpus: z.literal(50),
  maxSourcesPerCorpus: z.literal(10),
});
export const candidateSchema = z.strictObject({
  // Closed fake identities; claiming a vendor ID cannot grant real access.
  embeddingId: z.literal('fake_embedding'),
  embeddingVersion: version,
  dimensions: z.number().int().min(1).max(4096),
  answerId: z.literal('fake_answer'),
  answerVersion: version,
  vectorMetric: z.literal('cosine'),
  fusion: z.literal('rrf'),
  rrfConstant: z.literal(60),
  k: z.literal(10),
  textConfiguration: z.literal('simple'),
});
export const frozenManifestSchema = z.strictObject({
  version: z.literal('ask-evaluation-v1'),
  mode: z.enum(['fake_only', 'real_pending']),
  corpusSha256: sha256,
  splitSha256: sha256,
  sourceManifestSha256: sha256,
  chunkerVersion: z.literal('lexical-original-v1'),
  dedupUnit: z.literal('trim_whitespace_lowercase_en_us_text_group'),
  lexicalRank: z.literal('first_matched_window_source_order_not_relevance'),
  refWindowMappingSha256: sha256,
  baselineSourceCommit: gitCommit,
  candidate: candidateSchema,
  envelope: envelopeSchema,
  configurationSha256: sha256,
});
export const permittedWindowSchema = z.strictObject({
  id: fixtureId,
  source: evaluationSourceSchema,
  text: z.string().min(1).max(2000), // UTF16; aggregate UTF8 checks below
});
export const usageSchema = z.discriminatedUnion('outcome', [
  z.strictObject({ outcome: z.literal('observed'), calls: count.max(5000),
    inputTokens: count, outputTokens: count.max(100_000),
    reservedCents: z.literal('0'), observedCents: z.literal('0') }),
  z.strictObject({ outcome: z.literal('unknown'), calls: count.max(5000),
    inputTokens: count, outputTokens: count.max(100_000),
    reservedCents: z.literal('0'), observedCents: z.null() }),
]);
export const purposeGateSchema = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('fake_only'),
    purpose: z.literal('crm_retrieval_evaluation'), realCallsAllowed: z.literal(false),
    maxSpendCents: z.literal(0), reason: z.literal('fake_only') }),
  z.strictObject({ state: z.literal('real_unavailable'),
    purpose: z.literal('crm_retrieval_evaluation'), realCallsAllowed: z.literal(false),
    maxSpendCents: z.literal(0), reason: z.literal('purpose_configuration_unverified') }),
]);

// Shared vector/fusion contracts. IDs are join keys, never source permissions.
export const evidenceGroupSchema = z.strictObject({
  groupId: fixtureId,
  textSha256: sha256,
  firstOrdinal: z.number().int().min(0).max(999),
  windowIds: z.array(fixtureId).min(1).max(1000),
});
export const vectorSchema = z.array(finite).min(1).max(4096);
export const embeddingOutputSchema = z.strictObject({
  vectors: z.array(z.strictObject({ id: fixtureId, vector: vectorSchema })).max(1000),
  usage: usageSchema,
});
export const queryEmbeddingOutputSchema = z.strictObject({
  vector: vectorSchema,
  usage: usageSchema,
});
export const answerOutputSchema = z.strictObject({
  claims: z.array(z.strictObject({ text: z.string().min(1).max(2000),
    windowIds: z.array(fixtureId).min(1).max(50) })).max(50),
  abstained: z.boolean(),
  usage: usageSchema,
});
export const rankedGroupSchema = z.strictObject({
  groupId: fixtureId,
  rank: z.number().int().min(1).max(1000),
  windowIds: z.array(fixtureId).min(1).max(1000),
  firstOrdinal: z.number().int().min(0).max(999),
  score: finite.nullable(), // lexical source-ordered rank has no relevance score
});
export const candidateRankingSchema = z.strictObject({
  path: z.enum(['lexical', 'fake_exact_vector', 'fake_hybrid']),
  dedupUnit: z.literal('trim_whitespace_lowercase_en_us_text_group'),
  ranked: z.array(rankedGroupSchema).max(50),
  durationMs: milliseconds,
  qualityScoringState: z.enum(['scored', 'censored_source_or_result_cap', 'failed']),
  failures: z.array(failureSchema).max(100),
});
export const rankingInputSchema = z.strictObject({
  mode: z.literal('fake_only'),
  dimensions: z.number().int().min(1).max(4096),
  k: z.literal(10),
  rrfConstant: z.literal(60),
  windows: z.array(z.strictObject({ id: fixtureId,
    ordinal: z.number().int().min(0).max(999),
    text: z.string().min(1).max(2000) })).min(1).max(1000),
  embeddings: z.array(z.strictObject({ id: fixtureId, vector: vectorSchema })).min(1).max(1000),
  queryVector: vectorSchema,
  lexicalGroupRanks: z.array(z.strictObject({ groupId: fixtureId,
    rank: z.number().int().min(1).max(50) })).max(50),
});
export const rankingOutputSchema = z.strictObject({
  vector: candidateRankingSchema,
  hybrid: candidateRankingSchema,
  groups: z.array(evidenceGroupSchema).max(1000),
  rawWindowScores: z.array(z.strictObject({ windowId: fixtureId,
    score: finite.min(-1).max(1) })).max(1000),
  sqlBounds: z.strictObject({ inputWindows: z.number().int().min(0).max(1000),
    dimensions: z.number().int().min(1).max(4096),
    returnedVectorGroups: z.number().int().min(0).max(10),
    returnedHybridGroups: z.number().int().min(0).max(10) }),
  sqlObservation: z.strictObject({
    state: z.enum(['executed', 'refused_before_sql', 'failed_during_sql']),
    elapsedMs: milliseconds,
    statementsExecuted: z.number().int().min(0).max(20),
    inputRows: z.number().int().min(0).max(1000),
    evaluatedWindowScores: z.number().int().min(0).max(1000),
    // Algorithmic work observations; do NOT claim measured server CPU/load.
    databaseLoad: z.discriminatedUnion('state', [
      z.strictObject({ state: z.literal('not_measured') }),
      z.strictObject({ state: z.literal('measured'),
        concurrentConnections: z.number().int().min(0).max(10000),
        sampleCount: z.number().int().min(1).max(1000) }),
    ]),
  }),
});
export const measurementSchema = z.strictObject({
  controlOutcome:z.enum(['not_applicable','passed','failed','unverified']).optional(),
  expectedRefusal:expectedRefusalSchema.nullable().optional(),
  publishedClaimCount:count.optional(),publishedCitationCount:count.optional(),prohibitedPublication:z.boolean().optional(),
  caseId: fixtureId,
  category: categorySchema,
  path: z.enum(['exact_sql', 'lexical', 'fake_exact_vector', 'fake_hybrid', 'fake_answer']),
  recallAt10: ratio.nullable(), precisionAt10: ratio.nullable(), ndcgAt10: ratio.nullable(),
  supportedClaims: count, unsupportedClaims: count, unjudgedClaims: count,
  claimEvaluationState: z.enum(['no_claims', 'closed_gold_variants_checked',
    'pending_human_adjudication']),
  claimJudgments: z.array(z.strictObject({
    claimIndex: z.number().int().min(0).max(49),
    verdict: z.enum(['supported', 'unsupported', 'unjudged_unknown_paraphrase']),
    matchedGoldClaimId: fixtureId.nullable(),
  })).max(50),
  validCitations: count, invalidCitations: count,
  abstained: z.boolean(), durationMs: milliseconds,
  qualityScoringState: z.enum(['scored', 'censored_source_or_result_cap', 'failed']),
  finalReadObservations: z.array(z.strictObject({ windowId: fixtureId,
    observedAt: z.iso.datetime(), state: z.enum(['available', 'unavailable']) })).max(1000),
  usage: usageSchema,
  failures: z.array(failureSchema).max(100),
});
export const reportSchema = z.strictObject({
  manifestSha256: sha256,
  baselineMeasured: z.boolean(),
  realVectorMeasured: z.literal(false), realModelMeasured: z.literal(false),
  syntheticOrchestrationPassed: z.boolean(),
  syntheticControlsPassed:z.boolean().optional(),
  criticalControlFailureCount:count.optional(),expectedRefusalCount:count.optional(),
  modelEvaluationState: z.enum(['not_run', 'fake_only_complete',
    'fake_only_unjudged_claims']),
  caseResults: z.array(measurementSchema).max(600),
  categorySummaries: z.array(z.strictObject({ category: categorySchema,
    caseCount: count.max(120), failures: count,
    p50Ms: milliseconds.nullable(), p95Ms: milliseconds.nullable() })).max(8),
  realQualityState: z.literal('pending_verified_purpose_budget_and_preregistration'),
  activationAllowed: z.literal(false),
});

/** Each isolated case binds its own live fixture corpus; no mutation contaminates another. */
export const caseBindingSchema = z.strictObject({caseId:fixtureId, split:z.enum(['development','holdout']),
  corpusSha256:sha256, sourceManifestSha256:sha256, labelSha256:sha256});
export const frozenSuiteSchema = z.strictObject({version:z.literal('ask-evaluation-suite-v1'),
  suiteId:fixtureId, fixtureVersion:version, caseBindings:z.array(caseBindingSchema).length(120),
  split:frozenSplitSchema, suiteSha256:sha256});
export const developmentSuiteSchema = z.strictObject({version:z.literal('ask-evaluation-development-v1'),
  suiteId:fixtureId, fixtureVersion:version, caseBindings:z.array(caseBindingSchema.extend({split:z.literal('development')})).length(80),
  labelSha256:sha256, suiteSha256:sha256});
export type FrozenSuite = z.infer<typeof frozenSuiteSchema>;
export type DevelopmentSuite = z.infer<typeof developmentSuiteSchema>;

export type FrozenManifest = z.infer<typeof frozenManifestSchema>;
export type FrozenCorpus = z.infer<typeof frozenCorpusSchema>;
export type FrozenSplit = z.infer<typeof frozenSplitSchema>;
export type LabeledCase = z.infer<typeof labeledCaseSchema>;
export type PermittedWindow = z.infer<typeof permittedWindowSchema>;
export type EvaluationUsage = z.infer<typeof usageSchema>;
export type EvidenceGroup = z.infer<typeof evidenceGroupSchema>;
export type CandidateRanking = z.infer<typeof candidateRankingSchema>;
export type EvaluationReport = z.infer<typeof reportSchema>;

export interface EvaluationEmbeddingAdapter {
  readonly kind: 'fake'; readonly id: 'fake_embedding'; readonly version: string;
  readonly dimensions: number;
  embed(input: readonly PermittedWindow[], signal: AbortSignal):
    Promise<z.infer<typeof embeddingOutputSchema>>;
  embedQuery(query: string, signal: AbortSignal):
    Promise<z.infer<typeof queryEmbeddingOutputSchema>>;
}
export interface EvaluationAnswerAdapter {
  readonly kind: 'fake'; readonly id: 'fake_answer'; readonly version: string;
  answer(input: {query: string; windows: readonly PermittedWindow[]}, signal: AbortSignal):
    Promise<z.infer<typeof answerOutputSchema>>;
}
export type EvaluationRankingInput = z.infer<typeof rankingInputSchema>;
export type EvaluationRankingOutput = z.infer<typeof rankingOutputSchema>;
export interface EvaluationVectorPort {
  /** All<=1000 cosine scores BEFORE top10 GROUPS; max member score per group.
   * Own short disposablePG TX/TEMP cleanup only, no callbacks/provider/source ACL.
   */
  rank(input: EvaluationRankingInput): Promise<EvaluationRankingOutput>;
}
export interface EvaluationFusionPort {
  /** Contribution once/group/list; absent rank0; ties firstOrdinal then groupId. */
  fuse(input: {lexical: CandidateRanking; vector: CandidateRanking;
    groups: readonly EvidenceGroup[]; rrfConstant: 60; k: 10}): CandidateRanking;
}

/**
 * Required relational validations at manifest/runner boundary before adapter calls:
 * - Distinct fixture/source/window/case/group IDs; refs/locators map exactly one
 *   expected original hash/window; source kind matches closed setup recipe.
 * - <=1000 total windows/corpus, <=10 distinct sources; <=50 windows for scored
 *   corpus, UTF8 <=80000/source and <=800000/corpus. Public lexical result must
 *   be complete/untruncated or metrics null/censored, never invented missed hits.
 * - Unique split IDs, disjoint80/40 partition of exact120 case set; all categories
 *   and all4 source kinds represented in both splits; holdout separate sources,
 *   originals and identities. Development runner cannot receive holdout labels.
 * - All gold/relevance/citation IDs known; independent gold text variants plus
 *   support checked, never support merely because citation exists. Unknown claim
 *   paraphrase is unjudged/pending, not automatically supported.
 * - Exact cases use existing AskRead/AskResponse; no semantic replacement for SQL.
 * - Exact dimension match, finite inputs AND intermediates/results, no zero norm,
 *   duplicates, invented vector IDs, mismatched group membership or rank IDs.
 * - Ranked IDs unique/contiguous; all window scores before grouping, group max
 *   member score, ties earliest frozen ordinal then opaque group ID; cosine [-1,1],
 *   lexical scores null; RRF contributes once/group/list, absent rank0,60 fixed.
 *   Preserve all member window IDs and raw window observations, not top10 windows.
 *   Group ID/mapping derives from the shared frozen normalization/hash rule;
 *   vector output contains no original canonical authority or text publication. Report mode is fake only.
 * - Observed/unknown usage counts against cumulative run limits; unknown holds
 *   full reservation. No real gate exists; timeout/output failure is not absence.
 * - Final public reads are per-window current observations, NOT atomic batch proof.
 *   No new ACL implementation or new production authority/endpoint/schema.
 * - Failed/censored cases have null quality metrics; every failure reported.
 *   Ratios/latencies/costs are measured fields, never fabricated defaults.
 * - Real quality thresholds require separately root-approved preregistration AFTER
 *   development baseline but BEFORE sealed holdout/candidate scoring; pending now.
 *
 * Ownership proposal after #491 closure and root freeze:
 * - Root: tools/ask-evaluation/contracts.ts (this proposed local schema), purpose
 *   gate and canonical-window/dedup mapping interfaces. No @fss/contracts export.
 * - Corpus/runner lane: tools/ask-evaluation/{corpus,labels,runner,report}.ts plus
 *   harness/public lifecycle tests. Synthetic recipes use actual public writes or
 *   approved external fixture setup; assertions via public API/runner results.
 * - Vector lane: tools/ask-evaluation/{vectors,fusion,fakeAdapters}.ts, bounded TEMP
 *   float8[] exact cosine with injected real disposablePG, no corpus/labels/ACL.
 * - Tests: real authenticated /ask/read and /crm/processing/source/read; exported
 *   runEvaluation entry with real disposablePG/fake boundary adapters; exported
 *   vector port on realPG for worked literal vectors/overflow/dimension rejection.
 * - Initial corpus120 cases80development40holdout; all4 source kinds. Claims and
 *   rankings independent literals authored before candidate output; no user data.
 */

/** Same lexical text-group unit: normalization never changes canonical source text. */
export function evaluationTextGroupId(text: string): string {
  const normalized = text.trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
  return `g_${createHash('sha256').update(normalized).digest('hex')}`;
}

/** Opaque groups retain every citation and frozen encounter ordinal. */
export function groupEvaluationWindows(windows: EvaluationRankingInput['windows']): EvidenceGroup[] {
  const ids = new Set<string>();
  const ordinals = new Set<number>();
  const groups = new Map<string, EvidenceGroup>();
  for (const window of windows) {
    if (ids.has(window.id) || ordinals.has(window.ordinal)) throw new RangeError('duplicate evaluation window');
    ids.add(window.id); ordinals.add(window.ordinal);
    const groupId = evaluationTextGroupId(window.text);
    const previous = groups.get(groupId);
    if (previous) {
      previous.windowIds.push(window.id);
      previous.firstOrdinal = Math.min(previous.firstOrdinal, window.ordinal);
    } else {
      groups.set(groupId, { groupId, textSha256: groupId.slice(2), windowIds: [window.id], firstOrdinal: window.ordinal });
    }
  }
  return [...groups.values()].sort((a,b) => a.firstOrdinal-b.firstOrdinal || a.groupId.localeCompare(b.groupId));
}
