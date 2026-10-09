import { setupEvaluationCase } from "./support/askEvaluationFixture.ts";
import type { DevelopmentCaseRuntime } from "../../../tools/ask-evaluation/runner.ts";
import { writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { performance } from "node:perf_hooks";
import { crmResolvedSourceSchema } from "@fss/contracts";
import { runEvaluation } from "../../../tools/ask-evaluation/runner.ts";
import {
  frozenCorpusSchema,
  frozenManifestSchema,
} from "../../../tools/ask-evaluation/contracts.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";
const hashText = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("measures a frozen development selected-note lexical baseline through authenticated public reads", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const person = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Synthetic Development Person",
    });
    expect(person.status).toBe(200);
    const personId = (person.body as { result: { personId: string } }).result
      .personId;
    const text = "Maintenance routing needs a clearer process.";
    const selection = {
      text,
      subtype: "pasted_text",
      label: "Synthetic evaluation note",
      direction: "unknown",
      participants: [],
      occurredAt: null,
      attachments: [],
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(preview.status).toBe(200);
    const committed = await post("/crm/imports/commit", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...selection,
      personId,
      firmId: null,
      importKey: randomUUID(),
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    });
    expect(committed.status).toBe(200);
    const sourceId = (committed.body as { result: { sourceId: string } }).result
      .sourceId;
    const contentHash = createHash("sha256").update(text).digest("hex");
    const sourceRead = await post("/crm/processing/source/read", {
      workspaceId: fixture.alpha.workspaceId,
      sourceId,
      kind: "selected_note",
      revision: 1,
      contentHash,
      locator: `text:0:${text.length}`,
    });
    expect(sourceRead.status).toBe(200);
    const source = crmResolvedSourceSchema.parse(sourceRead.body).source;
    const fixtureDefinition = {
      id: "dev_corpus",
      fixtureVersion: "synthetic-v1",
      sources: [
        {
          id: "dev_note",
          kind: "selected_note",
          setupId: "synthetic_selected_note",
          originalSha256: contentHash,
          windows: [
            {
              id: "dev_window",
              source,
              textSha256: contentHash,
              chunkerVersion: "lexical-original-v1",
              ordinal: 0,
            },
          ],
        },
      ],
      cases: [
        {
          id: "dev_topic",
          category: "topic",
          actorFixtureId: "dev_actor",
          corpusId: "dev_corpus",
          request: {
            operation: "passages",
            scope: {
              sources: [
                {
                  workspaceId: source.workspaceId,
                  sourceId: source.sourceId,
                  kind: source.kind,
                  revision: source.revision,
                  contentHash: source.contentHash,
                  locator: null,
                },
              ],
            },
            query: "maintenance routing",
            limit: 50,
          },
          relevance: [{ windowId: "dev_window", grade: 2 }],
          acceptableClaims: [],
          mustAbstain: false,
          exactExpected: null,
          labelVersion: "independent-v1",
          labelAuthoringState: "independent_before_candidate_outputs",
          lifecycleScenario: "none",
        },
      ],
    };
    const development = frozenCorpusSchema.parse({
      ...fixtureDefinition,
      corpusSha256: hash(fixtureDefinition),
    });
    const candidate = {
      embeddingId: "fake_embedding",
      embeddingVersion: "v1",
      dimensions: 2,
      answerId: "fake_answer",
      answerVersion: "v1",
      vectorMetric: "cosine",
      fusion: "rrf",
      rrfConstant: 60,
      k: 10,
      textConfiguration: "simple",
    };
    const envelope = {
      version: "synthetic-orchestration-v1",
      criticalFailureCeiling: 0,
      exactMismatchCeiling: 0,
      canonicalCitationFailureCeiling: 0,
      duplicatePublicationCeiling: 0,
      maxCallsPerRun: 5000,
      maxInputTokensPerRun: 1000000,
      maxOutputTokensPerRun: 100000,
      maxSpendCents: 0,
      maxCaseWallTimeMs: 10000,
      maxRunWallTimeMs: 600000,
      maxWindowsPerCorpus: 1000,
      maxScoredWindowsPerCorpus: 50,
      maxSourcesPerCorpus: 10,
    };
    const manifest = frozenManifestSchema.parse({
      version: "ask-evaluation-v1",
      mode: "fake_only",
      corpusSha256: development.corpusSha256,
      splitSha256: hash(["dev_topic"]),
      sourceManifestSha256: hash(development.sources),
      chunkerVersion: "lexical-original-v1",
      dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
      lexicalRank: "first_matched_window_source_order_not_relevance",
      refWindowMappingSha256: hash(
        development.sources.flatMap((row) => row.windows),
      ),
      baselineSourceCommit: "2e46128b46eebe451979c8e4fcab562fcd8ab109",
      candidate,
      envelope,
      configurationSha256: hash({ candidate, envelope }),
    });
    const widenedDefinition = {
      ...fixtureDefinition,
      cases: fixtureDefinition.cases.map((item) => ({
        ...item,
        request: {
          operation: "passages",
          scope: {
            sources: [
              {
                workspaceId: source.workspaceId,
                sourceId: randomUUID(),
                kind: source.kind,
                revision: source.revision,
                contentHash: source.contentHash,
                locator: null,
              },
            ],
          },
          query: "maintenance routing",
          limit: 50,
        },
      })),
    };
    const widened = frozenCorpusSchema.parse({
      ...widenedDefinition,
      corpusSha256: hash(widenedDefinition),
    });
    let unauthorizedReads = 0;
    await expect(
      runEvaluation({
        phase: "development_baseline",
        manifest: { ...manifest, corpusSha256: widened.corpusSha256 },
        development: widened,
        publicReads: {
          read: async (actor, path, body) => {
            unauthorizedReads++;
            return post(path, body);
          },
        },
      }),
    ).rejects.toThrow("manifest_mismatch");
    expect(unauthorizedReads).toBe(0);
    const report = await runEvaluation({
      phase: "development_baseline",
      manifest,
      development,
      publicReads: {
        read: async (actor, path, body) => {
          expect(actor).toBe("dev_actor");
          return post(path, body);
        },
      },
    });
    expect(report.baselineMeasured).toBe(true);
    expect(report.caseResults).toHaveLength(1);
    expect(report.caseResults[0]).toMatchObject({
      caseId: "dev_topic",
      path: "lexical",
      recallAt10: 1,
      precisionAt10: 1,
      ndcgAt10: 1,
      qualityScoringState: "scored",
      validCitations: 1,
      invalidCitations: 0,
      failures: [],
      usage: {
        outcome: "observed",
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reservedCents: "0",
        observedCents: "0",
      },
    });
    expect(report.realVectorMeasured).toBe(false);
    expect(report.realModelMeasured).toBe(false);
    expect(report.activationAllowed).toBe(false);
    let releaseRead: (() => void) | undefined;
    const waiting = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const pending = runEvaluation({
      phase: "development_baseline",
      manifest,
      development,
      publicReads: {
        read: async (actor, path, body) => {
          const response = await post(path, body);
          await waiting;
          return response;
        },
      },
    });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const outcome = await Promise.race([
        pending,
        new Promise<"blocked">((resolve) => {
          watchdog = setTimeout(() => resolve("blocked"), 12000);
        }),
      ]);
      expect(outcome).not.toBe("blocked");
      if (outcome !== "blocked")
        expect(outcome.caseResults[0]).toMatchObject({
          qualityScoringState: "failed",
          recallAt10: null,
          failures: [{ code: "case_timeout", stage: "canonical_read" }],
        });
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      releaseRead?.();
      await pending;
    }
  } finally {
    await fixture.stop();
  }
}, 20000);

it("checks an independently seeded exact opportunity baseline without semantic inference", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const person = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Synthetic Development Person",
    });
    expect(person.status).toBe(200);
    const personId = (person.body as { result: { personId: string } }).result
      .personId;
    const text = "Maintenance routing needs a clearer process.";
    const selection = {
      text,
      subtype: "pasted_text",
      label: "Synthetic evaluation note",
      direction: "unknown",
      participants: [],
      occurredAt: null,
      attachments: [],
    };
    const preview = await post("/crm/imports/preview", selection);
    expect(preview.status).toBe(200);
    const committed = await post("/crm/imports/commit", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...selection,
      personId,
      firmId: null,
      importKey: randomUUID(),
      previewHash: (preview.body as { previewHash: string }).previewHash,
      parserVersion: "selected-v1",
    });
    expect(committed.status).toBe(200);
    const sourceId = (committed.body as { result: { sourceId: string } }).result
      .sourceId;
    const contentHash = createHash("sha256").update(text).digest("hex");
    const sourceRead = await post("/crm/processing/source/read", {
      workspaceId: fixture.alpha.workspaceId,
      sourceId,
      kind: "selected_note",
      revision: 1,
      contentHash,
      locator: `text:0:${text.length}`,
    });
    expect(sourceRead.status).toBe(200);
    const source = crmResolvedSourceSchema.parse(sourceRead.body).source;
    const firmId = await seedFirm(fixture, {
      name: "Synthetic exact case",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    const opened = await post("/opportunities/v2/open", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      firmId,
      name: "Synthetic pilot",
      stageKey: "new",
    });
    expect(opened.status).toBe(200);
    const opportunityId = (opened.body as { result: { opportunityId: string } })
      .result.opportunityId;
    await fixture.db.query(
      "UPDATE opportunities SET opened_at='2026-10-01T14:00:00Z' WHERE workspace_id=$1 AND id=$2",
      [fixture.alpha.workspaceId, opportunityId],
    );
    const fixtureDefinition = {
      id: "dev_corpus",
      fixtureVersion: "synthetic-v1",
      sources: [
        {
          id: "dev_note",
          kind: "selected_note",
          setupId: "synthetic_selected_note",
          originalSha256: contentHash,
          windows: [
            {
              id: "dev_window",
              source,
              textSha256: contentHash,
              chunkerVersion: "lexical-original-v1",
              ordinal: 0,
            },
          ],
        },
      ],
      cases: [
        {
          id: "dev_topic",
          category: "exact_state",
          actorFixtureId: "dev_actor",
          corpusId: "dev_corpus",
          request: {
            operation: "opportunities",
            scope: { firmId },
            status: "open",
            limit: 20,
          },
          relevance: [{ windowId: "dev_window", grade: 2 }],
          acceptableClaims: [],
          mustAbstain: false,
          exactExpected: {
            operation: "opportunities",
            scope: { firmId },
            dateBasis: "opportunity_opened_at",
            count: "1",
            records: [
              {
                opportunityId,
                firmId,
                name: "Synthetic pilot",
                status: "open",
                stageKey: "new",
                openedAt: "2026-10-01T14:00:00.000Z",
              },
            ],
            truncated: false,
            coverage: {
              scope: "current_permitted_crm_state",
              acquisition: "unverified",
              semantic: "not_requested",
            },
          },
          labelVersion: "independent-v1",
          labelAuthoringState: "independent_before_candidate_outputs",
          lifecycleScenario: "none",
        },
      ],
    };
    const development = frozenCorpusSchema.parse({
      ...fixtureDefinition,
      corpusSha256: hash(fixtureDefinition),
    });
    const candidate = {
      embeddingId: "fake_embedding",
      embeddingVersion: "v1",
      dimensions: 2,
      answerId: "fake_answer",
      answerVersion: "v1",
      vectorMetric: "cosine",
      fusion: "rrf",
      rrfConstant: 60,
      k: 10,
      textConfiguration: "simple",
    };
    const envelope = {
      version: "synthetic-orchestration-v1",
      criticalFailureCeiling: 0,
      exactMismatchCeiling: 0,
      canonicalCitationFailureCeiling: 0,
      duplicatePublicationCeiling: 0,
      maxCallsPerRun: 5000,
      maxInputTokensPerRun: 1000000,
      maxOutputTokensPerRun: 100000,
      maxSpendCents: 0,
      maxCaseWallTimeMs: 10000,
      maxRunWallTimeMs: 600000,
      maxWindowsPerCorpus: 1000,
      maxScoredWindowsPerCorpus: 50,
      maxSourcesPerCorpus: 10,
    };
    const manifest = frozenManifestSchema.parse({
      version: "ask-evaluation-v1",
      mode: "fake_only",
      corpusSha256: development.corpusSha256,
      splitSha256: hash(["dev_topic"]),
      sourceManifestSha256: hash(development.sources),
      chunkerVersion: "lexical-original-v1",
      dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
      lexicalRank: "first_matched_window_source_order_not_relevance",
      refWindowMappingSha256: hash(
        development.sources.flatMap((row) => row.windows),
      ),
      baselineSourceCommit: "2e46128b46eebe451979c8e4fcab562fcd8ab109",
      candidate,
      envelope,
      configurationSha256: hash({ candidate, envelope }),
    });
    const report = await runEvaluation({
      phase: "development_baseline",
      manifest,
      development,
      publicReads: {
        read: async (actor, path, body) => {
          expect(actor).toBe("dev_actor");
          return post(path, body);
        },
      },
    });
    expect(report.baselineMeasured).toBe(true);
    expect(report.syntheticOrchestrationPassed).toBe(true);
    expect(report.caseResults).toHaveLength(1);
    expect(report.caseResults[0]).toMatchObject({
      caseId: "dev_topic",
      path: "exact_sql",
      recallAt10: null,
      precisionAt10: null,
      ndcgAt10: null,
      qualityScoringState: "scored",
      validCitations: 0,
      invalidCitations: 0,
      failures: [],
      usage: {
        outcome: "observed",
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reservedCents: "0",
        observedCents: "0",
      },
    });
    expect(report.realVectorMeasured).toBe(false);
    expect(report.realModelMeasured).toBe(false);
    expect(report.activationAllowed).toBe(false);
  } finally {
    await fixture.stop();
  }
});

it("measures all eighty isolated development baselines without loading sealed holdout gold", async () => {
  const fixture = await createAuthFixture();
  try {
    const {
      DEVELOPMENT_COMPARISON_LABELS,
      DEVELOPMENT_COMPARISON_LABEL_SHA256,
    } = await import("../../../tools/ask-evaluation/labels.ts");
    const { runDevelopmentSuite } =
      await import("../../../tools/ask-evaluation/runner.ts");
    const { developmentSuiteSchema } =
      await import("../../../tools/ask-evaluation/contracts.ts");
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    const { createNativeCrmMailEvidence } =
      await import("@fss/domain/crm/nativeMailEvidence.ts");
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          crmMailEvidence: createNativeCrmMailEvidence(),
        },
      );
    const cases: DevelopmentCaseRuntime[] = [];
    const candidate = {
      embeddingId: "fake_embedding",
      embeddingVersion: "v1",
      dimensions: 2,
      answerId: "fake_answer",
      answerVersion: "v1",
      vectorMetric: "cosine",
      fusion: "rrf",
      rrfConstant: 60,
      k: 10,
      textConfiguration: "simple",
    };
    const envelope = {
      version: "synthetic-orchestration-v1",
      criticalFailureCeiling: 0,
      exactMismatchCeiling: 0,
      canonicalCitationFailureCeiling: 0,
      duplicatePublicationCeiling: 0,
      maxCallsPerRun: 5000,
      maxInputTokensPerRun: 1000000,
      maxOutputTokensPerRun: 100000,
      maxSpendCents: 0,
      maxCaseWallTimeMs: 10000,
      maxRunWallTimeMs: 600000,
      maxWindowsPerCorpus: 1000,
      maxScoredWindowsPerCorpus: 50,
      maxSourcesPerCorpus: 10,
    };
    let cleanups = 0;
    let runnerReads = 0;
    for (const [index, label] of DEVELOPMENT_COMPARISON_LABELS.entries()) {
      const { firmId, copies, opportunityRecords } = await setupEvaluationCase(
        fixture,
        post,
        label,
        index,
      );
      const { sourceId, source } = copies[0]!;
      const caseLookups = copies.map(({ source }) => ({
        workspaceId: source.workspaceId,
        sourceId: source.sourceId,
        kind: source.kind,
        revision: source.revision,
        contentHash: source.contentHash,
        locator: null,
      }));
      let exactExpected: unknown = null;
      let request: unknown = {
        operation: "passages",
        scope: { sources: caseLookups },
        query: label.query,
        limit: 50,
      };
      if (label.expectedOpenOpportunities !== null) {
        request = {
          operation: "opportunities",
          scope: { firmId },
          status: "open",
          limit: 20,
        };
        exactExpected = {
          operation: "opportunities",
          scope: { firmId },
          dateBasis: "opportunity_opened_at",
          count: "2",
          records: opportunityRecords,
          truncated: false,
          coverage: {
            scope: "current_permitted_crm_state",
            acquisition: "unverified",
            semantic: "not_requested",
          },
        };
      }
      const corpusDefinition = {
        id: `${label.caseId}_corpus`,
        fixtureVersion: "synthetic-v1",
        sources: copies.map((copy) => ({
          id: `${label.caseId}_source_${copy.slot}`,
          kind: label.sourceKind,
          setupId: `synthetic_${label.sourceKind === "mail" ? "copied_mail" : label.sourceKind}`,
          originalSha256: copy.contentHash,
          windows: [
            {
              id: `${label.caseId}_window_${copy.slot}`,
              source: copy.source,
              textSha256: hashText(copy.text),
              chunkerVersion: "lexical-original-v1",
              ordinal: copy.ordinal,
            },
          ],
        })),
        cases: [
          {
            id: label.caseId,
            category: label.category,
            actorFixtureId: `${label.caseId}_actor`,
            corpusId: `${label.caseId}_corpus`,
            request,
            relevance: label.sourceLabels.map((gold) => ({
              windowId: `${label.caseId}_window_${gold.slot}`,
              grade: gold.relevanceGrade,
            })),
            acceptableClaims:
              label.acceptableClaimText.length === 0
                ? []
                : [
                    {
                      id: `${label.caseId}_claim`,
                      acceptableTextVariants: label.acceptableClaimText,
                      supportedBy: [`${label.caseId}_window_original`],
                      forbiddenTextVariants: label.forbiddenClaimText,
                    },
                  ],
            mustAbstain: label.lifecycleScenario !== "none",
            expectedRefusal:
              label.lifecycleScenario === "none"
                ? null
                : {
                    stage: "final_read",
                    code: "source_unavailable",
                    scenario: label.lifecycleScenario,
                  },
            exactExpected,
            labelVersion: "independent-v1",
            labelAuthoringState: "independent_before_candidate_outputs",
            lifecycleScenario: label.lifecycleScenario,
          },
        ],
      };
      const canonicalDefinition = frozenCorpusSchema
        .omit({ corpusSha256: true })
        .parse(corpusDefinition);
      const development = frozenCorpusSchema.parse({
        ...canonicalDefinition,
        corpusSha256: hash(canonicalDefinition),
      });
      const manifest = frozenManifestSchema.parse({
        version: "ask-evaluation-v1",
        mode: "fake_only",
        corpusSha256: development.corpusSha256,
        splitSha256: hash([label.caseId]),
        sourceManifestSha256: hash(development.sources),
        chunkerVersion: "lexical-original-v1",
        dedupUnit: "trim_whitespace_lowercase_en_us_text_group",
        lexicalRank: "first_matched_window_source_order_not_relevance",
        refWindowMappingSha256: hash(
          development.sources.flatMap((row) => row.windows),
        ),
        baselineSourceCommit: "2e46128b46eebe451979c8e4fcab562fcd8ab109",
        candidate,
        envelope,
        configurationSha256: hash({ candidate, envelope }),
      });
      let changed = false;
      cases.push({
        independentLabel: label,
        input: {
          phase: "development_baseline",
          manifest,
          development,
          publicReads: {
            read: async (actor, path, body) => {
              runnerReads++;
              expect(actor).toBe(`${label.caseId}_actor`);
              const response = await post(path, body);
              if (
                path === "/ask/read" &&
                !changed &&
                label.lifecycleScenario !== "none"
              ) {
                changed = true;
                if (source.kind === "selected_note") {
                  await post("/crm/people/source/delete", {
                    commandId: randomUUID(),
                    clientVersion: CURRENT_CLIENT_VERSION,
                    personId: (
                      await fixture.db.query<{ person_id: string }>(
                        "SELECT person_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2",
                        [fixture.alpha.workspaceId, sourceId],
                      )
                    ).rows[0]!.person_id,
                    sourceId,
                    expectedRevision: 1,
                  });
                } else if (source.kind === "mail")
                  await post("/crm/business/mail/delete", {
                    commandId: randomUUID(),
                    clientVersion: CURRENT_CLIENT_VERSION,
                    sourceId,
                    expectedRevision: 1,
                  });
                else if (source.kind === "call_transcript")
                  await fixture.db.query(
                    "DELETE FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2",
                    [fixture.alpha.workspaceId, sourceId],
                  );
                else
                  await fixture.db.query(
                    "UPDATE meeting_transcripts SET version=version+1 WHERE workspace_id=$1 AND id=$2",
                    [fixture.alpha.workspaceId, sourceId],
                  );
              }
              return response;
            },
          },
        },
        cleanup: async () => {
          cleanups++;
        },
      });
    }
    await fixture.db.query(
      "UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND owner_user_id=$2",
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId],
    );
    const definition = {
      version: "ask-evaluation-development-v1",
      suiteId: "dev_baseline_suite",
      fixtureVersion: "synthetic-v1",
      caseBindings: cases.map((runtime) => ({
        caseId: runtime.independentLabel.caseId,
        split: "development",
        corpusSha256: runtime.input.development.corpusSha256,
        sourceManifestSha256: runtime.input.manifest.sourceManifestSha256,
        labelSha256: hash(runtime.independentLabel),
      })),
      labelSha256: DEVELOPMENT_COMPARISON_LABEL_SHA256,
    };
    const suite = developmentSuiteSchema.parse({
      ...definition,
      suiteSha256: hash(definition),
    });
    if (process.env["ASK_EVALUATION_EXPORT_BASELINE"] === "1")
      await writeFile(
        new URL(
          "../../../.context/492-development-freeze-v2.json",
          import.meta.url,
        ),
        JSON.stringify(
          {
            suite,
            labelsSha256: DEVELOPMENT_COMPARISON_LABEL_SHA256,
            caseManifests: cases.map((runtime) => ({
              manifest: runtime.input.manifest,
              corpus: runtime.input.development,
              label: runtime.independentLabel,
            })),
          },
          null,
          2,
        ),
      );
    const corrupted = {
      ...definition,
      caseBindings: definition.caseBindings.map((binding, index) =>
        index === 79 ? { ...binding, labelSha256: hash("changed") } : binding,
      ),
    };
    await expect(
      runDevelopmentSuite({
        suite: developmentSuiteSchema.parse({
          ...corrupted,
          suiteSha256: hash(corrupted),
        }),
        cases,
      }),
    ).rejects.toThrow("manifest_mismatch");
    expect(runnerReads).toBe(0);
    expect(cleanups).toBe(80);
    const changedCases = cases.map((runtime, index) => {
      if (index !== 79) return runtime;
      const { corpusSha256: _corpusSha256, ...original } =
        runtime.input.development;
      const changed = {
        ...original,
        cases: original.cases.map((item) => ({
          ...item,
          request:
            item.request.operation === "passages"
              ? { ...item.request, query: "independent gold was replaced" }
              : item.request,
        })),
      };
      const canonical = frozenCorpusSchema
        .omit({ corpusSha256: true })
        .parse(changed);
      const development = frozenCorpusSchema.parse({
        ...canonical,
        corpusSha256: hash(canonical),
      });
      return {
        ...runtime,
        input: {
          ...runtime.input,
          development,
          manifest: {
            ...runtime.input.manifest,
            corpusSha256: development.corpusSha256,
          },
        },
      };
    });
    const changedDefinition = {
      ...definition,
      caseBindings: definition.caseBindings.map((binding, index) => ({
        ...binding,
        corpusSha256: changedCases[index]!.input.development.corpusSha256,
      })),
    };
    await expect(
      runDevelopmentSuite({
        suite: developmentSuiteSchema.parse({
          ...changedDefinition,
          suiteSha256: hash(changedDefinition),
        }),
        cases: changedCases,
      }),
    ).rejects.toThrow("manifest_mismatch");
    expect(runnerReads).toBe(0);
    expect(cleanups).toBe(160);
    cleanups = 0;
    const report = await runDevelopmentSuite({ suite, cases });
    if (process.env["ASK_EVALUATION_EXPORT_BASELINE"] === "1")
      await writeFile(
        new URL(
          "../../../.context/492-development-baseline-v2.json",
          import.meta.url,
        ),
        JSON.stringify(report, null, 2),
      );
    expect(report.caseResults).toHaveLength(80);
    expect(report).toMatchObject({
      syntheticOrchestrationPassed: false,
      syntheticControlsPassed: true,
      expectedRefusalCount: 10,
      criticalControlFailureCount: 0,
    });
    expect(cleanups).toBe(80);
    expect(
      report.categorySummaries.map((row) => [row.category, row.caseCount]),
    ).toEqual([
      ["exact_state", 10],
      ["topic", 10],
      ["identity", 10],
      ["citation", 10],
      ["evidence_quality", 10],
      ["access_lifecycle", 10],
      ["injection", 10],
      ["operations", 10],
    ]);
    expect(
      report.caseResults
        .filter((row) => row.category === "exact_state")
        .every((row) => row.path === "exact_sql" && row.failures.length === 0),
    ).toBe(true);
    expect(
      report.caseResults
        .filter((row) => row.category === "access_lifecycle")
        .every(
          (row) =>
            row.qualityScoringState === "failed" &&
            row.failures.some((failure) => failure.stage === "final_read"),
        ),
    ).toBe(true);
    expect(
      report.caseResults
        .filter((row) => row.category === "topic")
        .map((row) => row.recallAt10),
    ).toEqual([1, 0, 1, 0, 1, 0, 1, 0, 1, 0]);
    expect(
      report.caseResults.every(
        (row) => row.usage.calls === 0 && row.usage.reservedCents === "0",
      ),
    ).toBe(true);
    expect(
      report.caseResults
        .filter((row) => row.category === "topic" && row.recallAt10 === 1)
        .every(
          (row) => row.precisionAt10 === 2 / 3 && row.validCitations === 4,
        ),
    ).toBe(true);
    expect(report.realVectorMeasured).toBe(false);
    expect(report.realModelMeasured).toBe(false);
    expect(report.activationAllowed).toBe(false);
    let elapsed = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);
    const expiredCases = cases.map((runtime) => ({
      ...runtime,
      input: {
        ...runtime.input,
        publicReads: {
          read: async (
            actor: string,
            path: "/ask/read" | "/crm/processing/source/read",
            body: unknown,
          ) => {
            const response = await runtime.input.publicReads.read(
              actor,
              path,
              body,
            );
            elapsed = 600001;
            return response;
          },
        },
      },
    }));
    try {
      const exhausted = await runDevelopmentSuite({
        suite,
        cases: expiredCases,
      });
      expect(exhausted.caseResults[0]).toMatchObject({
        durationMs: 600001,
        failures: [{ code: "run_timeout", stage: "canonical_read" }],
        qualityScoringState: "failed",
        recallAt10: null,
      });
      expect(
        exhausted.caseResults
          .slice(1)
          .every((result) =>
            result.failures.some((failure) => failure.code === "run_timeout"),
          ),
      ).toBe(true);
    } finally {
      clock.mockRestore();
    }
  } finally {
    await fixture.stop();
  }
}, 120000);
