import type { DevelopmentLabelTemplate } from "./labels.ts";
import { performance } from "node:perf_hooks";
import { askResponseSchema, crmResolvedSourceSchema } from "@fss/contracts";
import type {
  FrozenCorpus,
  FrozenManifest,
  EvaluationReport,
  DevelopmentSuite,
  EvaluationGuard,
  PermittedWindow,
} from "./contracts.ts";
import {
  developmentSuiteSchema,
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
): Promise<EvaluationReport> {
  if (input.phase !== "development_baseline" && input.phase !== "guard_only")
    throw new RangeError("manifest_mismatch");
  const { manifest, corpus, windows } = validateDevelopment({
    ...input,
    phase: "development_baseline",
  });
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
    const started = performance.now();
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
    const awaitStage = async <T>(
      stage: CaseMeasurement["failures"][number]["stage"],
      work: (signal: AbortSignal) => Promise<T>,
    ) => {
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
    };
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
          // All adapter outputs are discarded in guard-only mode; no ranking or gold judgment.
          for (const window of windows) {
            if ((await readWindow(window, true)) === null) break;
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
              const grades = new Map(
                groups.map((group) => [
                  group.groupId,
                  Math.max(
                    0,
                    ...item.relevance
                      .filter((label) =>
                        group.windowIds.includes(label.windowId),
                      )
                      .map((label) => label.grade),
                  ),
                ]),
              );
              const relevant = [...grades.values()].filter(
                (grade) => grade > 0,
              ).length;
              const selected = ranked.slice(0, 10);
              const hits = selected.filter(
                (id) => (grades.get(id) ?? 0) > 0,
              ).length;
              result.recallAt10 = relevant === 0 ? null : hits / relevant;
              result.precisionAt10 =
                selected.length === 0 ? null : hits / selected.length;
              const dcg = (values: number[]) =>
                values.reduce(
                  (sum, grade, index) =>
                    sum + (2 ** grade - 1) / Math.log2(index + 2),
                  0,
                );
              const ideal = dcg(
                [...grades.values()].sort((a, b) => b - a).slice(0, 10),
              );
              result.ndcgAt10 =
                ideal === 0
                  ? null
                  : dcg(selected.map((id) => grades.get(id) ?? 0)) / ideal;
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
