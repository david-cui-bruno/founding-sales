import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  crmProcessingResultSchema,
  crmResolvedSourceSchema,
} from "@fss/contracts";
import { createNativeCrmMailEvidence } from "@fss/domain/crm/nativeMailEvidence.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { enqueueJob, claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { workspaceScope } from "@fss/domain/db/workspaceScope.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { dispatch } from "../src/server.ts";
import { seedFirm } from "./support/crmSeed.ts";
async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  ownerUserId = fixture.alpha.admin.userId,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,'google-business','connected') RETURNING *",
      [workspaceId, ownerUserId, `${ownerUserId}@example.test`],
    )
  ).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query(
    "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,false)",
    [workspaceId, mailbox.id, ownerUserId, binding],
  );
  const conversationId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'approved-thread','Business','[]',now(),'business','fixture','fixture',$5) RETURNING id",
      [workspaceId, mailbox.id, ownerUserId, binding, "a".repeat(64)],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'full-body-fixture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",
    [workspaceId, mailbox.id, ownerUserId, binding, "b".repeat(64)],
  );
  await enqueueJob(fixture.db, {
    workspaceId,
    kind: "crm.mail_capture",
    idempotencyKey: `approved-${ownerUserId}`,
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: "approved-message",
      providerAccountId: "google-business",
      generation: 1,
      conversationId,
      controlsRevision: 1,
      policyRevision: 1,
      decisionRevision: 0,
    },
  });
  const job = (
    await claimJobs(fixture.db, {
      owner: "capture-fixture",
      kinds: ["crm.mail_capture"],
      limit: 1,
      leaseSeconds: 120,
    })
  )[0]!;
  return { workspaceId, ownerUserId, mailbox, binding, conversationId, job };
}

it("reviews conflicts across two actual copied mailboxes after disconnect without a provider grant", async () => {
  const fixture = await createAuthFixture();
  try {
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    let checks = 0;
    const verifier = {
      verify: async () => {
        checks++;
        return true;
      },
    };
    const port = createNativeCrmMailEvidence(verifier);
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
          crmMailEvidence: port,
        },
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const sources = [];
    for (const owner of [
      fixture.alpha.admin.userId,
      fixture.alpha.salesperson.userId,
    ]) {
      const { workspaceId, mailbox, job } = await approveCaptureFixture(
        fixture,
        owner,
      );
      const passage = "Could we discuss maintenance next week?";
      const captured = registerHandlers(new HandlerRegistry(), {
        classifier: undefined,
        mail: undefined,
        send: undefined,
        research: undefined,
        crmMailCapture: {
          proofVerifier: verifier,
          provider: {
            read: async () => ({
              providerAccountId: "google-business",
              messageId: "approved-message",
              threadId: "approved-thread",
              labels: ["INBOX"],
              providerAt:
                owner === fixture.alpha.admin.userId
                  ? "2026-10-01T15:00:00.000Z"
                  : "2026-09-25T15:00:00.000Z",
              rawSenderDate: null,
              from: `Unknown${owner}@business.test`,
              to: [mailbox.email_address],
              cc: [],
              subject: "Business",
              body: passage,
              parserVersion: "fixture-mime-v1",
              representation: "plain_text",
              completeness: "partial",
              ranges: [{ start: 0, end: passage.length, kind: "unknown" }],
            }),
          },
        },
      }).get("crm.mail_capture");
      if (!captured) throw new Error("Capture unavailable");
      const result = await captured.handle({
        session: fixture.db,
        scope: workspaceScope(workspaceId, {
          kind: "system",
          component: "worker",
        }),
        job,
      });
      const sourceId = result?.progress["sourceId"];
      if (typeof sourceId !== "string") throw new Error("Source unavailable");
      sources.push({
        workspaceId,
        sourceId,
        kind: "mail" as const,
        revision: 1,
        contentHash: createHash("sha256").update(passage).digest("hex"),
        locator: null,
      });
    }
    const firmA = await seedFirm(fixture, {
      name: "Original mail A",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const firmB = await seedFirm(fixture, {
      name: "Independent mail B",
      assignedUserId: fixture.alpha.salesperson.userId,
    });
    for (const [index, firmId] of [firmA, firmB].entries()) {
      const source = sources[index]!;
      const associated = await post(
        "/crm/business/mail/associate",
        command({
          sourceId: source.sourceId,
          expectedRevision: source.revision,
          firmId,
        }),
      );
      expect(associated.status).toBe(200);
      source.revision = (
        associated.body as { result: { sourceRevision: number } }
      ).result.sourceRevision;
    }
    expect(
      (
        await post(
          "/crm/processing/purpose/save",
          command({
            expectedRevision: 0,
            enabled: false,
            endpointId: "mail-evaluation",
            modelVersion: "fixture-mail-v1",
            accessGrantVersion: "fixture-mail-grant",
            dataHandlingVersion: "fixture-mail-partial-policy",
            dailyCeilingCents: 100,
            monthlyCeilingCents: 1000,
            inputTokenPriceMicros: 1,
            outputTokenPriceMicros: 1,
          }),
        )
      ).status,
    ).toBe(200);
    await fixture.db.query(
      "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
      [fixture.alpha.workspaceId],
    );
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmExtraction: { allowControlledEvaluation:true,
        mailEvidence: port,
        adapter: {
          endpointId: "mail-evaluation",
          modelVersion: "fixture-mail-v1",
          accessGrantVersion: "fixture-mail-grant",
          dataHandlingVersion: "fixture-mail-partial-policy",
          providerKey: "fixture.crm_extraction",
          fundingVerifiedUntil: "2099-01-01T00:00:00Z",
          run: async () => ({
            acceptance: "accepted",
            usage: { inputTokens: 20, outputTokens: 30 },
            claims: [
              {
                kind: "need",
                interpretation: "Maintenance discussion",
                status: "stated",
                locator: "text:0:8",
                quote: "Could we",
              },
            ],
          }),
        },
      },
    });
    const members = [];
    for (const source of sources) {
      expect(
        (await post("/crm/processing/request", command({ source }))).status,
      ).toBe(200);
      await runOnce(fixture.db, {
        registry,
        owner: "mail-conflict-evaluation",
        limit: 20,
      });
      const generation = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (!("generationId" in generation) || !generation.claims[0])
        throw new Error("Claim unavailable");
      const claim = generation.claims[0];
      members.push({
        source,
        claimId: claim.claimId,
        claimRevision: 1,
        claimHash: claim.claimHash,
        contextHash: generation.contextHash,
        expectedDecisionRevision: 0,
      });
    }
    await fixture.db.query(
      "UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1",
      [fixture.alpha.workspaceId],
    );
    const baselineChecks = checks;
    const copiedRead = await dispatch(
      {
        method: "POST",
        path: "/crm/processing/source/read",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
        body: { ...sources[0], locator: "text:0:8" },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
        crmMailEvidence: createNativeCrmMailEvidence(),
      },
    );
    expect(copiedRead.status).toBe(200);
    expect(crmResolvedSourceSchema.safeParse(copiedRead.body).success).toBe(
      true,
    );
    expect(copiedRead.body).toMatchObject({
      state: "available",
      source: { kind: "mail", completeness: "partial" },
      passage: { text: "Could we", locator: "text:0:8" },
    });
    expect(checks).toBe(baselineChecks);

    const saved = await post(
      "/crm/evidence/conflict/save",
      command({ expectedConflictRevision: 0, members }),
    );
    expect(saved.status).toBe(200);
    const conflictId = (saved.body as { result: { conflictId: string } }).result
      .conflictId;
    expect(
      (await post("/crm/evidence/conflict/read", { conflictId })).body,
    ).toMatchObject({
      members: expect.arrayContaining(
        sources.map((source) =>
          expect.objectContaining({
            source: expect.objectContaining({
              sourceId: source.sourceId,
              completeness: "partial",
            }),
            quote: "Could we",
          }),
        ),
      ),
    });
    expect(checks).toBe(baselineChecks);
    const target = members[0]!;
    const decided = await post(
      "/crm/evidence/decide",
      command({
        ...target,
        action: "correct",
        correctedInterpretation: "Only annual maintenance was discussed",
        rationale: "Mail-specific human correction",
      }),
    );
    expect(decided.status).toBe(200);
    const anchorId = (decided.body as { result: { anchorId: string } }).result
      .anchorId;
    const historyInput = {
      kind: "mail",
      sourceId: target.source.sourceId,
      anchorId,
    };
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).body,
    ).toMatchObject({
      availability: "available",
      decisions: [
        {
          correctedInterpretation: "Only annual maintenance was discussed",
          redacted: false,
        },
      ],
    });
    expect(
      (
        await post(
          "/crm/business/mail/delete",
          command({
            sourceId: target.source.sourceId,
            expectedRevision: target.source.revision,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await post("/crm/evidence/conflict/read", { conflictId })).status,
    ).toBe(404);
    const deletedHistory = await post(
      "/crm/evidence/decision/history/read",
      historyInput,
    );
    expect(deletedHistory.status).toBe(200);
    expect(deletedHistory.body).toMatchObject({
      availability: "deleted",
      basis: "deleted_redacted",
      decisions: [
        {
          action: "correct",
          correctedInterpretation: null,
          rationale: null,
          redacted: true,
        },
      ],
    });
    expect(JSON.stringify(deletedHistory.body)).not.toContain("Mail-specific");
    const preview = await post(
      "/retention/deletions/preview",
      command({ targetKind: "firm", firmId: firmA }),
    );
    expect(preview.status).toBe(200);
    const receipt = (
      preview.body as { result: { requestId: string; previewHash: string } }
    ).result;
    const deleted = await post(
      "/retention/deletions/commit",
      command({
        requestId: receipt.requestId,
        previewHash: receipt.previewHash,
      }),
    );
    expect(deleted.status).toBe(200);
    const survivingCopy = await post("/crm/business/mail/read", {
      sourceId: sources[1]!.sourceId,
      sourceRevision: sources[1]!.revision,
      contentHash: sources[1]!.contentHash,
    });
    expect(survivingCopy.status).toBe(200);
    expect(JSON.stringify(survivingCopy.body)).toContain(
      "Could we discuss maintenance next week?",
    );
    expect(
      (await post("/crm/evidence/decision/history/read", historyInput)).status,
    ).toBe(404);
    expect(checks).toBe(baselineChecks);
  } finally {
    await fixture.stop();
  }
});
