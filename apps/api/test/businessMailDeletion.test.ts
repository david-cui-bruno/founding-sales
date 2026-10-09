import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { enqueueJob, claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { workspaceScope } from "@fss/domain/db/workspaceScope.ts";
import { recordingSuppressionJournal } from "@fss/domain/suppression/journal.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm } from "./support/crmSeed.ts";
import { dispatch } from "../src/server.ts";

async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const ownerUserId = fixture.alpha.admin.userId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",
      [workspaceId, ownerUserId],
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
    idempotencyKey: "approved-fixture",
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

async function copyWithOriginalAndReviewedFirms(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  observedUnknown = false,
) {
  const { workspaceId, ownerUserId, mailbox, binding, job } =
    await approveCaptureFixture(fixture);
  const token = (
    await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
  ).accessToken;
  const command = (fields: object) => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    ...fields,
  });
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
        suppressionJournal: recordingSuppressionJournal(),
      },
    );
  const originalFirmId = await seedFirm(fixture, {
    name: "Original firm A",
    assignedUserId: ownerUserId,
  });
  const reviewedFirmId = await seedFirm(fixture, {
    name: "Reviewed firm B",
    assignedUserId: ownerUserId,
  });
  const opportunityId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id",
      [workspaceId, originalFirmId],
    )
  ).rows[0]!.id;
  let sourceId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,'approved-message','approved-thread','incoming','2026-10-08T15:00:00Z',$3) RETURNING id",
      [workspaceId, mailbox.id, !observedUnknown],
    )
  ).rows[0]!.id;
  if (!observedUnknown) await fixture.db.query(
    "INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread')",
    [workspaceId, sourceId, originalFirmId, opportunityId],
  );
  const passage =
    "One private copied conversation involving both supported firms.";
  const contentHash = createHash("sha256").update(passage).digest("hex");
  let bodyReads = 0;
  const registry = registerHandlers(new HandlerRegistry(), {
    classifier: undefined,
    mail: undefined,
    send: undefined,
    research: undefined,
    crmMailCapture: {
      proofVerifier: {
        async verify(proof) {
          return (
            proof.grantReceipt === "fixture-grant" &&
            proof.accountBinding === binding
          );
        },
      },
      provider: {
        async read() {
          bodyReads++;
          return {
            ...(observedUnknown ? {fromDisplayName: "Observed business person"} : {}),
            providerAccountId: "google-business",
            messageId: "approved-message",
            threadId: "approved-thread",
            labels: ["INBOX"],
            providerAt: "2026-10-08T15:00:00.000Z",
            rawSenderDate: null,
            from: observedUnknown ? "observed@business.test" : "shared@business.test",
            to: ["business@example.test"],
            cc: [],
            subject: "Shared business context",
            body: passage,
            parserVersion: "fixture-mime-v1",
            representation: "plain_text",
            completeness: "complete",
            ranges: [{ start: 0, end: passage.length, kind: "authored" }],
          };
        },
      },
    },
  });
  const handler = registry.get("crm.mail_capture");
  if (handler === undefined)
    throw new Error("Registered capture handler unavailable");
  const workerInput = {
    session: fixture.db,
    scope: workspaceScope(workspaceId, { kind: "system", component: "worker" }),
    job,
  };
  const captured = await handler.handle(workerInput);
  expect(captured).toMatchObject({done:true,progress:{outcome:'captured',sourceRevision:1}});
  const capturedId = captured?.progress['sourceId'];
  if(typeof capturedId !== 'string')throw new Error('Missing captured canonical ID');
  sourceId = capturedId;
  expect(
    (
      await post(
        "/crm/business/mail/associate",
        command({
          sourceId,
          expectedRevision: 1,
          firmId: reviewedFirmId,
        }),
      )
    ).body,
  ).toMatchObject({
    status: "accepted",
    result: { sourceId, sourceRevision: 2 },
  });
  expect(
    (
      await post("/crm/business/mail/read", {
        sourceId,
        sourceRevision: 2,
        contentHash,
      })
    ).body,
  ).toMatchObject({
    state: "available",
    source: {
      passage,
      originalContexts: observedUnknown ? [{identityStatus: "observed_label"}] : [{ firmId: originalFirmId }],
      reviewedContexts: [{ firmId: reviewedFirmId, sourceRevision: 2 }],
    },
  });
  return {
    sourceId,
    contentHash,
    passage,
    originalFirmId,
    reviewedFirmId,
    post,
    command,
    handler,
    workerInput,
    bodyReads: () => bodyReads,
  };
}

it("firm deletion removes an associated mail copy and fresh capture authority cannot restore its deleted identity", async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, mailbox, binding, conversationId, job } =
      await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
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
          suppressionJournal: recordingSuppressionJournal(),
        },
      );
    const passage =
      "A private business discussion with initially unknown firm context.";
    let bodyReads = 0;
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmMailCapture: {
        proofVerifier: {
          async verify(proof) {
            return (
              proof.grantReceipt === "fixture-grant" &&
              proof.accountBinding === binding
            );
          },
        },
        provider: {
          async read() {
            bodyReads++;
            return {
              providerAccountId: "google-business",
              messageId: "approved-message",
              threadId: "approved-thread",
              labels: ["INBOX"],
              providerAt: "2026-10-08T15:00:00.000Z",
              rawSenderDate: null,
              from: "unknown@business.test",
              to: ["business@example.test"],
              cc: [],
              subject: "Business",
              body: passage,
              parserVersion: "fixture-mime-v1",
              representation: "plain_text",
              completeness: "complete",
              ranges: [{ start: 0, end: passage.length, kind: "authored" }],
            };
          },
        },
      },
    });
    const handler = registry.get("crm.mail_capture");
    if (handler === undefined)
      throw new Error("Registered capture handler unavailable");
    const workerInput = {
      session: fixture.db,
      scope: workspaceScope(workspaceId, {
        kind: "system",
        component: "worker",
      }),
      job,
    };
    const captured = await handler.handle(workerInput);
    expect(captured).toMatchObject({
      done: true,
      progress: { outcome: "captured", sourceRevision: 1 },
    });
    const sourceId = captured?.progress["sourceId"];
    if (typeof sourceId !== "string")
      throw new Error("Captured source identity unavailable");
    const contentHash = createHash("sha256").update(passage).digest("hex");
    expect(
      (
        await post("/crm/business/mail/read", {
          sourceId,
          sourceRevision: 1,
          contentHash,
        })
      ).body,
    ).toMatchObject({
      state: "available",
      source: {
        passage,
        mailboxId: mailbox.id,
        originalContexts: [],
        reviewedContexts: [],
      },
    });
    const firmId = await seedFirm(fixture, {
      name: "Explicitly associated firm",
      assignedUserId: fixture.alpha.admin.userId,
    });
    expect(
      (
        await post(
          "/crm/business/mail/associate",
          command({ sourceId, expectedRevision: 1, firmId }),
        )
      ).body,
    ).toMatchObject({
      status: "accepted",
      result: { sourceId, sourceRevision: 2 },
    });
    expect(
      (
        await post("/crm/business/mail/read", {
          sourceId,
          sourceRevision: 2,
          contentHash,
        })
      ).body,
    ).toMatchObject({
      state: "available",
      source: {
        originalContexts: [],
        reviewedContexts: [{ firmId, sourceRevision: 2 }],
      },
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
          removes: Record<string, number>;
          stops: Record<string, number>;
        };
      }
    ).result;
    expect(shown.removes["crm_mail_sources"]).toBe(1);
    expect(shown.removes["mail_message_bodies"]).toBe(1);
    expect(shown.stops["crm_mail_capture_identities"]).toBe(1);
    expect(
      (
        await post(
          "/retention/deletions/commit",
          command({
            requestId: shown.requestId,
            previewHash: shown.previewHash,
          }),
        )
      ).status,
    ).toBe(200);
    const erased = await post("/crm/business/mail/read", {
      sourceId,
      sourceRevision: 2,
      contentHash,
    });
    expect(erased.body).toMatchObject({ state: "unavailable", source: null });
    expect(JSON.stringify(erased.body)).not.toContain(passage);
    expect(await handler.handle(workerInput)).toMatchObject({
      done: true,
      progress: { outcome: "authority_unavailable" },
    });
    expect(bodyReads).toBe(1);

    // Controlled fresh metadata and proof do not restore the deleted body identity.
    await fixture.db.query(
      "UPDATE crm_business_conversations SET metadata_availability='available',subject='Fresh permitted metadata',participants='[]',latest_provider_at=now(),category='business',reason='fresh_fixture',classifier_version='fixture-v2',metadata_hash=$3,metadata_revision=metadata_revision+1 WHERE workspace_id=$1 AND id=$2",
      [workspaceId, conversationId, "c".repeat(64)],
    );
    await fixture.db.query(
      "UPDATE crm_mail_capture_controls SET revision=2 WHERE workspace_id=$1 AND mailbox_id=$2",
      [workspaceId, mailbox.id],
    );
    await enqueueJob(fixture.db, {
      workspaceId,
      kind: "crm.mail_capture",
      idempotencyKey: "fresh-authority-after-deletion",
      payload: {
        mailboxId: mailbox.id,
        providerMessageId: "approved-message",
        providerAccountId: "google-business",
        generation: 1,
        conversationId,
        controlsRevision: 2,
        policyRevision: 1,
        decisionRevision: 0,
      },
    });
    const freshJob = (
      await claimJobs(fixture.db, {
        owner: "fresh-capture-after-deletion",
        kinds: ["crm.mail_capture"],
        limit: 1,
        leaseSeconds: 120,
      })
    )[0]!;
    expect(
      await handler.handle({ ...workerInput, job: freshJob }),
    ).toMatchObject({
      done: true,
      progress: { outcome: "source_deleted" },
    });
    expect(bodyReads).toBe(1);
    expect(
      (
        await post("/crm/business/mail/read", {
          sourceId,
          sourceRevision: 2,
          contentHash,
        })
      ).body,
    ).toMatchObject({
      state: "unavailable",
      source: null,
    });
  } finally {
    await fixture.stop();
  }
});

it("public firm deletion blocks a matched capture that is already waiting for provider content", async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, ownerUserId, mailbox, binding, job } =
      await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
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
          suppressionJournal: recordingSuppressionJournal(),
        },
      );
    const firmId = await seedFirm(fixture, {
      name: "In-flight original firm",
      assignedUserId: ownerUserId,
    });
    const opportunityId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id",
        [workspaceId, firmId],
      )
    ).rows[0]!.id;
    const sourceId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,'approved-message','approved-thread','incoming','2026-10-08T15:00:00Z',true) RETURNING id",
        [workspaceId, mailbox.id],
      )
    ).rows[0]!.id;
    await fixture.db.query(
      "INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread')",
      [workspaceId, sourceId, firmId, opportunityId],
    );
    const passage = "Private content arriving after deletion.";
    let bodyReads = 0;
    let release!: () => void;
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmMailCapture: {
        proofVerifier: {
          async verify(proof) {
            return (
              proof.grantReceipt === "fixture-grant" &&
              proof.accountBinding === binding
            );
          },
        },
        provider: {
          async read() {
            bodyReads++;
            started();
            await waiting;
            return {
              providerAccountId: "google-business",
              messageId: "approved-message",
              threadId: "approved-thread",
              labels: ["INBOX"],
              providerAt: "2026-10-08T15:00:00.000Z",
              rawSenderDate: null,
              from: "matched@business.test",
              to: ["business@example.test"],
              cc: [],
              subject: "Private original context",
              body: passage,
              parserVersion: "fixture-mime-v1",
              representation: "plain_text",
              completeness: "complete",
              ranges: [{ start: 0, end: passage.length, kind: "authored" }],
            };
          },
        },
      },
    });
    const handler = registry.get("crm.mail_capture");
    if (handler === undefined)
      throw new Error("Registered capture handler unavailable");
    const worker = await fixture.database.appRuntimeSession();
    const running = handler.handle({
      session: worker,
      scope: workspaceScope(workspaceId, {
        kind: "system",
        component: "worker",
      }),
      job,
    });
    await entered;
    try {
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
            stops: Record<string, number>;
          };
        }
      ).result;
      expect(shown.stops["crm_mail_capture_identities"]).toBe(1);
      const committed = await post(
        "/retention/deletions/commit",
        command({ requestId: shown.requestId, previewHash: shown.previewHash }),
      );
      expect(committed.status).toBe(200);
      expect(committed.body).toMatchObject({
        result: { stopped: { crm_mail_capture_identities: 1 } },
      });
    } finally {
      release();
    }
    expect(await running).toMatchObject({
      done: true,
      progress: { outcome: "source_context_changed" },
    });
    const read = await post("/crm/business/mail/read", {
      sourceId,
      sourceRevision: 1,
      contentHash: createHash("sha256").update(passage).digest("hex"),
    });
    expect(read.body).toMatchObject({ state: "unavailable", source: null });
    expect(JSON.stringify(read.body)).not.toContain(passage);
    expect(bodyReads).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it("deleting the original firm erases the whole copy even when another reviewed firm remains supported", async () => {
  const fixture = await createAuthFixture();
  try {
    const copied = await copyWithOriginalAndReviewedFirms(fixture);
    const preview = await copied.post(
      "/retention/deletions/preview",
      copied.command({
        targetKind: "firm",
        firmId: copied.originalFirmId,
      }),
    );
    expect(preview.status).toBe(200);
    const shown = (
      preview.body as {
        result: {
          requestId: string;
          previewHash: string;
          removes: Record<string, number>;
        };
      }
    ).result;
    expect(shown.removes["crm_mail_sources"]).toBe(1);
    expect(shown.removes["mail_message_bodies"]).toBe(1);
    expect(
      (
        await copied.post(
          "/retention/deletions/commit",
          copied.command({
            requestId: shown.requestId,
            previewHash: shown.previewHash,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await copied.post("/crm/business/mail/read", {
          sourceId: copied.sourceId,
          sourceRevision: 2,
          contentHash: copied.contentHash,
        })
      ).body,
    ).toMatchObject({ state: "unavailable", source: null });
    expect(
      (await copied.post("/crm/firm-page", { firmId: copied.reviewedFirmId }))
        .body,
    ).toMatchObject({
      read: { firm: { name: "Reviewed firm B", status: "active" } },
    });
    expect(await copied.handler.handle(copied.workerInput)).toMatchObject({
      done: true,
      progress: { outcome: "authority_unavailable" },
    });
    expect(copied.bodyReads()).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it("deleting the reviewed firm erases the whole copy while its original firm survives", async () => {
  const fixture = await createAuthFixture();
  try {
    const copied = await copyWithOriginalAndReviewedFirms(fixture);
    const preview = await copied.post(
      "/retention/deletions/preview",
      copied.command({
        targetKind: "firm",
        firmId: copied.reviewedFirmId,
      }),
    );
    expect(preview.status).toBe(200);
    const shown = (
      preview.body as {
        result: {
          requestId: string;
          previewHash: string;
          removes: Record<string, number>;
          stops: Record<string, number>;
        };
      }
    ).result;
    expect(shown.removes["crm_mail_sources"]).toBe(1);
    expect(shown.removes["mail_message_bodies"]).toBe(1);
    expect(shown.stops["crm_mail_capture_identities"]).toBe(1);
    expect(
      (
        await copied.post(
          "/retention/deletions/commit",
          copied.command({
            requestId: shown.requestId,
            previewHash: shown.previewHash,
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await copied.post("/crm/business/mail/read", {
          sourceId: copied.sourceId,
          sourceRevision: 2,
          contentHash: copied.contentHash,
        })
      ).body,
    ).toMatchObject({ state: "unavailable", source: null });
    expect(
      (await copied.post("/crm/firm-page", { firmId: copied.originalFirmId }))
        .body,
    ).toMatchObject({
      read: { firm: { name: "Original firm A", status: "active" } },
    });
    expect(await copied.handler.handle(copied.workerInput)).toMatchObject({
      done: true,
      progress: { outcome: "authority_unavailable" },
    });
    expect(copied.bodyReads()).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it("a versioned context correction invalidates deletion approval even when copied body and identity counts stay unchanged", async () => {
  const fixture = await createAuthFixture();
  try {
    const copied = await copyWithOriginalAndReviewedFirms(fixture);
    const replacementFirmId = await seedFirm(fixture, {
      name: "Corrected reviewed firm C",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const previewInput = { targetKind: "firm", firmId: copied.originalFirmId };
    const preview = await copied.post(
      "/retention/deletions/preview",
      copied.command(previewInput),
    );
    expect(preview.status).toBe(200);
    type Preview = {
      result: {
        requestId: string;
        previewHash: string;
        removes: Record<string, number>;
        stops: Record<string, number>;
      };
    };
    const shown = (preview.body as Preview).result;
    expect(
      (
        await copied.post(
          "/crm/business/mail/associate",
          copied.command({
            sourceId: copied.sourceId,
            expectedRevision: 2,
            firmId: replacementFirmId,
          }),
        )
      ).body,
    ).toMatchObject({ status: "accepted", result: { sourceRevision: 3 } });
    const refreshed = await copied.post(
      "/retention/deletions/preview",
      copied.command(previewInput),
    );
    expect(refreshed.status).toBe(200);
    const current = (refreshed.body as Preview).result;
    expect(current.removes["crm_mail_sources"]).toBe(
      shown.removes["crm_mail_sources"],
    );
    expect(current.removes["mail_message_bodies"]).toBe(
      shown.removes["mail_message_bodies"],
    );
    expect(current.stops["crm_mail_capture_identities"]).toBe(
      shown.stops["crm_mail_capture_identities"],
    );
    // The versioned public command retains the prior context as history.
    expect(current.removes["crm_mail_source_contexts"]).toBe(
      shown.removes["crm_mail_source_contexts"]! + 1,
    );
    const staleCommit = await copied.post(
      "/retention/deletions/commit",
      copied.command({
        requestId: shown.requestId,
        previewHash: shown.previewHash,
      }),
    );
    expect(staleCommit.status).toBe(409);
    expect(staleCommit.body).toMatchObject({
      status: "refused",
      reason: "preview_stale",
    });
    expect(
      (
        await copied.post("/crm/business/mail/read", {
          sourceId: copied.sourceId,
          sourceRevision: 3,
          contentHash: copied.contentHash,
        })
      ).body,
    ).toMatchObject({
      state: "available",
      source: {
        passage: copied.passage,
        originalContexts: [{ firmId: copied.originalFirmId }],
        reviewedContexts: [{ firmId: replacementFirmId, sourceRevision: 3 }],
      },
    });
    expect(copied.bodyReads()).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it('erases saved Ask questions after direct mail-copy deletion without restoring their private history', async () => {
  const fixture = await createAuthFixture();
  try {
    const copied = await copyWithOriginalAndReviewedFirms(fixture);
    const question = 'private copied conversation';
    const requested = await copied.post('/ask/answers/request', copied.command({ question, scope: { sources: [{ workspaceId: fixture.alpha.workspaceId, sourceId: copied.sourceId, kind: 'mail', revision: 2, contentHash: copied.contentHash, locator: null }] } }));
    expect(requested.status).toBe(200);
    const requestId = (requested.body as { result: { requestId: string } }).result.requestId;
    const current = await copied.post('/ask/answers/read', { requestId });
    expect(current.status).toBe(200);
    expect(current.body).toMatchObject({ question, fallback: { passages: [{ text: copied.passage }] } });
    const deleted = await copied.post('/crm/business/mail/delete', copied.command({ sourceId: copied.sourceId, expectedRevision: 2 }));
    expect(deleted.status).toBe(200);
    const erased = await copied.post('/ask/answers/read', { requestId });
    expect(erased.status).toBe(200);
    expect(erased.body).toMatchObject({ state: 'deleted', reason: 'deleted', question: null, fallback: null, answer: null });
    expect((await copied.post('/crm/business/mail/restore', copied.command({ sourceId: copied.sourceId, expectedRevision: 3 }))).status).toBe(200);
    expect((await copied.post('/ask/answers/read', { requestId })).body).toMatchObject({ state: 'deleted', reason: 'deleted', question: null, fallback: null, answer: null });
    expect(copied.bodyReads()).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it('keeps the last reviewed firm in deletion scope after copy deletion and restoration', async () => {
  const fixture = await createAuthFixture();
  try {
    const copied = await copyWithOriginalAndReviewedFirms(fixture);
    expect((await copied.post('/crm/business/mail/delete', copied.command({ sourceId: copied.sourceId, expectedRevision: 2 }))).body)
      .toMatchObject({ status: 'accepted', result: { sourceRevision: 3, availability: 'deleted' } });
    expect((await copied.post('/crm/business/mail/restore', copied.command({ sourceId: copied.sourceId, expectedRevision: 3 }))).body)
      .toMatchObject({ status: 'accepted', result: { sourceRevision: 4, availability: 'awaiting_recapture' } });
    const preview = await copied.post('/retention/deletions/preview', copied.command({ targetKind: 'firm', firmId: copied.reviewedFirmId }));
    expect(preview.status).toBe(200);
    const shown = preview.body as {result: { requestId: string; previewHash: string; removes: Record<string, number> }};
    expect(shown.result.removes['crm_mail_sources']).toBe(1);
    const committed = await copied.post('/retention/deletions/commit', copied.command({requestId: shown.result.requestId, previewHash: shown.result.previewHash}));
    expect(committed.status).toBe(200);
    expect(committed.body).toMatchObject({status: 'accepted', result: {removed: {crm_mail_sources: 1}}});
    expect((await copied.post('/crm/business/mail/state/read', {sourceId: copied.sourceId})).body)
      .toMatchObject({availability: 'deleted'});
    expect(copied.bodyReads()).toBe(1);
  } finally {
    await fixture.stop();
  }
});


it('scoped firm deletion redacts an otherwise unsupported observed person label and reports its actual count', async () => {
 const fixture=await createAuthFixture();
 try {
  const copied=await copyWithOriginalAndReviewedFirms(fixture,true);
  const read=await copied.post('/crm/business/mail/read',{sourceId:copied.sourceId,sourceRevision:2,contentHash:copied.contentHash});
  const page=read.body as {source:{originalContexts:{personId:string}[]}};
  const personId=page.source.originalContexts[0]!.personId;
  expect((await copied.post('/crm/people/read',{personId})).body).toMatchObject({person:{fullName:'Observed business person'}});
  const preview=await copied.post('/retention/deletions/preview',copied.command({targetKind:'firm',firmId:copied.reviewedFirmId}));
  expect(preview.status).toBe(200);
  const shown=preview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>}};
  expect(shown.result.redacts['crm_people']).toBe(1);
  const committed=await copied.post('/retention/deletions/commit',copied.command({requestId:shown.result.requestId,previewHash:shown.result.previewHash}));
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({status:'accepted',result:{redacted:{crm_people:1}}});
  expect((await copied.post('/crm/people/read',{personId})).body).toMatchObject({person:{personId,fullName:'[unknown]'}});
 }finally{await fixture.stop();}
});

it('retention waits for capture promotion and preserves the newly approved copy', async () => {
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,mailbox,binding,job}=await approveCaptureFixture(fixture);
  const sourceId=(await fixture.db.query<{id:string}>("INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,recorded_at) VALUES($1,$2,'approved-message','approved-thread','incoming',now()-interval '120 days',now()-interval '120 days') RETURNING id",[workspaceId,mailbox.id])).rows[0]!.id;
  const captureSession=await fixture.database.appRuntimeSession();
  const retentionSession=await fixture.database.appRuntimeSession();
  const capturePid=(await captureSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const retentionPid=(await retentionSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  await fixture.db.query('SELECT pg_advisory_lock(4830801)');
  await fixture.db.query("CREATE FUNCTION test_pause_mail_copy() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(4830801); RETURN NEW; END $$");
  await fixture.db.query('CREATE TRIGGER test_pause_mail_copy AFTER INSERT ON crm_mail_sources FOR EACH ROW EXECUTE FUNCTION test_pause_mail_copy()');
  await enqueueJob(fixture.db,{workspaceId,kind:'retention.batch',idempotencyKey:'capture-promotion-race',payload:{dataKind:'unmatched_gmail_metadata',period:new Date().toISOString().slice(0,10)}});
  const retentionJob=(await claimJobs(fixture.db,{owner:'retention-race',kinds:['retention.batch'],limit:1,leaseSeconds:120}))[0]!;
  const passage='Approved business copy committed while retention waits.';
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{async verify(p){return p.accountBinding===binding;}},provider:{async read(){return {providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'observed@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:passage.length,kind:'authored'}]};}}}});
  const scope=workspaceScope(workspaceId,{kind:'system',component:'worker'});
  const capture=registry.get('crm.mail_capture')!;
  const captureRun=capture.handle({session:captureSession,scope,job}).then(value=>({ok:true,value}),error=>({ok:false,error}));
  async function awaitBlocked(pid:number,blockingPid?:number){
   for(let n=0;n<100;n++){
    const row=(await fixture.db.query<{event:string|null;blocking:number[]}>('SELECT wait_event AS event,pg_blocking_pids(pid) AS blocking FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
    if(blockingPid===undefined?row?.event==='advisory':row?.blocking.includes(blockingPid))return;
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw new Error('Controlled PostgreSQL barrier was not reached');
  }
  await awaitBlocked(capturePid);
  const retention=registry.get('retention.batch')!;
  const retentionRun=retention.handle({session:retentionSession,scope,job:retentionJob}).then(value=>({ok:true,value}),error=>({ok:false,error}));
  await awaitBlocked(retentionPid,capturePid);
  await fixture.db.query('SELECT pg_advisory_unlock(4830801)');
  expect(await captureRun).toMatchObject({ok:true,value:{progress:{outcome:'captured',sourceId}}});
  expect(await retentionRun).toMatchObject({ok:true});
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const read=await dispatch({method:'POST',path:'/crm/business/mail/read',body:{sourceId,sourceRevision:1,contentHash:createHash('sha256').update(passage).digest('hex')},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect(read.body).toMatchObject({state:'available',source:{passage}});
 }finally{
  await fixture.db.query('SELECT pg_advisory_unlock_all()');
  await fixture.stop();
 }
});

it('reports the actual saved Ask question erasure before a public mail copy deletion hook runs', async () => {
  const fixture = await createAuthFixture();
  try {
    const {post, command, sourceId, contentHash, originalFirmId} = await copyWithOriginalAndReviewedFirms(fixture);
    const requested = await post('/ask/answers/request', command({question:'private copied conversation',scope:{sources:[{workspaceId:fixture.alpha.workspaceId,kind:'mail',sourceId,revision:2,contentHash,locator:null}]}}));
    expect(requested.status, JSON.stringify(requested.body)).toBe(200);
    expect(requested.body).toMatchObject({result:{state:'unavailable'}});
    const requestId = (requested.body as {result:{requestId:string}}).result.requestId;
    expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({question:'private copied conversation',answer:null});
    const preview = await post('/retention/deletions/preview', command({targetKind:'firm',firmId:originalFirmId}));
    expect(preview.status).toBe(200);
    expect(preview.body).toMatchObject({result:{redacts:{crm_ask_requests:1},removes:{crm_ask_request_windows:0}}});
    const shown = (preview.body as {result:{requestId:string;previewHash:string}}).result;
    const committed = await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));
    expect(committed.status,JSON.stringify(committed.body)).toBe(200);
    expect((await post('/ask/answers/read',{requestId})).body).toMatchObject({state:'deleted',question:null,fallback:null,answer:null});
    expect(committed.body).toMatchObject({status:'accepted',result:{redacted:{crm_ask_requests:1},removed:{crm_ask_request_windows:0}}});
  } finally {
    await fixture.stop();
  }
});
