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
const hashText = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

it("refuses quality scoring when a rehashed frozen corpus omits copied-source text windows", async () => {
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
    const firstWindow =
      "Maintenance routing needs a clearer process. " +
      "x".repeat(2000 - "Maintenance routing needs a clearer process. ".length);
    const text =
      firstWindow +
      "Repair coordination requires additional planning. " +
      "y".repeat(451);
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
      locator: `text:0:${firstWindow.length}`,
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
              textSha256: hashText(firstWindow),
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
    const report = await runEvaluation({
      phase: "development_baseline",
      manifest,
      development,
      publicReads: { read: async (actor, path, body) => post(path, body) },
    });
    expect(report.caseResults[0]!.qualityScoringState).not.toBe("scored");
    expect(report.caseResults[0]!.recallAt10).toBeNull();
  } finally {
    await fixture.stop();
  }
});
it("scores all canonical citations retained by normalized duplicate text groups", async () => {
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
    const duplicateText = "maintenance   routing needs a clearer process.";
    const duplicateSelection = { ...selection, text: duplicateText };
    const duplicatePreview = await post(
      "/crm/imports/preview",
      duplicateSelection,
    );
    expect(duplicatePreview.status).toBe(200);
    const duplicate = await post("/crm/imports/commit", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...duplicateSelection,
      personId,
      firmId: null,
      importKey: randomUUID(),
      previewHash: (duplicatePreview.body as { previewHash: string })
        .previewHash,
      parserVersion: "selected-v1",
    });
    expect(duplicate.status).toBe(200);
    const duplicateId = (duplicate.body as { result: { sourceId: string } })
      .result.sourceId;
    const duplicateHash = hashText(duplicateText);
    const duplicateRead = await post("/crm/processing/source/read", {
      workspaceId: fixture.alpha.workspaceId,
      sourceId: duplicateId,
      kind: "selected_note",
      revision: 1,
      contentHash: duplicateHash,
      locator: `text:0:${duplicateText.length}`,
    });
    expect(duplicateRead.status).toBe(200);
    const duplicateSource = crmResolvedSourceSchema.parse(
      duplicateRead.body,
    ).source;
    fixtureDefinition.sources.push({
      id: "dev_duplicate",
      kind: "selected_note",
      setupId: "synthetic_selected_note",
      originalSha256: duplicateHash,
      windows: [
        {
          id: "dev_duplicate_window",
          source: duplicateSource,
          textSha256: duplicateHash,
          chunkerVersion: "lexical-original-v1",
          ordinal: 1,
        },
      ],
    });
    fixtureDefinition.cases[0]!.request.scope.sources.push({
      workspaceId: duplicateSource.workspaceId,
      sourceId: duplicateSource.sourceId,
      kind: duplicateSource.kind,
      revision: duplicateSource.revision,
      contentHash: duplicateSource.contentHash,
      locator: null,
    });
    fixtureDefinition.cases[0]!.relevance.push({
      windowId: "dev_duplicate_window",
      grade: 2,
    });
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
      publicReads: { read: async (actor, path, body) => post(path, body) },
    });
    expect(report.caseResults[0]!).toMatchObject({
      qualityScoringState: "scored",
      invalidCitations: 0,
      validCitations: 2,
      recallAt10: 1,
    });
  } finally {
    await fixture.stop();
  }
});
it("reports a frozen deadline exceeded by the final successful public read", async () => {
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
    let elapsed = 0;
    let reads = 0;
    const clock = vi
      .spyOn(performance, "now")
      .mockImplementation(() => elapsed);
    try {
      const report = await runEvaluation({
        phase: "development_baseline",
        manifest,
        development,
        publicReads: {
          read: async (actor, path, body) => {
            const response = await post(path, body);
            reads++;
            if (reads === 3) elapsed = 10001;
            return response;
          },
        },
      });
      expect(report.caseResults[0]!).toMatchObject({
        qualityScoringState: "failed",
        recallAt10: null,
        failures: [{ code: "case_timeout", stage: "final_read" }],
      });
    } finally {
      clock.mockRestore();
    }
  } finally {
    await fixture.stop();
  }
});
