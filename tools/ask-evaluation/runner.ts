import type { DevelopmentLabelTemplate } from "./labels.ts";
import { performance } from "node:perf_hooks";
import { askResponseSchema, crmResolvedSourceSchema } from "@fss/contracts";
import type {
  FrozenCorpus,
  FrozenManifest,
  EvaluationReport,
  DevelopmentSuite,
} from "./contracts.ts";
import {
  developmentSuiteSchema,
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
export async function runEvaluation(
  input: DevelopmentEvaluationInput,
): Promise<EvaluationReport> {
  return runBoundedEvaluation(input, performance.now());
}
async function runBoundedEvaluation(
  input: DevelopmentEvaluationInput,
  runStarted: number,
): Promise<EvaluationReport> {
  const { manifest, corpus, windows } = validateDevelopment(input);
  const results: CaseMeasurement[] = [];
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
      result.failures.push({ code, stage });
    };
    const permitted: { id: string; ordinal: number; text: string }[] = [];
    const observed = new Map<string, { extent: number; text: string }>();
    const readPublic = async (
      stage: CaseMeasurement["failures"][number]["stage"],
      path: "/ask/read" | "/crm/processing/source/read",
      body: unknown,
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
      try {
        const response = await Promise.race([
          input.publicReads.read(item.actorFixtureId, path, body),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(timeout()), remaining);
          }),
        ]);
        if (performance.now() >= deadline) throw timeout();
        return response;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    };

    const readWindow = async (
      window: (typeof windows)[number],
      final: boolean,
    ) => {
      const raw = await readPublic(
        final ? "final_read" : "canonical_read",
        "/crm/processing/source/read",
        {
          workspaceId: window.source.workspaceId,
          sourceId: window.source.sourceId,
          kind: window.source.kind,
          revision: window.source.revision,
          contentHash: window.source.contentHash,
          locator: window.source.locator,
        },
      );
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
    try {
      for (const window of windows) {
        const text = await readWindow(window, false);
        if (text !== null)
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
      if (result.failures.length === 0) {
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
          for (const window of windows) await readWindow(window, true);
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
            for (const window of windows) await readWindow(window, true);
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
    results.push(result);
  }
  return baselineReport(manifest, results);
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
