import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { crmProcessingResultSchema } from "@fss/contracts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";

it("reviews native meeting evidence and retains redacted human history after its original transcript is erased", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
          body,
        },
        {
          session: fixture.db,
          auth: fixture.deps,
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const firmId = await seedFirm(fixture, {
      name: "Native human evidence",
      regionCode: "TX",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const meetingId = randomUUID(),
      recordingId = randomUUID(),
      sourceId = randomUUID();
    await fixture.db.query(
      "INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'human-native','human-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",
      [fixture.alpha.workspaceId, meetingId, firmId],
    );
    await fixture.db.query(
      "INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",
      [
        fixture.alpha.workspaceId,
        recordingId,
        meetingId,
        "a".repeat(64),
        `meetings/${meetingId}/${"a".repeat(64)}.m4a`,
      ],
    );
    const utterances = [
      {
        startMs: 0,
        endMs: 5000,
        text: "We need help coordinating repairs.",
        speaker: "Correspondent",
        attribution: "source_label",
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
    const source = {
      workspaceId: fixture.alpha.workspaceId,
      sourceId,
      kind: "meeting_transcript" as const,
      revision: 1,
      contentHash: createHash("sha256")
        .update(JSON.stringify(utterances))
        .digest("hex"),
      locator: null,
    };
    async function process(modelVersion: string, expectedRevision: number) {
      expect(
        (
          await post(
            "/crm/processing/purpose/save",
            command({
              expectedRevision,
              enabled: false,
              endpointId: "review-evaluation",
              modelVersion,
              accessGrantVersion: "fixture-review-grant",
              dataHandlingVersion: "fixture-review-policy",
              dailyCeilingCents: 100,
              monthlyCeilingCents: 1000,
              inputTokenPriceMicros: 1,
              outputTokenPriceMicros: 1,
            }),
          )
        ).status,
      ).toBe(200);
      // Isolated evaluation fixture only; public controls cannot enable processing.
      await fixture.db.query(
        "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
        [source.workspaceId],
      );
      await post("/crm/processing/request", command({ source }));
      const registry = registerHandlers(new HandlerRegistry(), {
        classifier: undefined,
        mail: undefined,
        send: undefined,
        research: undefined,
        crmExtraction: { allowControlledEvaluation:true,
          adapter: {
            endpointId: "review-evaluation",
            modelVersion,
            accessGrantVersion: "fixture-review-grant",
            dataHandlingVersion: "fixture-review-policy",
            providerKey: "fixture.crm_review",
            fundingVerifiedUntil: "2099-01-01T00:00:00Z",
            run: async () => ({
              acceptance: "accepted",
              usage: { inputTokens: 1, outputTokens: 1 },
              claims: [
                {
                  kind: "need",
                  status: "stated",
                  interpretation: "Needs repair coordination",
                  locator: "utterance:0:text:0:12",
                  quote: "We need help",
                },
              ],
            }),
          },
        },
      });
      await runOnce(fixture.db, {
        registry,
        owner: `review-${modelVersion}`,
        limit: 20,
      });
      const result = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (!("generationId" in result) || result.claims[0] === undefined)
        throw new Error("Controlled extraction unavailable");
      return { generation: result, claim: result.claims[0] };
    }

    const first = await process("fixture-v1", 0);
    const corrected = await post(
      "/crm/evidence/decide",
      command({
        source,
        claimId: first.claim.claimId,
        claimRevision: 1,
        claimHash: first.claim.claimHash,
        contextHash: first.generation.contextHash,
        expectedDecisionRevision: 0,
        action: "correct",
        correctedInterpretation: "Repairs were discussed in October",
      }),
    );
    expect(corrected.status).toBe(200);
    const anchorId = (corrected.body as { result: { anchorId: string } }).result
      .anchorId;
    const historyInput = {
      kind: source.kind,
      sourceId: source.sourceId,
      anchorId,
    };
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      basis: "available",
      originalEventAt: "2026-10-01T14:00:00.000Z",
      decisions: [
        {
          correctedInterpretation: "Repairs were discussed in October",
          redacted: false,
        },
      ],
    });
    const taskId = randomUUID();
    await fixture.db.query(
      `INSERT INTO meeting_tasks(workspace_id,id,meeting_id,firm_id,commitment_id,label,owner_user_id,deadline,due_at,evidence) VALUES($1,$2,$3,$4,'native-support','Arrange repair discussion',$5,'{"precision":"date","localDate":"2026-10-10","zone":"America/New_York"}',now(),'[{"kind":"debrief","revision":1,"quote":"We need help","startOffset":0,"endOffset":12}]')`,
      [
        source.workspaceId,
        taskId,
        meetingId,
        firmId,
        fixture.alpha.admin.userId,
      ],
    );
    const work = { kind: "meeting_task", id: taskId };
    expect(
      (
        await post(
          "/crm/evidence/work/bind",
          command({
            source,
            claimId: first.claim.claimId,
            claimRevision: 1,
            claimHash: first.claim.claimHash,
            contextHash: first.generation.contextHash,
            expectedDecisionRevision: 1,
            work: { ...work, expectedVersion: "1" },
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/work/read", { work })).body,
    ).toMatchObject({
      dependencies: [{ reviewRequired: false, reason: null }],
    });
    const preview = await post(
      "/retention/deletions/preview",
      command({ targetKind: "firm", firmId }),
    );
    expect(preview.status).toBe(200);
    const shown = (
      preview.body as {
        result: {
          requestId: string;
          previewHash: string;
          redacts: Record<string, number>;
        };
      }
    ).result;
    expect(shown.redacts["crm_claim_review_anchors"]).toBe(1);
    expect(shown.redacts["crm_claim_decision_revisions"]).toBe(1);
    const deleted = await post(
      "/retention/deletions/commit",
      command({ requestId: shown.requestId, previewHash: shown.previewHash }),
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body).toMatchObject({
      result: {
        redacted: {
          crm_claim_review_anchors: 1,
          crm_claim_decision_revisions: 1,
        },
      },
    });
    expect((await post("/crm/evidence/work/read", { work })).status).toBe(404);
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      basis: "deleted_redacted",
      originalEventAt: null,
      originalObservedAt: null,
      decisions: [
        { correctedInterpretation: null, rationale: null, redacted: true },
      ],
    });
  } finally {
    await fixture.stop();
  }
});
