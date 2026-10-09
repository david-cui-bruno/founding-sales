import type { DevelopmentLabelTemplate } from "./labels.ts";
import { readFile } from "node:fs/promises";
import { evaluationFusion } from "./fusion.ts";
import {
  createFakeEvaluationEmbedding,
  createFakeEvaluationAnswer,
} from "./fakeAdapters.ts";
import { performance } from "node:perf_hooks";
import { askResponseSchema, crmResolvedSourceSchema } from "@fss/contracts";
import type {
  FrozenCorpus,
  FrozenManifest,
  EvaluationReport,
  DevelopmentSuite,
  EvaluationGuard,
  FakeCandidateExecution,
  EvaluationVectorPort,
  EvaluationRankingOutput,
  EvaluationUsage,
  PermittedWindow,
} from "./contracts.ts";
import {
  developmentSuiteSchema,
  fakeCandidateDecisionSchema,
  fakeCandidateScriptSchema,
  fakeCandidateExecutionSchema,
  frozenManifestSchema,
  embeddingOutputSchema,
  queryEmbeddingOutputSchema,
  rankingOutputSchema,
  guardConfigurationSchema,
  answerOutputSchema,
  groupEvaluationWindows,
  evaluationTextGroupId,
} from "./contracts.ts";
import {
  evaluationHash,
  originalTextHash,
  validateDevelopment,
  coversOriginalExtent,
  validateFrozenCorpus,
} from "./corpus.ts";
import { baselineReport, type CaseMeasurement } from "./report.ts";

class EvaluationTimeout extends Error {
  constructor(
    readonly code: "case_timeout" | "run_timeout",
    readonly stage: CaseMeasurement["failures"][number]["stage"],
  ) {
    super(code);
  }
}
class EvaluationRefusal extends Error {
  constructor(
    readonly code: CaseMeasurement["failures"][number]["code"],
    readonly stage: CaseMeasurement["failures"][number]["stage"],
  ) {
    super(code);
  }
}
async function awaitEvaluationStage<T>(
  manifest: FrozenManifest,
  started: number,
  runStarted: number,
  stage: CaseMeasurement["failures"][number]["stage"],
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const caseDeadline = started + manifest.envelope.maxCaseWallTimeMs;
  const runDeadline = runStarted + manifest.envelope.maxRunWallTimeMs;
  const deadline = Math.min(caseDeadline, runDeadline);
  const timeout = () =>
    new EvaluationTimeout(
      performance.now() >= runDeadline ? "run_timeout" : "case_timeout",
      stage,
    );
  const remaining = deadline - performance.now();
  if (remaining <= 0) throw timeout();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const response = await Promise.race([
      work(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(timeout()), remaining);
      }),
    ]);
    if (performance.now() >= deadline) throw timeout();
    return response;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    controller.abort();
  }
}
/** Score the full frozen permitted group census; duplicate hits count once before top ten. */
function scoreRetrievalGroups(
  groups: readonly { groupId: string; windowIds: readonly string[] }[],
  relevance: FrozenCorpus["cases"][number]["relevance"],
  orderedGroupIds: readonly string[],
): Pick<CaseMeasurement, "recallAt10" | "precisionAt10" | "ndcgAt10"> {
  const grades = new Map(
    groups.map((group) => [
      group.groupId,
      Math.max(
        0,
        ...relevance
          .filter((label) => group.windowIds.includes(label.windowId))
          .map((label) => label.grade),
      ),
    ]),
  );
  const selected = [...new Set(orderedGroupIds)].slice(0, 10);
  const relevant = [...grades.values()].filter((grade) => grade > 0).length;
  const hits = selected.filter((id) => (grades.get(id) ?? 0) > 0).length;
  const dcg = (values: readonly number[]) =>
    values.reduce(
      (sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2),
      0,
    );
  const ideal = dcg([...grades.values()].sort((a, b) => b - a).slice(0, 10));
  return {
    recallAt10: relevant === 0 ? null : hits / relevant,
    precisionAt10: selected.length === 0 ? null : hits / selected.length,
    ndcgAt10:
      ideal === 0
        ? null
        : dcg(selected.map((id) => grades.get(id) ?? 0)) / ideal,
  };
}
export interface EvaluationPublicReads {
  read(
    actorFixtureId: string,
    path: "/ask/read" | "/crm/processing/source/read",
    body: unknown,
  ): Promise<{ status: number; body: unknown }>;
}
export interface DevelopmentEvaluationInput {
  phase: "development_baseline";
  manifest: FrozenManifest;
  development: FrozenCorpus;
  publicReads: EvaluationPublicReads;
}
export interface GuardEvaluationInput extends Omit<
  DevelopmentEvaluationInput,
  "phase"
> {
  phase: "guard_only";
  guard: EvaluationGuard;
}
export type EvaluationInput = DevelopmentEvaluationInput | GuardEvaluationInput;
export async function runEvaluation(
  input: EvaluationInput,
): Promise<EvaluationReport> {
  return runBoundedEvaluation(input, performance.now());
}
async function runBoundedEvaluation(
  input: EvaluationInput,
  runStarted: number,
  candidatePrefix?: "dev_" | "holdout_",
  caseStartedOverride?: number,
): Promise<EvaluationReport> {
  if (input.phase !== "development_baseline" && input.phase !== "guard_only")
    throw new RangeError("manifest_mismatch");
  const { manifest, corpus, windows } =
    candidatePrefix === undefined
      ? validateDevelopment({ ...input, phase: "development_baseline" })
      : validateFrozenCorpus(input, candidatePrefix);
  const guard = input.phase === "guard_only" ? input.guard : null;
  const config =
    guard === null
      ? null
      : guardConfigurationSchema.parse({
          purpose: guard.purpose,
          reservation: guard.reservation,
          priorUsage: guard.priorUsage,
        });
  const results: CaseMeasurement[] = [];
  let guardUsage = config === null ? null : structuredClone(config.priorUsage);
  for (const item of corpus.cases) {
    const started = caseStartedOverride ?? performance.now();
    const result: CaseMeasurement = {
      caseId: item.id,
      category: item.category,
      path: "lexical",
      recallAt10: null,
      precisionAt10: null,
      ndcgAt10: null,
      supportedClaims: 0,
      unsupportedClaims: 0,
      unjudgedClaims: 0,
      claimEvaluationState: "no_claims",
      claimJudgments: [],
      validCitations: 0,
      invalidCitations: 0,
      abstained: false,
      durationMs: 0,
      qualityScoringState: "failed",
      finalReadObservations: [],
      usage: {
        outcome: "observed",
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reservedCents: "0",
        observedCents: "0",
      },
      failures: [],
      controlOutcome: "unverified",
      expectedRefusal: item.expectedRefusal ?? null,
      publishedClaimCount: 0,
      publishedCitationCount: 0,
      prohibitedPublication: false,
    };
    const fail = (
      code: CaseMeasurement["failures"][number]["code"],
      stage: CaseMeasurement["failures"][number]["stage"],
    ) => {
      if (
        !result.failures.some(
          (failure) => failure.code === code && failure.stage === stage,
        )
      )
        result.failures.push({ code, stage });
    };
    const permitted: { id: string; ordinal: number; text: string }[] = [];
    const observed = new Map<string, { extent: number; text: string }>();
    const awaitStage = <T>(
      stage: CaseMeasurement["failures"][number]["stage"],
      work: (signal: AbortSignal) => Promise<T>,
    ) => awaitEvaluationStage(manifest, started, runStarted, stage, work);
    const readPublic = (
      stage: CaseMeasurement["failures"][number]["stage"],
      path: "/ask/read" | "/crm/processing/source/read",
      body: unknown,
    ) =>
      awaitStage(stage, () =>
        input.publicReads.read(item.actorFixtureId, path, body),
      );

    const readWindow = async (
      window: (typeof windows)[number],
      final: boolean,
    ) => {
      const stage = final ? "final_read" : "canonical_read";
      let raw: { status: number; body: unknown };
      try {
        raw = await readPublic(stage, "/crm/processing/source/read", {
          workspaceId: window.source.workspaceId,
          sourceId: window.source.sourceId,
          kind: window.source.kind,
          revision: window.source.revision,
          contentHash: window.source.contentHash,
          locator: window.source.locator,
        });
      } catch (error) {
        if (error instanceof EvaluationTimeout) throw error;
        fail("adapter_unavailable", stage);
        if (final)
          result.finalReadObservations.push({
            windowId: window.id,
            observedAt: new Date().toISOString(),
            state: "unavailable",
          });
        return null;
      }
      const parsed = crmResolvedSourceSchema.safeParse(raw.body);
      const matched =
        raw.status === 200 &&
        parsed.success &&
        parsed.data.passage !== null &&
        originalTextHash(parsed.data.passage.text) === window.textSha256 &&
        JSON.stringify(parsed.data.source) === JSON.stringify(window.source) &&
        parsed.data.passage.locator === window.source.locator;
      if (final)
        result.finalReadObservations.push({
          windowId: window.id,
          observedAt: new Date().toISOString(),
          state: matched ? "available" : "unavailable",
        });
      if (!matched) {
        fail("source_unavailable", final ? "final_read" : "canonical_read");
        return null;
      }
      if (!final)
        observed.set(window.id, {
          extent: parsed.data.extent.length,
          text: parsed.data.passage!.text,
        });
      return parsed.data.passage!.text;
    };
    if (guard !== null && config !== null) {
      result.path = "fake_answer";
      result.usage = structuredClone(guardUsage!);
      if (config.purpose.state !== "fake_only")
        fail("real_purpose_unverified", "answer");
      else if (
        guard.answer.kind !== "fake" ||
        guard.answer.id !== manifest.candidate.answerId ||
        guard.answer.version !== manifest.candidate.answerVersion
      )
        fail("invalid_adapter_output", "answer");
      else if (result.usage.outcome === "unknown")
        fail("unknown_acceptance", "answer");
    }
    if (
      result.failures.length === 0 &&
      windows.length > manifest.envelope.maxScoredWindowsPerCorpus
    ) {
      result.qualityScoringState = "censored_source_or_result_cap";
      fail("corpus_bound", "canonical_read");
    }
    try {
      for (const window of result.failures.length === 0 ? windows : []) {
        const text = await readWindow(window, false);
        if (text === null) break;
        permitted.push({ id: window.id, ordinal: window.ordinal, text });
      }
      if (
        result.failures.length === 0 &&
        corpus.sources.some(
          (source) => !coversOriginalExtent(source.windows, observed),
        )
      ) {
        result.qualityScoringState = "censored_source_or_result_cap";
        fail("corpus_bound", "canonical_read");
      }
      if (result.failures.length === 0) {
        const bytes = corpus.sources.map((source) =>
          source.windows.reduce(
            (sum, window) =>
              sum + Buffer.byteLength(observed.get(window.id)!.text, "utf8"),
            0,
          ),
        );
        if (
          bytes.some((value) => value > 80000) ||
          bytes.reduce((sum, value) => sum + value, 0) > 800000
        ) {
          result.qualityScoringState = "censored_source_or_result_cap";
          fail("corpus_bound", "canonical_read");
        }
      }
      if (result.failures.length === 0 && guard !== null && config !== null) {
        const before = structuredClone(result.usage);
        const charged = {
          calls: before.calls + 1,
          inputTokens: before.inputTokens + config.reservation.inputTokens,
          outputTokens: before.outputTokens + config.reservation.outputTokens,
        };
        if (charged.calls > manifest.envelope.maxCallsPerRun)
          fail("call_limit", "answer");
        else if (
          charged.inputTokens > manifest.envelope.maxInputTokensPerRun ||
          charged.outputTokens > manifest.envelope.maxOutputTokensPerRun
        )
          fail("token_limit", "answer");
        else {
          result.usage = {
            outcome: "unknown",
            ...charged,
            reservedCents: "0",
            observedCents: null,
          };
          const inputWindows: PermittedWindow[] = windows.map((window) => ({
            id: window.id,
            source: window.source,
            text: observed.get(window.id)!.text,
          }));
          let guardOutput: ReturnType<typeof answerOutputSchema.parse> | null =
            null;
          try {
            const raw = await awaitStage("answer", (signal) =>
              guard.answer.answer(
                {
                  query:
                    item.request.operation === "passages"
                      ? item.request.query
                      : "",
                  windows: inputWindows,
                },
                signal,
              ),
            );
            const output = answerOutputSchema.safeParse(raw);
            if (!output.success) fail("invalid_adapter_output", "answer");
            else if (output.data.usage.outcome === "unknown")
              fail("unknown_acceptance", "answer");
            else if (output.data.usage.calls !== 1)
              fail("invalid_adapter_output", "answer");
            else {
              guardOutput = output.data;
              const settled = {
                outcome: "observed" as const,
                calls: charged.calls,
                inputTokens:
                  before.inputTokens +
                  Math.max(
                    config.reservation.inputTokens,
                    output.data.usage.inputTokens,
                  ),
                outputTokens:
                  before.outputTokens +
                  Math.max(
                    config.reservation.outputTokens,
                    output.data.usage.outputTokens,
                  ),
                observedCents: "0" as const,
                reservedCents: "0" as const,
              };
              if (
                !Number.isSafeInteger(settled.inputTokens) ||
                !Number.isSafeInteger(settled.outputTokens) ||
                !Number.isSafeInteger(settled.calls)
              )
                fail("invalid_adapter_output", "answer");
              else result.usage = settled;
              if (
                Number.isSafeInteger(settled.inputTokens) &&
                Number.isSafeInteger(settled.outputTokens) &&
                (output.data.usage.inputTokens >
                  config.reservation.inputTokens ||
                  output.data.usage.outputTokens >
                    config.reservation.outputTokens)
              )
                fail("token_limit", "answer");
              if (
                output.data.claims.some((claim) =>
                  claim.windowIds.some((id) => !observed.has(id)),
                )
              )
                fail("unknown_citation", "answer");
            }
          } catch (error) {
            if (error instanceof EvaluationTimeout)
              fail(error.code, error.stage);
            else fail("unknown_acceptance", "answer");
          }
          // Guard-only never publishes adapter text or retrieval scores; judgments are body-free controls.
          for (const window of windows) {
            if ((await readWindow(window, true)) === null) break;
          }
          if (result.failures.length === 0 && guardOutput !== null) {
            result.abstained = guardOutput.abstained;
            for (const [claimIndex, claim] of guardOutput.claims.entries()) {
              const forbidden = item.acceptableClaims.some((gold) =>
                gold.forbiddenTextVariants.includes(claim.text),
              );
              const known = item.acceptableClaims.find((gold) =>
                gold.acceptableTextVariants.includes(claim.text),
              );
              const supported =
                known !== undefined &&
                !forbidden &&
                known.supportedBy.every((id) => claim.windowIds.includes(id)) &&
                claim.windowIds.every(
                  (id) => known.supportedBy.includes(id) && observed.has(id),
                );
              result.validCitations += new Set(claim.windowIds).size;
              if (supported) {
                result.supportedClaims++;
                result.claimJudgments.push({
                  claimIndex,
                  verdict: "supported",
                  matchedGoldClaimId: known.id,
                });
              } else if (forbidden || known !== undefined) {
                result.unsupportedClaims++;
                result.claimJudgments.push({
                  claimIndex,
                  verdict: "unsupported",
                  matchedGoldClaimId: null,
                });
                fail("unsupported_claim", "scoring");
              } else {
                result.unjudgedClaims++;
                result.claimJudgments.push({
                  claimIndex,
                  verdict: "unjudged_unknown_paraphrase",
                  matchedGoldClaimId: null,
                });
              }
            }
            result.claimEvaluationState =
              result.unjudgedClaims > 0
                ? "pending_human_adjudication"
                : guardOutput.claims.length > 0
                  ? "closed_gold_variants_checked"
                  : "no_claims";
          }
        }
      } else if (result.failures.length === 0) {
        const response = await readPublic(
          "baseline",
          "/ask/read",
          item.request,
        );
        const parsed = askResponseSchema.safeParse(response.body);
        if (
          response.status !== 200 ||
          !parsed.success ||
          parsed.data.operation !== item.request.operation
        )
          fail("invalid_adapter_output", "baseline");
        else if (parsed.data.operation !== "passages") {
          result.path = "exact_sql";
          if (
            item.exactExpected === null ||
            JSON.stringify(parsed.data) !== JSON.stringify(item.exactExpected)
          )
            fail("exact_state_mismatch", "baseline");
          for (const window of windows) {
            if ((await readWindow(window, true)) === null) break;
          }
          if (result.failures.length === 0)
            result.qualityScoringState = "scored";
        } else {
          const answer = parsed.data;
          if (
            answer.truncated ||
            !answer.coverage.scanComplete ||
            windows.length > manifest.envelope.maxScoredWindowsPerCorpus
          ) {
            result.qualityScoringState = "censored_source_or_result_cap";
            fail("truncated_baseline", "baseline");
          } else {
            const groups = groupEvaluationWindows(permitted);
            const ranked: string[] = [];
            for (const passage of answer.passages) {
              const groupId = evaluationTextGroupId(passage.text);
              for (const source of passage.sources) {
                const window = windows.find(
                  (row) =>
                    JSON.stringify(row.source) === JSON.stringify(source),
                );
                if (
                  window === undefined ||
                  evaluationTextGroupId(observed.get(window.id)!.text) !==
                    groupId
                ) {
                  result.invalidCitations++;
                  fail("canonical_quote_mismatch", "baseline");
                } else result.validCitations++;
              }
              if (
                !passage.sources.some((source) =>
                  windows.some(
                    (window) =>
                      JSON.stringify(window.source) ===
                        JSON.stringify(source) &&
                      window.textSha256 === originalTextHash(passage.text),
                  ),
                )
              )
                fail("canonical_quote_mismatch", "baseline");
              if (!groups.some((group) => group.groupId === groupId))
                fail("canonical_quote_mismatch", "baseline");
              else if (!ranked.includes(groupId)) ranked.push(groupId);
            }
            for (const window of windows) {
              if ((await readWindow(window, true)) === null) break;
            }
            if (result.failures.length === 0) {
              Object.assign(
                result,
                scoreRetrievalGroups(groups, item.relevance, ranked),
              );
              result.qualityScoringState = "scored";
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof EvaluationTimeout) fail(error.code, error.stage);
      else fail("adapter_unavailable", "baseline");
    }
    const expected = item.expectedRefusal ?? null;
    if (expected !== null) {
      const exactRefusal =
        item.mustAbstain &&
        item.lifecycleScenario === expected.scenario &&
        result.failures.length > 0 &&
        result.failures.every(
          (failure) =>
            failure.code === expected.code && failure.stage === expected.stage,
        ) &&
        result.publishedClaimCount === 0 &&
        result.publishedCitationCount === 0 &&
        !result.prohibitedPublication;
      result.controlOutcome = exactRefusal ? "passed" : "failed";
    } else
      result.controlOutcome =
        result.failures.length === 0 && !item.mustAbstain ? "passed" : "failed";
    result.durationMs = performance.now() - started;
    if (guard !== null) guardUsage = structuredClone(result.usage);
    results.push(result);
  }
  const report = baselineReport(manifest, results);
  return guard === null
    ? report
    : {
        ...report,
        baselineMeasured: false,
        modelEvaluationState: "guard_only",
        syntheticOrchestrationPassed: false,
        syntheticControlsPassed: false,
      };
}

export interface DevelopmentCaseRuntime {
  input: DevelopmentEvaluationInput;
  independentLabel: DevelopmentLabelTemplate;
  cleanup(): Promise<void>;
}
export async function runDevelopmentSuite(input: {
  suite: DevelopmentSuite;
  cases: readonly DevelopmentCaseRuntime[];
}): Promise<EvaluationReport> {
  try {
    const suite = developmentSuiteSchema.parse(input.suite);
    const { suiteSha256, ...definition } = suite;
    const first = input.cases[0];
    if (
      first === undefined ||
      input.cases.length !== 80 ||
      evaluationHash(definition) !== suiteSha256 ||
      evaluationHash(input.cases.map((runtime) => runtime.independentLabel)) !==
        suite.labelSha256
    )
      throw new RangeError("manifest_mismatch");
    const identities = new Set<string>();
    const originals = new Set<string>();
    const kinds = new Set<string>();
    const categories = new Map<string, number>();
    // Complete every fixture binding check before the first authenticated read.
    for (const [index, runtime] of input.cases.entries()) {
      const binding = suite.caseBindings[index];
      const { corpus, manifest } = validateDevelopment(runtime.input);
      const label = runtime.independentLabel;
      const item = corpus.cases[0];
      if (
        binding === undefined ||
        item === undefined ||
        corpus.cases.length !== 1 ||
        binding.caseId !== label.caseId ||
        item.id !== label.caseId ||
        binding.corpusSha256 !== corpus.corpusSha256 ||
        binding.sourceManifestSha256 !== manifest.sourceManifestSha256 ||
        binding.labelSha256 !== evaluationHash(label) ||
        item.category !== label.category ||
        item.lifecycleScenario !== label.lifecycleScenario ||
        corpus.sources.some((source) => source.kind !== label.sourceKind) ||
        identities.has(label.identityName) ||
        originals.has(label.originalText)
      )
        throw new RangeError("manifest_mismatch");
      const sourceGold = label.sourceLabels ?? [
        {
          slot: "original",
          originalText: label.originalText,
          relevanceGrade: label.relevantGrade,
        },
      ];
      const expectedRelevance = corpus.sources.flatMap((source, index) =>
        source.windows.map((window) => ({
          windowId: window.id,
          grade: sourceGold[index]?.relevanceGrade,
        })),
      );
      const expectedClaims =
        label.acceptableClaimText.length === 0
          ? []
          : [
              {
                acceptableTextVariants: label.acceptableClaimText,
                forbiddenTextVariants: label.forbiddenClaimText,
              },
            ];
      const actualClaims = item.acceptableClaims.map((claim) => ({
        acceptableTextVariants: claim.acceptableTextVariants,
        forbiddenTextVariants: claim.forbiddenTextVariants,
      }));
      const originalWindowIds = new Set(
        corpus.sources[0]!.windows.map((window) => window.id),
      );
      if (
        corpus.sources.length !== sourceGold.length ||
        JSON.stringify(item.relevance) !== JSON.stringify(expectedRelevance) ||
        JSON.stringify(actualClaims) !== JSON.stringify(expectedClaims) ||
        item.acceptableClaims.some((claim) =>
          claim.supportedBy.some((id) => !originalWindowIds.has(id)),
        ) ||
        item.mustAbstain !== (label.lifecycleScenario !== "none") ||
        corpus.sources.some((source, index) =>
          source.windows.some((window) => {
            const gold = sourceGold[index]!;
            const range = /^(?:utterance:0:)?text:(\d+):(\d+)$/u.exec(
              window.source.locator,
            );
            return (
              range === null ||
              window.textSha256 !==
                originalTextHash(
                  gold.originalText.slice(Number(range[1]), Number(range[2])),
                )
            );
          }),
        ) ||
        (label.expectedOpenOpportunities === null
          ? item.request.operation !== "passages" ||
            item.request.query !== label.query
          : item.request.operation !== "opportunities" ||
            item.request.status !== "open" ||
            item.exactExpected?.operation !== "opportunities" ||
            item.exactExpected.count !==
              String(label.expectedOpenOpportunities) ||
            JSON.stringify(item.request.scope) !==
              JSON.stringify(item.exactExpected.scope))
      )
        throw new RangeError("manifest_mismatch");
      identities.add(label.identityName);
      originals.add(label.originalText);
      kinds.add(label.sourceKind);
      categories.set(label.category, (categories.get(label.category) ?? 0) + 1);
    }
    if (
      kinds.size !== 4 ||
      categories.size !== 8 ||
      [...categories.values()].some((count) => count !== 10)
    )
      throw new RangeError("manifest_mismatch");
    const results: CaseMeasurement[] = [];
    const runStarted = performance.now();
    for (const runtime of input.cases) {
      const report = await runBoundedEvaluation(runtime.input, runStarted);
      results.push(...report.caseResults);
    }
    return {
      ...baselineReport(first.input.manifest, results),
      manifestSha256: suite.suiteSha256,
    };
  } finally {
    await Promise.all(input.cases.map((runtime) => runtime.cleanup()));
  }
}

export interface FakeCandidateCase {
  split: string;
  corpus: FrozenCorpus;
  label: Omit<DevelopmentLabelTemplate, "sourceLabels"> & {
    sourceLabels?: DevelopmentLabelTemplate["sourceLabels"] | undefined;
  };
}
export interface FakeCandidateSuiteInput {
  phase: "fake_candidate";
  execution: FakeCandidateExecution;
  caseCorpora: readonly FakeCandidateCase[];
  caseIds?: readonly string[];
  publicReads: EvaluationPublicReads;
  vector: EvaluationVectorPort;
}

/** The sole candidate entry accepts the full live binding before selecting either split. */
export async function runFakeCandidateSuite(input: FakeCandidateSuiteInput) {
  // Capture caller-owned manifests before any await; source lifecycle may change, gold may not.
  const caseCorpora = structuredClone(input.caseCorpora);
  const rawExecution = structuredClone(input.execution);
  const requestedCaseIds =
    input.caseIds === undefined ? undefined : [...input.caseIds];
  const decision = fakeCandidateDecisionSchema.parse(
    JSON.parse(
      await readFile(
        new URL("./fakeCandidateDecision.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const scriptBytes = await readFile(
    new URL("./fakeCandidateScript.json", import.meta.url),
    "utf8",
  );
  const script = fakeCandidateScriptSchema.parse(JSON.parse(scriptBytes));
  const execution = fakeCandidateExecutionSchema.parse(rawExecution);
  const { configurationSha256, ...decisionDefinition } = decision;
  const { suiteSha256, ...suiteDefinition } = execution.fullSuite;
  const { splitSha256, ...splitDefinition } = execution.fullSuite.split;
  if (
    input.phase !== "fake_candidate" ||
    evaluationHash(decisionDefinition) !== configurationSha256 ||
    originalTextHash(scriptBytes) !== decision.candidateScriptSha256 ||
    execution.decisionConfigurationSha256 !== configurationSha256 ||
    execution.candidateScriptSha256 !== decision.candidateScriptSha256 ||
    evaluationHash(suiteDefinition) !== suiteSha256 ||
    evaluationHash(splitDefinition) !== splitSha256 ||
    evaluationHash(execution.fullSuite.caseBindings) !==
      execution.caseBindingsSha256 ||
    caseCorpora.length !== 120 ||
    caseCorpora.some(
      (row) => row.split !== "development" && row.split !== "holdout",
    ) ||
    evaluationHash(caseCorpora.map((row) => row.corpus.sources)) !==
      execution.sourceManifestSha256 ||
    evaluationHash(caseCorpora.map((row) => row.label)) !==
      decision.logicalGoldSha256 ||
    execution.fullSuite.split.labelSha256 !== decision.logicalGoldSha256
  )
    throw new RangeError("manifest_mismatch");
  const manifests = new Map<string, FrozenManifest>();
  const identities = new Set<string>();
  const originalIds = new Set<string>();
  for (const [index, row] of caseCorpora.entries()) {
    const binding = execution.fullSuite.caseBindings[index];
    const item = row.corpus.cases[0];
    const label = row.label;
    const prefix = row.split === "development" ? "dev_" : "holdout_";
    const ids =
      row.split === "development"
        ? execution.fullSuite.split.developmentCaseIds
        : execution.fullSuite.split.holdoutCaseIds;
    const windows = row.corpus.sources.flatMap((source) => source.windows);
    const manifest = frozenManifestSchema.parse({
      version: "ask-evaluation-v1",
      mode: "fake_only",
      corpusSha256: row.corpus.corpusSha256,
      sourceManifestSha256: evaluationHash(row.corpus.sources),
      splitSha256: evaluationHash(row.corpus.cases.map((item) => item.id)),
      chunkerVersion: "lexical-original-v1",
      dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
      lexicalRank: "first_matched_window_source_order_not_relevance",
      refWindowMappingSha256: evaluationHash(windows),
      baselineSourceCommit: decision.calibration.baselineSourceCommit,
      candidate: decision.candidate,
      envelope: decision.envelope,
      configurationSha256: evaluationHash({
        candidate: decision.candidate,
        envelope: decision.envelope,
      }),
    });
    validateFrozenCorpus({ manifest, development: row.corpus }, prefix);
    const gold = label.sourceLabels ?? [
      {
        slot: "original",
        originalText: label.originalText,
        relevanceGrade: label.relevantGrade,
      },
    ];
    if (
      item === undefined ||
      row.corpus.cases.length !== 1 ||
      binding === undefined ||
      binding.caseId !== label.caseId ||
      item.id !== label.caseId ||
      item.actorFixtureId !== `${label.caseId}_actor` ||
      row.corpus.id !== `${label.caseId}_corpus` ||
      !ids.includes(item.id) ||
      binding.split !== row.split ||
      binding.corpusSha256 !== row.corpus.corpusSha256 ||
      binding.sourceManifestSha256 !== manifest.sourceManifestSha256 ||
      binding.labelSha256 !== evaluationHash(label) ||
      manifests.has(item.id) ||
      identities.has(label.identityName) ||
      row.corpus.sources.length !== gold.length ||
      item.category !== label.category ||
      item.lifecycleScenario !== label.lifecycleScenario ||
      JSON.stringify(item.expectedRefusal ?? null) !==
        JSON.stringify(
          label.lifecycleScenario === "none"
            ? null
            : {
                stage: "final_read",
                code: "source_unavailable",
                scenario: label.lifecycleScenario,
              },
        ) ||
      item.mustAbstain !== (label.lifecycleScenario !== "none") ||
      JSON.stringify(item.relevance) !==
        JSON.stringify(
          row.corpus.sources.flatMap((source, i) =>
            source.windows.map((window) => ({
              windowId: window.id,
              grade: gold[i]?.relevanceGrade,
            })),
          ),
        ) ||
      JSON.stringify(
        item.acceptableClaims.map((claim) => ({
          acceptableTextVariants: claim.acceptableTextVariants,
          forbiddenTextVariants: claim.forbiddenTextVariants,
        })),
      ) !==
        JSON.stringify(
          label.acceptableClaimText.length === 0
            ? []
            : [
                {
                  acceptableTextVariants: label.acceptableClaimText,
                  forbiddenTextVariants: label.forbiddenClaimText,
                },
              ],
        ) ||
      item.acceptableClaims.some((claim) =>
        claim.supportedBy.some(
          (id) =>
            !row.corpus.sources[0]!.windows.some((window) => window.id === id),
        ),
      ) ||
      row.corpus.sources.some(
        (source, i) =>
          source.kind !== label.sourceKind ||
          source.windows.some((window) => {
            const match = /^(?:utterance:0:)?text:(\d+):(\d+)$/u.exec(
              window.source.locator,
            );
            return (
              match === null ||
              window.textSha256 !==
                originalTextHash(
                  gold[i]!.originalText.slice(
                    Number(match[1]),
                    Number(match[2]),
                  ),
                )
            );
          }),
      ) ||
      (label.expectedOpenOpportunities === null
        ? item.request.operation !== "passages" ||
          item.request.query !== label.query
        : item.request.operation !== "opportunities" ||
          item.request.status !== "open" ||
          item.exactExpected?.operation !== "opportunities" ||
          item.exactExpected.count !==
            String(label.expectedOpenOpportunities) ||
          JSON.stringify(item.request.scope) !==
            JSON.stringify(item.exactExpected.scope))
    )
      throw new RangeError("manifest_mismatch");
    for (const source of row.corpus.sources) {
      const id = source.windows[0]!.source.sourceId;
      if (originalIds.has(id)) throw new RangeError("manifest_mismatch");
      originalIds.add(id);
    }
    identities.add(label.identityName);
    manifests.set(item.id, manifest);
  }
  const selected =
    requestedCaseIds ?? caseCorpora.map((row) => row.label.caseId);
  if (
    new Set(selected).size !== selected.length ||
    selected.some((id) => !manifests.has(id))
  )
    throw new RangeError("manifest_mismatch");
  const runStarted = performance.now();
  let usage: EvaluationUsage = {
    outcome: "observed",
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reservedCents: "0",
    observedCents: "0",
  };
  const development: CaseMeasurement[] = [],
    holdout: CaseMeasurement[] = [];
  const rankObservations: {
    caseId: string;
    ranking: EvaluationRankingOutput;
  }[] = [];
  for (const row of caseCorpora.filter((row) =>
    selected.includes(row.label.caseId),
  )) {
    const started = performance.now(),
      manifest = manifests.get(row.label.caseId)!;
    const prefix = row.split === "development" ? "dev_" : "holdout_";
    const target = row.split === "development" ? development : holdout;
    const evaluationInput: DevelopmentEvaluationInput = {
      phase: "development_baseline",
      manifest,
      development: row.corpus,
      publicReads: input.publicReads,
    };
    const baseline = (
      await runBoundedEvaluation(evaluationInput, runStarted, prefix, started)
    ).caseResults[0]!;
    if (baseline.path === "exact_sql") {
      target.push(baseline);
      continue;
    }
    const vectorResult = structuredClone(baseline),
      hybridResult = structuredClone(baseline),
      answerResult = structuredClone(baseline);
    vectorResult.path = "fake_exact_vector";
    hybridResult.path = "fake_hybrid";
    answerResult.path = "fake_answer";
    const results = [baseline, vectorResult, hybridResult, answerResult];
    const fail = (
      code: CaseMeasurement["failures"][number]["code"],
      stage: CaseMeasurement["failures"][number]["stage"],
    ) => {
      for (const result of results) {
        if (
          !result.failures.some(
            (row) => row.code === code && row.stage === stage,
          )
        )
          result.failures.push({ code, stage });
        result.qualityScoringState = "failed";
        result.recallAt10 = null;
        result.precisionAt10 = null;
        result.ndcgAt10 = null;
        result.controlOutcome = "failed";
        result.publishedClaimCount = 0;
        result.publishedCitationCount = 0;
      }
    };
    if (baseline.failures.length === 0) {
      try {
        const windows = row.corpus.sources.flatMap((source) => source.windows);
        const permitted: PermittedWindow[] = [];
        for (const window of windows) {
          const resolved = await awaitEvaluationStage(
            manifest,
            started,
            runStarted,
            "canonical_read",
            () =>
              input.publicReads.read(
                row.corpus.cases[0]!.actorFixtureId,
                "/crm/processing/source/read",
                {
                  workspaceId: window.source.workspaceId,
                  sourceId: window.source.sourceId,
                  kind: window.source.kind,
                  revision: window.source.revision,
                  contentHash: window.source.contentHash,
                  locator: window.source.locator,
                },
              ),
          );
          const parsed = crmResolvedSourceSchema.safeParse(resolved.body);
          if (
            resolved.status !== 200 ||
            !parsed.success ||
            parsed.data.passage === null ||
            originalTextHash(parsed.data.passage.text) !== window.textSha256 ||
            JSON.stringify(parsed.data.source) !== JSON.stringify(window.source)
          )
            throw new Error("source_unavailable");
          permitted.push({
            id: window.id,
            source: window.source,
            text: parsed.data.passage.text,
          });
        }
        const call = async <T extends { usage: EvaluationUsage }>(
          stage: "embedding",
          inputTokens: number,
          work: (signal: AbortSignal) => Promise<T>,
        ) => {
          if (usage.outcome === "unknown")
            throw new Error("unknown_acceptance");
          const reserved = {
            calls: usage.calls + 1,
            inputTokens: usage.inputTokens + inputTokens,
            outputTokens: usage.outputTokens,
          };
          if (reserved.calls > manifest.envelope.maxCallsPerRun)
            throw new Error("call_limit");
          if (reserved.inputTokens > manifest.envelope.maxInputTokensPerRun)
            throw new Error("token_limit");
          usage = {
            outcome: "unknown",
            ...reserved,
            reservedCents: "0",
            observedCents: null,
          };
          const output = await awaitEvaluationStage(
            manifest,
            started,
            runStarted,
            stage,
            work,
          );
          if (output.usage.outcome !== "observed" || output.usage.calls !== 1)
            throw new Error("unknown_acceptance");
          if (
            output.usage.inputTokens > inputTokens ||
            output.usage.outputTokens > 0
          )
            throw new Error("token_limit");
          usage = {
            outcome: "observed",
            ...reserved,
            reservedCents: "0",
            observedCents: "0",
          };
          return output;
        };
        const vectors: Record<string, number[]> = {};
        for (const window of windows)
          vectors[window.id] = [
            ...script.embedding.windowVectorsByOrdinalModulo4[
              window.ordinal % 4
            ]!,
          ];
        const embedding = createFakeEvaluationEmbedding({
          version: decision.candidate.embeddingVersion,
          dimensions: decision.candidate.dimensions,
          vectors,
          queryVector: script.embedding.queryVector,
        });
        const query =
          row.corpus.cases[0]!.request.operation === "passages"
            ? row.corpus.cases[0]!.request.query
            : "";
        const embedded = embeddingOutputSchema.parse(
          await call(
            "embedding",
            Math.ceil(permitted.map((row) => row.text).join("\n").length / 4),
            (signal) => embedding.embed(permitted, signal),
          ),
        );
        const queryEmbedding = queryEmbeddingOutputSchema.parse(
          await call("embedding", Math.ceil(query.length / 4), (signal) =>
            embedding.embedQuery(query, signal),
          ),
        );
        const response = await awaitEvaluationStage(
          manifest,
          started,
          runStarted,
          "baseline",
          () =>
            input.publicReads.read(
              row.corpus.cases[0]!.actorFixtureId,
              "/ask/read",
              row.corpus.cases[0]!.request,
            ),
        );
        const lexical = askResponseSchema.parse(response.body);
        if (
          response.status !== 200 ||
          lexical.operation !== "passages" ||
          lexical.truncated ||
          !lexical.coverage.scanComplete
        )
          throw new Error("truncated_baseline");
        const ranking = rankingOutputSchema.parse(
          await awaitEvaluationStage(
            manifest,
            started,
            runStarted,
            "vector_sql",
            () =>
              input.vector.rank({
                mode: "fake_only",
                dimensions: decision.candidate.dimensions,
                k: 10,
                rrfConstant: 60,
                windows: permitted.map((window, i) => ({
                  id: window.id,
                  ordinal: windows[i]!.ordinal,
                  text: window.text,
                })),
                embeddings: embedded.vectors,
                queryVector: queryEmbedding.vector,
                lexicalGroupRanks: lexical.passages.map((passage, i) => ({
                  groupId: evaluationTextGroupId(passage.text),
                  rank: i + 1,
                })),
              }),
          ),
        );
        const expectedGroups = groupEvaluationWindows(
          permitted.map((window, i) => ({
            id: window.id,
            ordinal: windows[i]!.ordinal,
            text: window.text,
          })),
        );
        const expectedVectorRanks = expectedGroups
          .map((group) => ({
            groupId: group.groupId,
            windowIds: group.windowIds,
            firstOrdinal: group.firstOrdinal,
            score: Math.max(
              ...group.windowIds.map((id) => {
                const window = windows.find((window) => window.id === id)!;
                return [1, -1, 1, 0][window.ordinal % 4]!;
              }),
            ),
          }))
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.firstOrdinal - b.firstOrdinal ||
              (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0),
          )
          .slice(0, 10)
          .map((group, i) => ({ ...group, rank: i + 1 }));
        const sameRanks = (
          actual: typeof ranking.vector.ranked,
          expected: typeof ranking.vector.ranked,
        ) =>
          actual.length === expected.length &&
          actual.every((group, i) => {
            const target = expected[i]!;
            return (
              group.groupId === target.groupId &&
              group.rank === target.rank &&
              group.firstOrdinal === target.firstOrdinal &&
              group.score === target.score &&
              JSON.stringify(group.windowIds) ===
                JSON.stringify(target.windowIds)
            );
          });
        if (
          !sameRanks(ranking.vector.ranked, expectedVectorRanks) ||
          ranking.vector.path !== "fake_exact_vector" ||
          ranking.groups.length !== expectedGroups.length ||
          ranking.groups.some((group, i) => {
            const expected = expectedGroups[i];
            return (
              expected === undefined ||
              group.groupId !== expected.groupId ||
              group.textSha256 !== expected.textSha256 ||
              group.firstOrdinal !== expected.firstOrdinal ||
              JSON.stringify(group.windowIds) !==
                JSON.stringify(expected.windowIds)
            );
          }) ||
          ranking.rawWindowScores.length !== windows.length ||
          new Set(ranking.rawWindowScores.map((row) => row.windowId)).size !==
            windows.length ||
          ranking.rawWindowScores.some((score) => {
            const window = windows.find(
              (window) => window.id === score.windowId,
            );
            return (
              window === undefined ||
              score.score !== [1, -1, 1, 0][window.ordinal % 4]
            );
          }) ||
          [ranking.vector, ranking.hybrid].some(
            (result) =>
              result.failures.length !== 0 ||
              result.qualityScoringState !== "scored" ||
              new Set(result.ranked.map((group) => group.groupId)).size !==
                result.ranked.length ||
              result.ranked.some((group, i) => {
                const expected = expectedGroups.find(
                  (row) => row.groupId === group.groupId,
                );
                return (
                  expected === undefined ||
                  group.rank !== i + 1 ||
                  group.firstOrdinal !== expected.firstOrdinal ||
                  JSON.stringify(group.windowIds) !==
                    JSON.stringify(expected.windowIds)
                );
              }),
          ) ||
          ranking.sqlBounds.inputWindows !== windows.length ||
          ranking.sqlObservation.evaluatedWindowScores !== windows.length
        )
          throw new EvaluationRefusal("invalid_adapter_output", "vector_sql");
        const expectedHybrid = evaluationFusion.fuse({
          lexical: {
            path: "lexical",
            dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
            qualityScoringState: "scored",
            durationMs: 0,
            failures: [],
            ranked: lexical.passages.map((passage, i) => {
              const group = expectedGroups.find(
                (group) =>
                  group.groupId === evaluationTextGroupId(passage.text),
              )!;
              return {
                groupId: group.groupId,
                windowIds: group.windowIds,
                firstOrdinal: group.firstOrdinal,
                rank: i + 1,
                score: null,
              };
            }),
          },
          vector: { ...ranking.vector, ranked: expectedVectorRanks },
          groups: expectedGroups,
          rrfConstant: 60,
          k: 10,
        });
        if (
          ranking.hybrid.path !== "fake_hybrid" ||
          !sameRanks(ranking.hybrid.ranked, expectedHybrid.ranked)
        )
          throw new EvaluationRefusal("invalid_adapter_output", "fusion");
        rankObservations.push({ caseId: row.label.caseId, ranking });
        const answer = createFakeEvaluationAnswer({
          version: decision.candidate.answerVersion,
          answersByQuery: { [query]: { claims: [], abstained: true } },
        });
        const guarded = await runBoundedEvaluation(
          {
            phase: "guard_only",
            manifest,
            development: row.corpus,
            publicReads: input.publicReads,
            guard: {
              purpose: {
                state: "fake_only",
                purpose: "crm_retrieval_evaluation",
                realCallsAllowed: false,
                maxSpendCents: 0,
                reason: "fake_only",
              },
              reservation: {
                calls: 1,
                inputTokens: Math.ceil(
                  (
                    query +
                    "\n" +
                    permitted.map((window) => window.text).join("\n")
                  ).length / 4,
                ),
                outputTokens: 0,
              },
              priorUsage: usage,
              answer,
            },
          },
          runStarted,
          prefix,
          started,
        );
        const model = guarded.caseResults[0]!;
        usage = model.usage;
        Object.assign(answerResult, model, {
          abstained: model.failures.length === 0,
          qualityScoringState:
            model.failures.length === 0 ? "scored" : "failed",
        });
        if (model.failures.length > 0)
          for (const failure of model.failures)
            fail(failure.code, failure.stage);
        else {
          for (const [result, ranked] of [
            [vectorResult, ranking.vector],
            [hybridResult, ranking.hybrid],
          ] as const) {
            result.qualityScoringState = ranked.qualityScoringState;
            result.failures = [...ranked.failures];
            Object.assign(
              result,
              scoreRetrievalGroups(
                ranking.groups,
                row.corpus.cases[0]!.relevance,
                ranked.ranked.map((group) => group.groupId),
              ),
            );
            result.finalReadObservations = model.finalReadObservations;
          }
        }
      } catch (error) {
        if (
          error instanceof EvaluationTimeout ||
          error instanceof EvaluationRefusal
        )
          fail(error.code, error.stage);
        else {
          const allowed = [
            "source_unavailable",
            "unknown_acceptance",
            "call_limit",
            "token_limit",
            "truncated_baseline",
          ] as const;
          const code =
            error instanceof Error
              ? allowed.find((code) => code === error.message)
              : undefined;
          fail(
            code ?? "invalid_adapter_output",
            code === "source_unavailable" ? "canonical_read" : "embedding",
          );
        }
      }
    }
    for (const result of results) {
      result.durationMs = performance.now() - started;
      result.usage = structuredClone(usage);
    }
    target.push(...results);
  }
  const first = manifests.values().next().value!;
  const report = (results: CaseMeasurement[]) => ({
    ...baselineReport(first, results),
    manifestSha256: evaluationHash(execution),
    modelEvaluationState: "fake_only_complete" as const,
  });
  return {
    executionSha256: evaluationHash(execution),
    decisionConfigurationSha256: configurationSha256,
    development: report(development),
    holdout: report(holdout),
    rankObservations,
    semanticSelection: false as const,
    activationAllowed: false as const,
  };
}
