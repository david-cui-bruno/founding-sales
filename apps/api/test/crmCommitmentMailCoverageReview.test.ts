import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { crmProcessingResultSchema } from "@fss/contracts";
import { createNativeCrmMailEvidence } from "@fss/domain/crm/nativeMailEvidence.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { enqueueJob, claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { businessAccountBinding } from "@fss/domain/business/acquisition.ts";
import { workspaceScope } from "@fss/domain/db/workspaceScope.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
import { seedFirm, seedContact } from "./support/crmSeed.ts";
import { dispatch } from "../src/server.ts";
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

it("keeps Today usable with eleven independently captured permitted mail promises", async () => {
  const fixture = await createAuthFixture();
  try {
    const {
      workspaceId,
      mailbox,
      binding,
      conversationId,
      job: firstJob,
    } = await approveCaptureFixture(fixture);
    const token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin)
    ).accessToken;
    const port = createNativeCrmMailEvidence({
      verify: async (proof) => proof.accountBinding === binding,
    });
    const options = {
      session: fixture.db,
      auth: fixture.deps,
      supportedClientVersions: fixture.deps.config.supportedClientVersions,
      sendingEnabled: false,
      crmMailEvidence: port,
    };
    const post = (path: string, body: unknown) =>
      dispatch(
        {
          method: "POST",
          path,
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        options,
      );
    const get = (path: string) =>
      dispatch(
        {
          method: "GET",
          path,
          body: null,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        options,
      );
    const command = (fields: object) => ({
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...fields,
    });
    const firmId = await seedFirm(fixture, {
      name: "Eleven supported mail promises",
      assignedUserId: fixture.alpha.admin.userId,
    });
    const contactId = await seedContact(fixture, {
      firmId,
      fullName: "Supported mail correspondent",
    });
    expect(
      (await post("/crm/people/bridge", command({ contactIds: [contactId] })))
        .status,
    ).toBe(200);
    const opportunityId = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id",
        [workspaceId, firmId],
      )
    ).rows[0]!.id;
    expect(
      (
        await post(
          "/crm/processing/purpose/save",
          command({
            expectedRevision: 0,
            enabled: false,
            endpointId: "mail-coverage-evaluation",
            modelVersion: "fixture-mail-coverage",
            accessGrantVersion: "fixture",
            dataHandlingVersion: "fixture",
            dailyCeilingCents: 100,
            monthlyCeilingCents: 1000,
            inputTokenPriceMicros: 1,
            outputTokenPriceMicros: 1,
          }),
        )
      ).status,
    ).toBe(200);
    // Explicit isolated fake evaluation configuration; no production activation.
    await fixture.db.query(
      "UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1",
      [workspaceId],
    );
    const registry = registerHandlers(new HandlerRegistry(), {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmExtraction: {
        mailEvidence: port,
        adapter: {
          endpointId: "mail-coverage-evaluation",
          modelVersion: "fixture-mail-coverage",
          accessGrantVersion: "fixture",
          dataHandlingVersion: "fixture",
          providerKey: "fixture.mail_coverage",
          fundingVerifiedUntil: "2099-01-01T00:00:00Z",
          run: async ({ text }) => {
            const original = JSON.parse(text) as { text: string };
            return {
              acceptance: "accepted",
              usage: { inputTokens: 1, outputTokens: 1 },
              claims: [
                {
                  kind: "commitment",
                  status: "stated",
                  interpretation: "A human must attest this promise",
                  locator: `text:0:${original.text.length}`,
                  quote: original.text,
                },
              ],
            };
          },
        },
      },
    });
    const taskIds: string[] = [];
    for (let index = 0; index < 11; index++) {
      const providerMessageId =
        index === 0 ? "approved-message" : `approved-message-${index}`;
      const quote = `I will prepare summary item ${index + 1} by October 12.`;
      const message = (
        await fixture.db.query<{ id: string }>(
          "INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,$3,'approved-thread','outgoing','2026-10-08T15:00:00Z',true) RETURNING id",
          [workspaceId, mailbox.id, providerMessageId],
        )
      ).rows[0]!;
      await fixture.db.query(
        "INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,contact_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",
        [workspaceId, message.id, firmId, contactId, opportunityId],
      );
      let job = firstJob;
      if (index !== 0) {
        await enqueueJob(fixture.db, {
          workspaceId,
          kind: "crm.mail_capture",
          idempotencyKey: `mail-coverage-${index}`,
          payload: {
            mailboxId: mailbox.id,
            providerMessageId,
            providerAccountId: "google-business",
            generation: 1,
            conversationId,
            controlsRevision: 1,
            policyRevision: 1,
            decisionRevision: 0,
          },
        });
        job = (
          await claimJobs(fixture.db, {
            owner: `capture-fixture-${index}`,
            kinds: ["crm.mail_capture"],
            limit: 1,
            leaseSeconds: 120,
          })
        )[0]!;
      }
      const capture = registerHandlers(new HandlerRegistry(), {
        classifier: undefined,
        mail: undefined,
        send: undefined,
        research: undefined,
        crmMailCapture: {
          proofVerifier: {
            verify: async (proof) => proof.accountBinding === binding,
          },
          provider: {
            read: async () => ({
              providerAccountId: "google-business",
              messageId: providerMessageId,
              threadId: "approved-thread",
              labels: ["SENT"],
              origin: "sent",
              providerAt: "2026-10-08T15:00:00.000Z",
              rawSenderDate: null,
              from: "business@example.test",
              to: ["known@example.test"],
              cc: [],
              subject: `Copied promise ${index + 1}`,
              body: quote,
              parserVersion: "controlled-authored-mime-v1",
              representation: "plain_text",
              completeness: "complete",
              ranges: [{ start: 0, end: quote.length, kind: "authored" }],
            }),
          },
        },
      });
      const handler = capture.get("crm.mail_capture");
      if (handler === undefined) throw new Error("capture handler missing");
      expect(
        (
          await handler.handle({
            session: fixture.db,
            scope: workspaceScope(workspaceId, {
              kind: "system",
              component: "worker",
            }),
            job,
          })
        )?.progress["sourceId"],
      ).toBe(message.id);
      const source = {
        workspaceId,
        sourceId: message.id,
        kind: "mail" as const,
        revision: 1,
        contentHash: createHash("sha256").update(quote).digest("hex"),
        locator: null,
      };
      expect(
        (await post("/crm/processing/request", command({ source }))).status,
      ).toBe(200);
      await runOnce(fixture.db, {
        registry,
        owner: `mail-coverage-extraction-${index}`,
        limit: 20,
      });
      const processed = crmProcessingResultSchema.parse(
        (await post("/crm/processing/read", { source })).body,
      );
      if (processed.state !== "complete")
        throw new Error("controlled extraction missing");
      const claim = processed.claims[0]!;
      expect(
        (
          await post(
            "/crm/commitments/review",
            command({
              source,
              claimId: claim.claimId,
              claimRevision: 1,
              claimHash: claim.claimHash,
              contextHash: processed.contextHash,
              expectedDecisionRevision: 0,
              expectedCommitmentRevision: 0,
              classification: "internal_promise",
              actor: "self",
              actionLabel: `Prepare summary item ${index + 1}`,
              due: {
                kind: "date",
                date: "2026-10-12",
                zone: "UTC",
                expression: "by October 12",
              },
            }),
          )
        ).status,
      ).toBe(200);
      await runOnce(fixture.db, {
        registry,
        owner: `mail-coverage-project-${index}`,
        limit: 20,
      });
      const individual = await post("/crm/commitments/read", {
        scope: { kind: "source", sourceId: message.id, sourceKind: "mail" },
        limit: 50,
      });
      expect(individual.status).toBe(200);
      taskIds.push(
        (individual.body as { items: { task: { taskId: string } }[] }).items[0]!
          .task.taskId,
      );
      if (index === 9) {
        const ten = await get("/today/actions/v2");
        expect(ten.status).toBe(200);
        expect(
          (ten.body as { actions: { kind: string }[] }).actions.filter(
            (value) => value.kind === "promise",
          ),
        ).toHaveLength(10);
      }
    }
    const eleven = await get("/today/actions/v2");
    expect(eleven.status).toBe(200);
    expect(
      (
        eleven.body as {
          actions: { kind: string; target: { taskId: string } }[];
        }
      ).actions
        .filter((value) => value.kind === "promise")
        .map((value) => value.target.taskId)
        .sort(),
    ).toEqual(taskIds.sort());
  } finally {
    await fixture.stop();
  }
});
