import { randomUUID, createHash } from "node:crypto";
import { expect, it } from "vitest";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { enqueueJob, claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { workspaceScope } from "@fss/domain/db/workspaceScope.ts";
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

it("retrieves retained mail passages after disconnect without a processing grant or provider call", async () => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture);
    let reads = 0;
    const text =
      "ordinary context ".repeat(125) + "Drainage coordination is needed.";
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmMailCapture: {
        proofVerifier: {
          async verify() {
            return true;
          },
        },
        provider: {
          async read() {
            reads++;
            return {
              providerAccountId: "google-business",
              messageId: "approved-message",
              threadId: "approved-thread",
              labels: ["INBOX"],
              providerAt: "2026-10-08T15:00:00.000Z",
              rawSenderDate: null,
              from: "Unknown@business.test",
              to: ["business@example.test"],
              cc: [],
              subject: "Business",
              body: text,
              parserVersion: "fixture-mime-v1",
              representation: "plain_text" as const,
              completeness: "partial" as const,
              ranges: [
                { start: 0, end: text.length, kind: "unknown" as const },
              ],
            };
          },
        },
      },
    });
    const handler = registry.get("crm.mail_capture")!;
    const captured = await handler.handle({
      session: fixture.db,
      scope: workspaceScope(approved.workspaceId, {
        kind: "system",
        component: "worker",
      }),
      job: approved.job,
    });
    expect(captured).toMatchObject({
      done: true,
      progress: { outcome: "captured", sourceRevision: 1 },
    });
    const sourceId = captured!.progress["sourceId"];
    expect(typeof sourceId).toBe("string");
    await fixture.db.query(
      "UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",
      [approved.workspaceId, approved.mailbox.id],
    );
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const read = await dispatch(
      {
        method: "POST",
        path: "/ask/read",
        query: new URLSearchParams(),
        headers: { authorization: `Bearer ${token}` },
        body: {
          operation: "passages",
          scope: {
            sources: [
              {
                workspaceId: approved.workspaceId,
                kind: "mail",
                sourceId,
                revision: 1,
                contentHash: createHash("sha256").update(text).digest("hex"),
                locator: null,
              },
            ],
          },
          query: "Drainage",
        },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
      },
    );
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({
      passages: [
        {
          text: text.slice(2000),
          sources: [
            {
              sourceId,
              kind: "mail",
              revision: 1,
              locator: `text:2000:${text.length}`,
              speaker: null,
              occurredAt: "2026-10-08T15:00:00.000Z",
              completeness: "partial",
            },
          ],
        },
      ],
      coverage: {
        scanComplete: true,
        inspectedSources: 1,
        inspectedWindows: 2,
        semantic: "not_requested",
      },
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
        },
      );
    const created = await post("/crm/people/create", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      fullName: "Explicit mail context",
    });
    const personId = (created.body as { result: { personId: string } }).result
      .personId;
    expect(
      (
        await post("/crm/business/mail/associate", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          sourceId,
          expectedRevision: 1,
          personId,
        })
      ).status,
    ).toBe(200);
    const discovered = await post("/ask/read", {
      operation: "sources",
      scope: { personId },
    });
    expect(discovered.status).toBe(200);
    expect(discovered.body).toMatchObject({
      sources: [
        {
          sourceId,
          kind: "mail",
          revision: 2,
          locator: null,
          availability: "available",
          completeness: "partial",
        },
      ],
      coverage: { scanComplete: true },
    });
    expect(JSON.stringify(discovered.body)).not.toContain(
      "Drainage coordination",
    );
    expect(reads).toBe(1);
  } finally {
    await fixture.stop();
  }
});

it("discovers more than ten explicitly associated permitted mail copies within the bounded record page", async () => {
  const fixture = await createAuthFixture();
  try {
    const approved = await approveCaptureFixture(fixture),
      token = (
        await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
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
    const person = (
      await post("/crm/people/create", {
        commandId: randomUUID(),
        clientVersion: CURRENT_CLIENT_VERSION,
        fullName: "Explicit batch mail context",
      })
    ).body as { result: { personId: string } };
    const text = "Retained original business copy.";
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmMailCapture: {
        proofVerifier: {
          async verify() {
            return true;
          },
        },
        provider: {
          async read(input) {
            return {
              providerAccountId: "google-business",
              messageId: input.providerMessageId,
              threadId: "approved-thread",
              labels: ["INBOX"],
              providerAt: "2026-10-08T15:00:00.000Z",
              rawSenderDate: null,
              from: "Unknown@business.test",
              to: ["business@example.test"],
              cc: [],
              subject: "Business",
              body: text,
              parserVersion: "fixture-mime-v1",
              representation: "plain_text" as const,
              completeness: "partial" as const,
              ranges: [
                { start: 0, end: text.length, kind: "unknown" as const },
              ],
            };
          },
        },
      },
    });
    const handler = registry.get("crm.mail_capture")!,
      sourceIds = [];
    for (let index = 0; index < 12; index++) {
      let job = approved.job;
      if (index > 0) {
        await enqueueJob(fixture.db, {
          workspaceId: approved.workspaceId,
          kind: "crm.mail_capture",
          idempotencyKey: `ask-batch:${index}`,
          payload: {
            mailboxId: approved.mailbox.id,
            providerMessageId: `approved-message-${index}`,
            providerAccountId: "google-business",
            generation: 1,
            conversationId: approved.conversationId,
            controlsRevision: 1,
            policyRevision: 1,
            decisionRevision: 0,
          },
        });
        job = (
          await claimJobs(fixture.db, {
            owner: "ask-batch",
            kinds: ["crm.mail_capture"],
            limit: 1,
            leaseSeconds: 120,
          })
        )[0]!;
      }
      const captured = await handler.handle({
        session: fixture.db,
        scope: workspaceScope(approved.workspaceId, {
          kind: "system",
          component: "worker",
        }),
        job,
      });
      expect(captured).toMatchObject({
        done: true,
        progress: { outcome: "captured", sourceRevision: 1 },
      });
      const sourceId = captured!.progress["sourceId"];
      sourceIds.push(sourceId);
      expect(
        (
          await post("/crm/business/mail/associate", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            sourceId,
            expectedRevision: 1,
            personId: person.result.personId,
          })
        ).status,
      ).toBe(200);
    }
    const read = await post("/ask/read", {
      operation: "sources",
      scope: { personId: person.result.personId },
    });
    expect(read.status).toBe(200);
    const page = read.body as {
      sources: { sourceId: string; kind: string; revision: number }[];
    };
    expect(page.sources.map((source) => source.sourceId).sort()).toEqual(
      sourceIds.sort(),
    );
    expect(
      page.sources.every(
        (source) => source.kind === "mail" && source.revision === 2,
      ),
    ).toBe(true);
    expect(read.body).toMatchObject({
      nextAfter: null,
      coverage: { scanComplete: true, candidateCeiling: 50 },
    });
    expect(JSON.stringify(read.body)).not.toContain(text);
  } finally {
    await fixture.stop();
  }
});
