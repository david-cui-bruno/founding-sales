import { METADATA_HEADERS } from "../../mail/types.ts";
import { recordMatchesForImport } from "../../mail/matching.ts";
import { createGmailHttpClient } from "../../mail/gmailClientHttp.ts";
import { recordingMailLog } from "../../mail/log.ts";
import { openHold, listApplicableHolds } from "../../policy/holds.ts";
import { afterEach, expect, it } from "vitest";
import { readMailbox } from "../../mail/mailboxes.ts";
import {
  normalizeMetadata,
  markMessageMatched,
  recordMessage,
  storeMessageBody,
  readMessageBody,
  listMessagesForOpportunity,
} from "../../mail/messages.ts";
import { runMailSync } from "../../mail/sync.ts";
import { runMailRecovery } from "../../mail/recover.ts";
import {
  createMailWorld,
  seedAnotherFirm,
  fixtureMessage,
  type MailWorld,
} from "./support/mailWorld.ts";
let world: MailWorld | undefined;
afterEach(async () => {
  await world?.stop();
  world = undefined;
});
it("reads draft metadata once without persisting, matching, acquiring bodies or applying replies, and advances the complete history prefix", async () => {
  world = await createMailWorld({ alphaHistoryId: "2000" });
  const w = world,
    context = w.systemContext(w.alpha.workspace.workspaceId);
  expect(
    (
      await runMailRecovery(context, w.syncDeps(w.alpha), {
        mailboxId: w.alpha.mailboxId,
        generation: 1,
      })
    ).outcome,
  ).toBe("completed");
  w.alpha.messages.push(
    ...["DRAFT", "SENT"].map((label, index) =>
      fixtureMessage({
        id: `draft-${index}`,
        historyId: `200${index + 1}`,
        from: w.alpha.address,
        to: w.crm.collidingEmail,
        body: "Interested in a demo?",
        labelIds: label === "DRAFT" ? ["DRAFT"] : ["DRAFT", "SENT"],
      }),
    ),
  );
  const gmail = w.clientWith(w.alpha, { historyId: "2002" });
  const result = await runMailSync(context, w.syncDeps(w.alpha, { gmail }), {
    mailboxId: w.alpha.mailboxId,
  });
  expect(result).toMatchObject({
    outcome: "synced",
    cursorTo: "2002",
    processedMessages: 2,
    messagesSeen: 2,
    messagesRecorded: 0,
    matched: 0,
    bodiesFetched: 0,
    holdsOpened: 0,
    directSendsRecorded: 0,
  });
  expect(gmail.metadataReads).toEqual(["draft-0", "draft-1"]);
  expect(gmail.bodyReads).toEqual([]);
  expect(
    await listMessagesForOpportunity(context, {
      opportunityId: w.crm.alpha.opportunityId,
    }),
  ).toEqual([]);
  expect(w.replyPromoter.promotions).toEqual([]);
  expect((await readMailbox(context, w.alpha.mailboxId))?.historyId).toBe(
    "2002",
  );
  const replay = await runMailSync(context, w.syncDeps(w.alpha, { gmail }), {
    mailboxId: w.alpha.mailboxId,
  });
  expect(replay.processedMessages).toBe(0);
  expect(gmail.metadataReads).toHaveLength(2);
});

it("bounded recovery excludes draft listings and completes real incoming coverage instead of rereading an unretained draft prefix", async () => {
  const drafts = Array.from({ length: 20 }, (_, index) =>
    fixtureMessage({
      id: `recovery-draft-${index}`,
      historyId: `10${index + 1}`,
      from: "sales.alpha@example.test",
      to: "reception@northwind.example.test",
      labelIds: ["DRAFT"],
      body: "Unsent text",
    }),
  );
  const received = fixtureMessage({
    id: "real-incoming",
    historyId: "2000",
    from: "reception@northwind.example.test",
    to: "sales.alpha@example.test",
    body: "Yes, could you tell me more?",
  });
  world = await createMailWorld({
    alphaMessages: [...drafts, received],
    alphaHistoryId: "2000",
  });
  const w = world,
    context = w.systemContext(w.alpha.workspace.workspaceId);
  const result = await runMailRecovery(
    context,
    w.syncDeps(w.alpha, { maxMessages: 1 }),
    { mailboxId: w.alpha.mailboxId, generation: 1 },
  );
  expect(result.outcome).toBe("completed");
  expect(w.alpha.gmail.metadataReads).toEqual(["real-incoming"]);
  expect(w.alpha.gmail.bodyReads).toEqual(["real-incoming"]);
  expect(
    (
      await listMessagesForOpportunity(context, {
        opportunityId: w.crm.alpha.opportunityId,
      })
    ).map((message) => ({
      providerId: message.providerMessageId,
      direction: message.direction,
    })),
  ).toEqual([{ providerId: "real-incoming", direction: "incoming" }]);
});

it("refuses a legacy retained draft that later appears Sent, preserving its original body and hold with a body-free review diagnostic", async () => {
  world = await createMailWorld({ alphaHistoryId: "2000" });
  const w = world,
    context = w.systemContext(w.alpha.workspace.workspaceId);
  await runMailRecovery(context, w.syncDeps(w.alpha), {
    mailboxId: w.alpha.mailboxId,
    generation: 1,
  });
  const old = fixtureMessage({
    id: "legacy-draft",
    historyId: "2001",
    from: w.alpha.address,
    to: w.crm.collidingEmail,
    labelIds: ["DRAFT"],
    body: "Old unsent text",
  });
  w.alpha.messages.push(old);
  const metadata = await w.alpha.gmail.getMetadata(
    { accessToken: "controlled", expiresAtEpochSeconds: 9999999999 },
    old.id,
    METADATA_HEADERS,
  );
  if (!metadata) throw new Error("fixturemetadata missing");
  const stored = await recordMessage(context, {
    mailboxId: w.alpha.mailboxId,
    metadata: normalizeMetadata(metadata),
  });
  await markMessageMatched(context, stored.message.id);
  await storeMessageBody(context, {
    messageId: stored.message.id,
    text: "Old unsent text",
    truncated: false,
  });
  const hold = await openHold(context, {
    scopeKind: "firm",
    scopeKey: w.crm.alpha.firmId,
    reasonCode: "uncertain_reply",
    blockedActionKinds: ["email_send"],
    sourceEventKind: "mail_message",
    sourceEventId: stored.message.id,
    ownerUserId: w.alpha.workspace.salesperson.userId,
    recoveryAction: "confirm_reply",
  });
  w.alpha.messages[0] = fixtureMessage({
    ...old,
    from: w.alpha.address,
    to: w.crm.collidingEmail,
    id: old.id,
    historyId: "2001",
    labelIds: ["SENT"],
    body: "Actual sent content",
  });
  const gmail = w.clientWith(w.alpha, { historyId: "2001" }),
    log = recordingMailLog();
  const result = await runMailSync(
    context,
    w.syncDeps(w.alpha, { gmail, log }),
    { mailboxId: w.alpha.mailboxId },
  );
  expect(result).toMatchObject({
    outcome: "synced",
    cursorTo: "2001",
    messagesRecorded: 0,
    bodiesFetched: 0,
    matched: 0,
    directSendsRecorded: 0,
    holdsOpened: 0,
  });
  expect(gmail.bodyReads).toEqual([]);
  expect(await readMessageBody(context, stored.message.id)).toMatchObject({
    text: "Old unsent text",
  });
  expect(
    (
      await listApplicableHolds(context, {
        actionKind: "email_send",
        firmId: w.crm.alpha.firmId,
      })
    ).map((item) => item.id),
  ).toContain(hold);
  expect(log.lines).toContainEqual(
    expect.objectContaining({ event: "mail.legacy_draft_requires_review" }),
  );
  expect(JSON.stringify(log.lines)).not.toContain("Actual sent content");
});

it("ordinary recovery's real Gmail HTTP query excludes drafts while metadata races remain filtered", async () => {
  const received = fixtureMessage({
    id: "http-incoming",
    historyId: "2000",
    from: "reception@northwind.example.test",
    to: "sales.alpha@example.test",
    body: "Would you send more info?",
  });
  world = await createMailWorld({
    alphaMessages: [received],
    alphaHistoryId: "2000",
  });
  const w = world,
    queries: string[] = [];
  const http = createGmailHttpClient({
    apiBaseUrl: "https://gmail.example.test",
    fetch: async (raw) => {
      const url = new URL(String(raw)),
        q = url.searchParams.get("q") ?? "";
      queries.push(q);
      const after = Number(/after:(\d+)/u.exec(q)?.[1]),
        before = Number(/before:(\d+)/u.exec(q)?.[1]),
        at = received.internalDateEpochMilliseconds / 1000;
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          messages:
            at >= after && at < before
              ? [{ id: received.id, threadId: received.threadId }]
              : [],
        }),
      };
    },
  });
  const context = w.systemContext(w.alpha.workspace.workspaceId);
  const result = await runMailRecovery(
    context,
    w.syncDeps(w.alpha, {
      gmail: { ...w.alpha.gmail, listMessageIds: http.listMessageIds },
    }),
    { mailboxId: w.alpha.mailboxId, generation: 1 },
  );
  expect(result.outcome).toBe("completed");
  expect(queries.length).toBeGreaterThan(0);
  expect(queries.every((query) => query.includes("-in:drafts "))).toBe(true);
  expect(w.alpha.gmail.bodyReads).toEqual(["http-incoming"]);
});

it("a retained draft is neither a thread matching anchor nor RFC duplicate proof for a real incoming message", async () => {
  world = await createMailWorld({ alphaHistoryId: "2000" });
  const w = world,
    context = w.systemContext(w.alpha.workspace.workspaceId);
  await runMailRecovery(context, w.syncDeps(w.alpha), {
    mailboxId: w.alpha.mailboxId,
    generation: 1,
  });
  const other = await seedAnotherFirm(w, w.alpha.workspace, {
    name: "Second Test Firm",
    address: "other@firm.example.test",
  });
  const old = fixtureMessage({
    id: "old-anchor",
    threadId: "shared-thread",
    historyId: "2001",
    from: w.crm.collidingEmail,
    to: w.alpha.address,
    labelIds: ["DRAFT"],
    messageId: "shared-id@example.test",
    body: "Unsent draft",
  });
  w.alpha.messages.push(old);
  const metadata = await w.alpha.gmail.getMetadata(
    { accessToken: "controlled", expiresAtEpochSeconds: 9999999999 },
    old.id,
    METADATA_HEADERS,
  );
  if (!metadata) throw new Error("fixture metadata missing");
  const normalized = normalizeMetadata(metadata),
    stored = await recordMessage(context, {
      mailboxId: w.alpha.mailboxId,
      metadata: normalized,
    });
  await recordMatchesForImport(context, {
    messageId: stored.message.id,
    candidates: [
      {
        firmId: w.crm.alpha.firmId,
        opportunityId: w.crm.alpha.opportunityId,
        contactId: w.crm.alpha.contactId,
        rule: "participant",
        viaClosedOpportunity: false,
      },
    ],
    metadata: normalized,
    directSend: false,
  });
  const real = fixtureMessage({
    id: "new-incoming",
    threadId: "shared-thread",
    historyId: "2002",
    from: "other@firm.example.test",
    to: w.alpha.address,
    body: "Interested in more details",
  });
  // A second real message also reuses the historical draft's exact headers and RFC ID.
  const collision = fixtureMessage({
    id: "new-rfc",
    historyId: "2003",
    from: w.crm.collidingEmail,
    to: w.alpha.address,
    messageId: "shared-id@example.test",
    body: "A real reply",
  });
  w.alpha.messages.push(real, collision);
  const gmail = w.clientWith(w.alpha, { historyId: "2003" });
  const result = await runMailSync(context, w.syncDeps(w.alpha, { gmail }), {
    mailboxId: w.alpha.mailboxId,
  });
  expect(result).toMatchObject({
    messagesRecorded: 2,
    duplicateRfcId: 0,
    rfcIdConflicts: 1,
  });
  expect(gmail.bodyReads).toEqual(["new-incoming", "new-rfc"]);
  expect(
    (
      await listMessagesForOpportunity(context, {
        opportunityId: other.opportunityId,
      })
    ).map((message) => message.providerMessageId),
  ).toEqual(["new-incoming"]);
  expect(
    (
      await listMessagesForOpportunity(context, {
        opportunityId: w.crm.alpha.opportunityId,
      })
    )
      .map((message) => message.providerMessageId)
      .sort(),
  ).toEqual(["new-rfc", "old-anchor"]);
});

it("does not prove an RFC duplicate from a retained real message whose current provider metadata is a draft", async () => {
  world = await createMailWorld({ alphaHistoryId: "2000" });
  const w = world,
    context = w.systemContext(w.alpha.workspace.workspaceId);
  await runMailRecovery(context, w.syncDeps(w.alpha), {
    mailboxId: w.alpha.mailboxId,
    generation: 1,
  });
  const old = fixtureMessage({
    id: "old-real",
    historyId: "2000",
    from: w.crm.collidingEmail,
    to: w.alpha.address,
    messageId: "changed-object@example.test",
  });
  const fixture = w.clientWith(w.alpha, { sentMessages: [old] });
  const metadata = await fixture.getMetadata(
    { accessToken: "fixture", expiresAtEpochSeconds: 9999999999 },
    old.id,
    METADATA_HEADERS,
  );
  if (metadata === null) throw new Error("fixture metadata missing");
  await recordMessage(context, {
    mailboxId: w.alpha.mailboxId,
    metadata: normalizeMetadata(metadata),
  });
  w.alpha.messages.push(
    { ...old, labelIds: ["DRAFT"] },
    fixtureMessage({
      id: "new-real",
      historyId: "2001",
      from: w.crm.collidingEmail,
      to: w.alpha.address,
      messageId: "changed-object@example.test",
      body: "An actual reply",
    }),
  );
  const gmail = w.clientWith(w.alpha, { historyId: "2001" });
  const result = await runMailSync(context, w.syncDeps(w.alpha, { gmail }), {
    mailboxId: w.alpha.mailboxId,
  });
  expect(result).toMatchObject({
    messagesRecorded: 1,
    duplicateRfcId: 0,
    rfcIdConflicts: 1,
  });
  expect(gmail.bodyReads).toEqual(["new-real"]);
});
