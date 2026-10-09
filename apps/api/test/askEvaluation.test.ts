import type {
  EvaluationGuard,
  EvaluationUsage,
  EvaluationAnswerAdapter,
} from "../../../tools/ask-evaluation/contracts.ts";
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
    let fakeAttempts = 0;
    const unknownGuard = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: {
        purpose: {
          state: "fake_only",
          purpose: "crm_retrieval_evaluation",
          realCallsAllowed: false,
          maxSpendCents: 0,
          reason: "fake_only",
        },
        reservation: { calls: 1, inputTokens: 100, outputTokens: 50 },
        priorUsage: {
          outcome: "observed",
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
        answer: {
          kind: "fake",
          id: "fake_answer",
          version: "v1",
          answer: async () => {
            fakeAttempts++;
            return {
              claims: [],
              abstained: true,
              usage: {
                outcome: "unknown",
                calls: 1,
                inputTokens: 1,
                outputTokens: 0,
                reservedCents: "0",
                observedCents: null,
              },
            };
          },
        },
      },
    });
    expect(fakeAttempts).toBe(1);
    expect(unknownGuard).toMatchObject({
      modelEvaluationState: "guard_only",
      baselineMeasured: false,
    });
    expect(unknownGuard.caseResults[0]).toMatchObject({
      qualityScoringState: "failed",
      recallAt10: null,
      publishedClaimCount: 0,
      publishedCitationCount: 0,
      usage: {
        outcome: "unknown",
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
        observedCents: null,
      },
      failures: [{ code: "unknown_acceptance", stage: "answer" }],
    });
    const fakeGuard = (
      answer: EvaluationAnswerAdapter["answer"],
      priorUsage: EvaluationUsage = {
        outcome: "observed",
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        reservedCents: "0",
        observedCents: "0",
      },
    ): EvaluationGuard => ({
      purpose: {
        state: "fake_only",
        purpose: "crm_retrieval_evaluation",
        realCallsAllowed: false,
        maxSpendCents: 0,
        reason: "fake_only",
      },
      reservation: { calls: 1, inputTokens: 100, outputTokens: 50 },
      priorUsage,
      answer: { kind: "fake", id: "fake_answer", version: "v1", answer },
    });
    for (const [prior, code] of [
      [
        {
          outcome: "observed",
          calls: 5000,
          inputTokens: 0,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
        "call_limit",
      ],
      [
        {
          outcome: "observed",
          calls: 0,
          inputTokens: 1000000,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
        "token_limit",
      ],
      [
        {
          outcome: "observed",
          calls: 0,
          inputTokens: 0,
          outputTokens: 100000,
          reservedCents: "0",
          observedCents: "0",
        },
        "token_limit",
      ],
      [unknownGuard.caseResults[0]!.usage, "unknown_acceptance"],
    ] satisfies [EvaluationUsage, string][]) {
      let called = 0;
      const refused = await runEvaluation({
        phase: "guard_only",
        manifest,
        development,
        publicReads: { read: async (actor, path, body) => post(path, body) },
        guard: fakeGuard(async () => {
          called++;
          throw new Error("must_not_call");
        }, prior),
      });
      expect(called).toBe(0);
      expect(refused.caseResults[0]!.usage).toEqual(prior);
      expect(refused.caseResults[0]!.failures).toEqual([
        { code, stage: "answer" },
      ]);
    }
    const invalidReceipt = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(async () => ({
        claims: [],
        abstained: true,
        usage: {
          outcome: "observed",
          calls: 1,
          inputTokens: Number.NaN,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
      })),
    });
    expect(invalidReceipt.caseResults[0]).toMatchObject({
      usage: {
        outcome: "unknown",
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
      },
      failures: [{ code: "invalid_adapter_output", stage: "answer" }],
      publishedClaimCount: 0,
    });
    for (const code of [
      "real_purpose_unverified",
      "invalid_adapter_output",
    ] as const) {
      let publicReadCount = 0;
      let adapterCallCount = 0;
      const deniedGuard = fakeGuard(async () => {
        adapterCallCount++;
        throw new Error("must_not_call");
      });
      if (code === "real_purpose_unverified")
        deniedGuard.purpose = {
          state: "real_unavailable",
          purpose: "crm_retrieval_evaluation",
          realCallsAllowed: false,
          maxSpendCents: 0,
          reason: "purpose_configuration_unverified",
        };
      else
        deniedGuard.answer = {
          ...deniedGuard.answer,
          version: "unfrozen-version",
        };
      const denied = await runEvaluation({
        phase: "guard_only",
        manifest,
        development,
        guard: deniedGuard,
        publicReads: {
          read: async (actor, path, body) => {
            publicReadCount++;
            return post(path, body);
          },
        },
      });
      expect(publicReadCount).toBe(0);
      expect(adapterCallCount).toBe(0);
      expect(denied.caseResults[0]).toMatchObject({
        usage: {
          outcome: "observed",
          calls: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
        failures: [{ code, stage: "answer" }],
        publishedClaimCount: 0,
        publishedCitationCount: 0,
      });
    }
    const thrownReceipt = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(async () => {
        throw new Error("private_adapter_error");
      }),
    });
    expect(thrownReceipt.caseResults[0]).toMatchObject({
      usage: {
        outcome: "unknown",
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
      },
      failures: [{ code: "unknown_acceptance", stage: "answer" }],
      publishedClaimCount: 0,
      publishedCitationCount: 0,
    });
    expect(JSON.stringify(thrownReceipt)).not.toContain(
      "private_adapter_error",
    );
    const unknownCitation = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(async () => ({
        claims: [
          { text: "Untrusted synthetic claim", windowIds: ["unknown_window"] },
        ],
        abstained: false,
        usage: {
          outcome: "observed",
          calls: 1,
          inputTokens: 1,
          outputTokens: 1,
          reservedCents: "0",
          observedCents: "0",
        },
      })),
    });
    expect(unknownCitation.caseResults[0]).toMatchObject({
      usage: {
        outcome: "observed",
        calls: 1,
        inputTokens: 100,
        outputTokens: 50,
      },
      failures: [{ code: "unknown_citation", stage: "answer" }],
      publishedClaimCount: 0,
      publishedCitationCount: 0,
    });
    expect(JSON.stringify(unknownCitation)).not.toContain(
      "Untrusted synthetic claim",
    );
    const overshoot = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(async () => ({
        claims: [],
        abstained: true,
        usage: {
          outcome: "observed",
          calls: 1,
          inputTokens: 200,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
      })),
    });
    expect(overshoot.caseResults[0]).toMatchObject({
      usage: {
        outcome: "observed",
        calls: 1,
        inputTokens: 200,
        outputTokens: 50,
      },
      failures: [{ code: "token_limit", stage: "answer" }],
      publishedClaimCount: 0,
    });
    const unrepresentable = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(
        async () => ({
          claims: [],
          abstained: true,
          usage: {
            outcome: "observed",
            calls: 1,
            inputTokens: Number.MAX_SAFE_INTEGER,
            outputTokens: 0,
            reservedCents: "0",
            observedCents: "0",
          },
        }),
        {
          outcome: "observed",
          calls: 1,
          inputTokens: 1000,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
      ),
    });
    expect(unrepresentable.caseResults[0]).toMatchObject({
      usage: {
        outcome: "unknown",
        calls: 2,
        inputTokens: 1100,
        outputTokens: 50,
      },
      failures: [{ code: "invalid_adapter_output", stage: "answer" }],
      publishedClaimCount: 0,
    });
    const repeatedDefinition = {
      ...fixtureDefinition,
      cases: [
        fixtureDefinition.cases[0]!,
        { ...fixtureDefinition.cases[0]!, id: "dev_second_guard_case" },
      ],
    };
    const repeatedCanonical = frozenCorpusSchema
      .omit({ corpusSha256: true })
      .parse(repeatedDefinition);
    const repeatedCorpus = frozenCorpusSchema.parse({
      ...repeatedCanonical,
      corpusSha256: hash(repeatedCanonical),
    });
    let repeatedCalls = 0;
    const repeatedGuard = fakeGuard(async () => {
      repeatedCalls++;
      return {
        claims: [],
        abstained: true,
        usage: {
          outcome: "observed",
          calls: 1,
          inputTokens: 100,
          outputTokens: 0,
          reservedCents: "0",
          observedCents: "0",
        },
      };
    });
    repeatedGuard.reservation.outputTokens = 60000;
    const repeated = await runEvaluation({
      phase: "guard_only",
      manifest: {
        ...manifest,
        corpusSha256: repeatedCorpus.corpusSha256,
        splitSha256: hash(repeatedCorpus.cases.map((item) => item.id)),
      },
      development: repeatedCorpus,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: repeatedGuard,
    });
    expect(repeatedCalls).toBe(1);
    expect(repeated.caseResults[1]).toMatchObject({
      usage: {
        outcome: "observed",
        calls: 1,
        inputTokens: 100,
        outputTokens: 60000,
      },
      failures: [{ code: "token_limit", stage: "answer" }],
      publishedClaimCount: 0,
    });
    let guardClockValue = 0;
    let abortedSignal: AbortSignal | undefined;
    const guardClock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => guardClockValue);
    try {
      const timed = await runEvaluation({
        phase: "guard_only",
        manifest,
        development,
        publicReads: { read: async (actor, path, body) => post(path, body) },
        guard: fakeGuard(async (input, signal) => {
          abortedSignal = signal;
          guardClockValue = 10001;
          return {
            claims: [],
            abstained: true,
            usage: {
              outcome: "observed",
              calls: 1,
              inputTokens: 0,
              outputTokens: 0,
              reservedCents: "0",
              observedCents: "0",
            },
          };
        }),
      });
      expect(abortedSignal?.aborted).toBe(true);
      expect(timed.caseResults[0]).toMatchObject({
        durationMs: 10001,
        usage: {
          outcome: "unknown",
          calls: 1,
          inputTokens: 100,
          outputTokens: 50,
        },
        publishedClaimCount: 0,
      });
      expect(timed.caseResults[0]!.failures).toContainEqual({
        code: "case_timeout",
        stage: "answer",
      });
    } finally {
      guardClock.mockRestore();
    }
    const revoked = await runEvaluation({
      phase: "guard_only",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
      guard: fakeGuard(async () => {
        await fixture.db.query(
          "UPDATE crm_people SET owner_user_id=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
          [fixture.alpha.workspaceId, personId, fixture.alpha.admin.userId],
        );
        return {
          claims: [
            {
              text: "Do not publish this stale statement.",
              windowIds: ["dev_window"],
            },
          ],
          abstained: false,
          usage: {
            outcome: "observed",
            calls: 1,
            inputTokens: 0,
            outputTokens: 0,
            reservedCents: "0",
            observedCents: "0",
          },
        };
      }),
    });
    expect(revoked.caseResults[0]).toMatchObject({
      failures: [{ code: "source_unavailable", stage: "final_read" }],
      publishedClaimCount: 0,
      publishedCitationCount: 0,
      usage: { calls: 1, inputTokens: 100, outputTokens: 50 },
    });
    await fixture.db.query(
      "UPDATE crm_people SET owner_user_id=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2",
      [fixture.alpha.workspaceId, personId, fixture.alpha.salesperson.userId],
    );
    const adminToken = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const adminPost = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${adminToken}` },
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    await fixture.db.query(
      `CREATE FUNCTION evaluation_refuse_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.evidence_source_read' THEN RAISE EXCEPTION 'synthetic_audit_refused'; END IF; RETURN NEW; END $$`,
    );
    await fixture.db.query(
      "CREATE TRIGGER evaluation_refuse_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION evaluation_refuse_audit()",
    );
    let auditAdapterCalls = 0;
    try {
      const audited = await runEvaluation({
        phase: "guard_only",
        manifest,
        development,
        publicReads: {
          read: async (actor, path, body) => adminPost(path, body),
        },
        guard: fakeGuard(async () => {
          auditAdapterCalls++;
          throw new Error("must_not_call");
        }),
      });
      expect(auditAdapterCalls).toBe(0);
      expect(audited.caseResults[0]).toMatchObject({
        failures: [{ code: "adapter_unavailable", stage: "canonical_read" }],
        publishedClaimCount: 0,
        usage: { calls: 0 },
      });
      expect(JSON.stringify(audited)).not.toContain(text);
    } finally {
      await fixture.db.query(
        "DROP TRIGGER evaluation_refuse_audit ON audit_events",
      );
      await fixture.db.query("DROP FUNCTION evaluation_refuse_audit()");
    }
    const largeText = "x".repeat(1000);
    const largeAdded = await post("/crm/people/source/add", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      personId,
      sourceKey: randomUUID(),
      excerpt: largeText,
      occurredAt: "2026-10-01T14:00:00Z",
    });
    expect(largeAdded.status).toBe(200);
    const largeSourceId = (largeAdded.body as { result: { sourceId: string } })
      .result.sourceId;
    const largeHash = hashText(largeText);
    const largeRead = await post("/crm/processing/source/read", {
      workspaceId: fixture.alpha.workspaceId,
      sourceId: largeSourceId,
      kind: "selected_note",
      revision: 1,
      contentHash: largeHash,
      locator: "text:0:1",
    });
    expect(largeRead.status).toBe(200);
    const largeRef = crmResolvedSourceSchema.parse(largeRead.body).source;
    const largeDefinition = {
      id: "dev_large_corpus",
      fixtureVersion: "synthetic-v1",
      sources: [
        {
          id: "dev_large_source",
          kind: "selected_note",
          setupId: "synthetic_selected_note",
          originalSha256: largeHash,
          windows: Array.from({ length: 1000 }, (_, ordinal) => ({
            id: `dev_large_window_${ordinal}`,
            source: { ...largeRef, locator: `text:${ordinal}:${ordinal + 1}` },
            textSha256: hashText("x"),
            chunkerVersion: "lexical-original-v1",
            ordinal,
          })),
        },
      ],
      cases: [
        {
          ...fixtureDefinition.cases[0]!,
          id: "dev_large_case",
          corpusId: "dev_large_corpus",
          relevance: [],
          request: {
            operation: "passages",
            scope: {
              sources: [
                {
                  workspaceId: largeRef.workspaceId,
                  sourceId: largeRef.sourceId,
                  kind: largeRef.kind,
                  revision: largeRef.revision,
                  contentHash: largeRef.contentHash,
                  locator: null,
                },
              ],
            },
            query: "x",
            limit: 50,
          },
        },
      ],
    };
    const canonicalLarge = frozenCorpusSchema
      .omit({ corpusSha256: true })
      .parse(largeDefinition);
    const largeCorpus = frozenCorpusSchema.parse({
      ...canonicalLarge,
      corpusSha256: hash(canonicalLarge),
    });
    expect(
      (
        await post("/crm/people/source/delete", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          personId,
          sourceId: largeSourceId,
          expectedRevision: 1,
        })
      ).status,
    ).toBe(200);
    const largeReport = await runEvaluation({
      phase: "development_baseline",
      development: largeCorpus,
      manifest: {
        ...manifest,
        corpusSha256: largeCorpus.corpusSha256,
        splitSha256: hash(["dev_large_case"]),
        sourceManifestSha256: hash(largeCorpus.sources),
        refWindowMappingSha256: hash(
          largeCorpus.sources.flatMap((row) => row.windows),
        ),
      },
      publicReads: { read: async (actor, path, body) => post(path, body) },
    });
    expect(largeReport.caseResults[0]).toMatchObject({
      qualityScoringState: "censored_source_or_result_cap",
      recallAt10: null,
      failures: [{ code: "corpus_bound", stage: "canonical_read" }],
    });
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
}, 40000);

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
