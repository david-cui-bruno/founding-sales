import type { DevelopmentLabelTemplate } from "../../../tools/ask-evaluation/labels.ts";
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
    const createCopy = async (
      label: DevelopmentLabelTemplate,
      index: number,
      firmId: string,
    ) => {
      let sourceId: string, contentHash: string, locator: string;
      const text = label.originalText;
      if (label.sourceKind === "selected_note") {
        const person = await post("/crm/people/create", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          fullName: label.identityName,
        });
        expect(person.status).toBe(200);
        const personId = (person.body as { result: { personId: string } })
          .result.personId;
        const selected = await post("/crm/people/source/add", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          personId,
          sourceKey: label.caseId,
          excerpt: text,
          occurredAt: "2026-10-01T14:00:00Z",
        });
        expect(selected.status).toBe(200);
        sourceId = (selected.body as { result: { sourceId: string } }).result
          .sourceId;
        contentHash = createHash("sha256").update(text).digest("hex");
        locator = `text:0:${text.length}`;
      } else if (label.sourceKind === "meeting_transcript") {
        const meetingId = randomUUID(),
          recordingId = randomUUID();
        sourceId = randomUUID();
        await fixture.db.query(
          "INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",
          [fixture.alpha.workspaceId, meetingId, firmId],
        );
        const recordingHash = createHash("sha256")
          .update(label.caseId)
          .digest("hex");
        await fixture.db.query(
          "INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status,crm_capture_owner_user_id) VALUES($1,$2,$3,1,'Synthetic meeting',$4,100,$5,'ready',$6)",
          [
            fixture.alpha.workspaceId,
            recordingId,
            meetingId,
            recordingHash,
            `meetings/${meetingId}/${recordingHash}.m4a`,
            fixture.alpha.salesperson.userId,
          ],
        );
        const utterances = [
          {
            startMs: 0,
            endMs: 5000,
            text,
            speaker: "Speaker 1",
            attribution: "unknown",
          },
        ];
        await fixture.db.query(
          "INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",
          [
            fixture.alpha.workspaceId,
            sourceId,
            recordingId,
            JSON.stringify(utterances),
          ],
        );
        contentHash = createHash("sha256")
          .update(JSON.stringify(utterances))
          .digest("hex");
        locator = `utterance:0:text:0:${text.length}`;
      } else if (label.sourceKind === "call_transcript") {
        const ws = fixture.alpha.workspaceId,
          user = fixture.alpha.salesperson.userId;
        sourceId = randomUUID();
        const phone = `+14015550${String(index + 100).padStart(3, "0")}`;
        const route = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,$3,'research_provider',now(),0.9,'passed','usable','fixture.1') RETURNING id",
            [ws, firmId, phone],
          )
        ).rows[0]!.id;
        const identity = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,$3,'verified',false,now(),$2,'owner_attestation') RETURNING id",
            [ws, user, phone],
          )
        ).rows[0]!.id;
        const existing = (
          await fixture.db.query<{ id: string }>(
            "SELECT id FROM state_postures WHERE workspace_id=$1 AND state='RI'",
            [ws],
          )
        ).rows[0];
        const posture =
          existing?.id ??
          (
            await fixture.db.query<{ id: string }>(
              "INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",
              [ws, fixture.alpha.admin.userId],
            )
          ).rows[0]!.id;
        const device = (
          await fixture.db.query<{ id: string }>(
            "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
            [ws, user],
          )
        ).rows[0]!.id;
        const ticket = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,$2,$3,$4,1,$5,1,$6,$7,$8,$7,$9,'America/New_York',now()+interval '30 seconds') RETURNING id",
            [
              ws,
              label.caseId,
              firmId,
              route,
              posture,
              identity,
              user,
              device,
              phone,
            ],
          )
        ).rows[0]!.id;
        const reservation = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",
            [ws, sourceId],
          )
        ).rows[0]!.id;
        await fixture.db.query(
          "INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",
          [ws, sourceId, ticket, firmId, user, reservation],
        );
        const utterances = [{ speaker: 1, start: 0, end: 5, text }];
        await fixture.db.query(
          "INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",
          [ws, sourceId, JSON.stringify(utterances)],
        );
        contentHash = createHash("sha256")
          .update(JSON.stringify(utterances))
          .digest("hex");
        locator = `utterance:0:text:0:${text.length}`;
      } else {
        const ws = fixture.alpha.workspaceId,
          user = fixture.alpha.salesperson.userId;
        const { businessAccountBinding } =
          await import("@fss/domain/business/acquisition.ts");
        const { enqueueJob, claimJobs } =
          await import("@fss/domain/jobs/jobStore.ts");
        const { businessMailCaptureHandler } =
          await import("@fss/domain/mail/crmSources.ts");
        const { workspaceScope } =
          await import("@fss/domain/db/workspaceScope.ts");
        const account = "synthetic-development-account";
        const existingMailbox = (
          await fixture.db.query<{ id: string }>(
            "SELECT id FROM mailboxes WHERE workspace_id=$1 AND owner_user_id=$2",
            [ws, user],
          )
        ).rows[0];
        const mailbox =
          existingMailbox === undefined
            ? (
                await fixture.db.query<{
                  id: string;
                  owner_user_id: string;
                  email_address: string;
                  provider_account_id: string;
                  generation: number;
                  status: string;
                }>(
                  "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'synthetic-dev@example.test',$3,'connected') RETURNING *",
                  [ws, user, account],
                )
              ).rows[0]!
            : (
                await fixture.db.query<{
                  id: string;
                  owner_user_id: string;
                  email_address: string;
                  provider_account_id: string;
                  generation: number;
                  status: string;
                }>(
                  "UPDATE mailboxes SET provider_account_id=$3,status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2 RETURNING *",
                  [ws, existingMailbox.id, account],
                )
              ).rows[0]!;
        const binding = businessAccountBinding(ws, mailbox)!;
        await fixture.db.query(
          "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false) ON CONFLICT DO NOTHING",
          [ws, mailbox.id, user, account, binding],
        );
        const conversationId = (
          await fixture.db.query<{ id: string }>(
            "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Synthetic','[]',now(),'business','fixture','fixture',$6) RETURNING id",
            [ws, mailbox.id, user, binding, label.caseId, hash(label.caseId)],
          )
        ).rows[0]!.id;
        await fixture.db.query(
          "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'fixture',$6,'fixture','fixture','fixture','fixture') ON CONFLICT DO NOTHING",
          [ws, mailbox.id, user, account, binding, hash("synthetic")],
        );
        await enqueueJob(fixture.db, {
          workspaceId: ws,
          kind: "crm.mail_capture",
          idempotencyKey: label.caseId,
          payload: {
            mailboxId: mailbox.id,
            providerMessageId: label.caseId,
            providerAccountId: account,
            generation: 1,
            conversationId,
            controlsRevision: 1,
            policyRevision: 1,
            decisionRevision: 0,
          },
        });
        const job = (
          await claimJobs(fixture.db, {
            owner: "synthetic-fixture",
            kinds: ["crm.mail_capture"],
            limit: 1,
            leaseSeconds: 120,
          })
        )[0]!;
        const capture = await businessMailCaptureHandler({
          proofVerifier: { verify: async () => true },
          provider: {
            read: async () => ({
              providerAccountId: account,
              messageId: label.caseId,
              threadId: label.caseId,
              labels: ["INBOX"],
              providerAt: "2026-10-01T14:00:00Z",
              rawSenderDate: null,
              from: `sender-${label.caseId}@example.test`,
              to: [mailbox.email_address],
              cc: [],
              subject: "Synthetic",
              body: text,
              parserVersion: "fixture-v1",
              representation: "plain_text",
              completeness: "partial",
              ranges: [{ start: 0, end: text.length, kind: "unknown" }],
            }),
          },
        }).handle({
          session: fixture.db,
          scope: workspaceScope(ws, { kind: "system", component: "worker" }),
          job,
        });
        expect(capture).toMatchObject({
          done: true,
          progress: { outcome: "captured" },
        });
        sourceId = String(capture!.progress["sourceId"]);
        contentHash = createHash("sha256").update(text).digest("hex");
        locator = `text:0:${text.length}`;
      }
      const sourceRead = await post("/crm/processing/source/read", {
        workspaceId: fixture.alpha.workspaceId,
        sourceId,
        kind: label.sourceKind,
        revision: 1,
        contentHash,
        locator,
      });
      expect(sourceRead.status).toBe(200);
      const source = crmResolvedSourceSchema.parse(sourceRead.body).source;
      return { sourceId, contentHash, source, text };
    };
    for (const [index, label] of DEVELOPMENT_COMPARISON_LABELS.entries()) {
      const firmId = await seedFirm(fixture, {
        name: label.identityName,
        regionCode: "RI",
        assignedUserId: fixture.alpha.salesperson.userId,
      });
      const copies = [];
      for (const [ordinal, gold] of label.sourceLabels.entries()) {
        const copied = await createCopy(
          {
            ...label,
            caseId: `${label.caseId}_copy_${ordinal}`,
            identityName: `${label.identityName} Copy ${ordinal}`,
            originalText: gold.originalText,
          },
          index * 4 + ordinal,
          firmId,
        );
        copies.push({ ...copied, gold, ordinal });
      }
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
        const expectedRecords = [];
        for (
          let ordinal = 0;
          ordinal < label.expectedOpenOpportunities;
          ordinal++
        ) {
          const name = `Synthetic pilot ${ordinal + 1}`;
          const opened = await post("/opportunities/v2/open", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            firmId,
            name,
            stageKey: "new",
          });
          expect(opened.status).toBe(200);
          const opportunityId = (
            opened.body as { result: { opportunityId: string } }
          ).result.opportunityId;
          const openedAt = `2026-10-0${ordinal + 1}T14:00:00.000Z`;
          await fixture.db.query(
            "UPDATE opportunities SET opened_at=$3 WHERE workspace_id=$1 AND id=$2",
            [fixture.alpha.workspaceId, opportunityId, openedAt],
          );
          expectedRecords.push({
            opportunityId,
            firmId,
            name,
            status: "open",
            stageKey: "new",
            openedAt,
          });
        }
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
          records: expectedRecords,
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
          id: `${label.caseId}_source_${copy.gold.slot}`,
          kind: label.sourceKind,
          setupId: `synthetic_${label.sourceKind === "mail" ? "copied_mail" : label.sourceKind}`,
          originalSha256: copy.contentHash,
          windows: [
            {
              id: `${label.caseId}_window_${copy.gold.slot}`,
              source: copy.source,
              textSha256: hashText(copy.gold.originalText),
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
            elapsed = 600000;
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
