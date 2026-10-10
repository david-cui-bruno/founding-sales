import { expect, it } from "vitest";
import {
  createMailWorld,
  fixtureMessage,
  TEST_TOPIC_NAME,
} from "@fss/domain/test/mail/support/mailWorld.ts";
import { runMailRecovery } from "@fss/domain/mail/recover.ts";
import { readMailbox } from "@fss/domain/mail/mailboxes.ts";
import { listMessagesForOpportunity } from "@fss/domain/mail/messages.ts";
import { claimJobs } from "@fss/domain/jobs/jobStore.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { mailHandlers } from "../src/handlers/mail.ts";
import { runClaimedJob } from "../src/runner/jobRunner.ts";
it("registered sync advances past drafts while retaining actual incoming and manually Sent progress", async () => {
  const w = await createMailWorld({ alphaHistoryId: "2000" });
  try {
    const context = w.systemContext(w.alpha.workspace.workspaceId);
    await runMailRecovery(context, w.syncDeps(w.alpha), {
      mailboxId: w.alpha.mailboxId,
      generation: 1,
    });
    w.alpha.messages.push(
      fixtureMessage({
        id: "worker-draft",
        historyId: "2001",
        from: w.alpha.address,
        to: w.crm.collidingEmail,
        labelIds: ["DRAFT"],
        body: "Unsent question",
      }),
      fixtureMessage({
        id: "worker-incoming",
        threadId: "real-thread",
        historyId: "2002",
        from: w.crm.collidingEmail,
        to: w.alpha.address,
        body: "Can you tell me more?",
      }),
      fixtureMessage({
        id: "worker-sent",
        threadId: "real-thread",
        historyId: "2003",
        from: w.alpha.address,
        to: w.crm.collidingEmail,
        labelIds: ["SENT"],
        body: "Here are the details",
      }),
    );
    const gmail = w.clientWith(w.alpha, { historyId: "2003" }),
      registry = new HandlerRegistry();
    for (const handler of mailHandlers({
      ...w.syncDeps(w.alpha, { gmail }),
      pushTopicName: TEST_TOPIC_NAME,
    }))
      registry.register(handler);
    const jobs = await claimJobs(w.database.session, {
      owner: "draft-probe",
      kinds: ["mail.sync"],
      limit: 10,
      leaseSeconds: 60,
    });
    const job = jobs.find(
      (value) => value.workspaceId === w.alpha.workspace.workspaceId,
    );
    if (!job) throw new Error("syncfixturemissing");
    const outcome = await runClaimedJob(w.database.session, { registry, job });
    expect(outcome).toBe("completed");
    expect(gmail.metadataReads).toEqual([
      "worker-draft",
      "worker-incoming",
      "worker-sent",
    ]);
    expect(gmail.bodyReads).toEqual(["worker-incoming"]);
    expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe(
      "2003",
    );
    expect(
      (
        await listMessagesForOpportunity(context, {
          opportunityId: w.crm.alpha.opportunityId,
        })
      )
        .map((message) => ({
          id: message.providerMessageId,
          direction: message.direction,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ).toEqual([
      { id: "worker-incoming", direction: "incoming" },
      { id: "worker-sent", direction: "outgoing" },
    ]);
    expect(w.replyPromoter.promotions).toHaveLength(1);
  } finally {
    await w.stop();
  }
});
