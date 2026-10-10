import pg from "pg";
import { localEnvelopeCipher } from "@fss/domain/mail/envelope.ts";
import { CLUSTER_URL_ENVIRONMENT_VARIABLE } from "@fss/domain/db/testing/testDatabase.ts";
import { enqueueJob } from "@fss/domain/jobs/jobStore.ts";
import { HandlerRegistry } from "@fss/domain/jobs/handlerRegistry.ts";
import { createCrmAcquisitionDiagnosticCapture } from "@fss/domain/mail/crmAcquisitionDiagnosticCapture.ts";
import { createGmailHttpClient } from "@fss/domain/mail/gmailClientHttp.ts";
import { registerHandlers } from "../../worker/src/bootstrap/main.ts";
import { runOnce } from "../../worker/src/runner/jobRunner.ts";
import {
  mailSourceListSchema,
  mailConversationV2Schema,
  businessPolicySchema,
  crmAcquisitionDiagnosticReadResultSchema,
  type CrmAcquisitionDiagnosticAuthorization,
} from "@fss/contracts";
import {
  crmAcquisitionDiagnosticFingerprint,
  provisionCrmAcquisitionDiagnostic,
  revokeCrmAcquisitionDiagnostic,
  type CrmAcquisitionDiagnosticRuntime,
} from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import { CRM_MAIL_CAPTURE_DISCLOSURE } from "@fss/domain/crm/capabilityAuthority.ts";
import {
  storeFixtureCiGateRecord,
  FIXTURE_CI_COMMIT,
  FIXTURE_API_DIGEST,
  FIXTURE_WORKER_DIGEST,
} from "@fss/domain/test/release/support/releaseRecords.ts";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionQueryable } from "@fss/domain/db/queryable.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  type AuthFixture,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
const paths = [
  "/crm/business/mail/diagnostic/request",
  "/crm/business/mail/diagnostic/read",
];
describe("isolated acquisition diagnostic public commands", () => {
  let fixture: AuthFixture;
  let db: SessionQueryable;
  let token: string;
  const post = (
    path: string,
    body: unknown,
    bearer: string | undefined = token,
    method = "POST",
    runtime?: CrmAcquisitionDiagnosticRuntime,
  ) =>
    dispatch(
      {
        method,
        path,
        body,
        query: new URLSearchParams(),
        headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
      },
      {
        session: db,
        auth: { ...fixture.deps, db },
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
        ...(runtime ? { crmAcquisitionDiagnosticRuntime: runtime } : {}),
      },
    );
  const request = () => ({
    commandId: randomUUID(),
    clientVersion: CURRENT_CLIENT_VERSION,
    authorizationId: randomUUID(),
    expectedAuthorizationSha256: "a".repeat(64),
  });
  beforeAll(async () => {
    fixture = await createAuthFixture({ purpose: "acquisition_diagnostic" });
    db = await fixture.database.appRuntimeSession();
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin))
      .accessToken;
  });
  afterAll(async () => fixture.stop());
  it("requires authentication and POST on both exact diagnostic routes", async () => {
    for (const path of paths) {
      expect((await post(path, {}, "")).status).toBe(401);
      expect((await post(path, {}, token, "GET")).status).toBe(405);
    }
  });
  it("refuses default-off requests durably without provider work or source creation", async () => {
    const input = request();
    const first = await post(paths[0]!, input);
    expect(first.body).toMatchObject({
      status: "refused",
      reason: "diagnostic_unavailable",
      replayed: false,
    });
    expect((await post(paths[0]!, input)).body).toMatchObject({
      status: "refused",
      reason: "diagnostic_unavailable",
      replayed: true,
    });
    expect(
      (
        await post(paths[0]!, {
          ...input,
          expectedAuthorizationSha256: "b".repeat(64),
        })
      ).body,
    ).toMatchObject({ status: "refused", reason: "command_payload_mismatch" });
    expect(
      (await post(paths[1]!, { authorizationId: input.authorizationId }))
        .status,
    ).toBe(404);
    expect(
      (
        await fixture.db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM jobs WHERE kind='crm.mail_capture'",
        )
      ).rows[0]?.count,
    ).toBe("0");
    expect(
      (
        await fixture.db.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM crm_mail_sources",
        )
      ).rows[0]?.count,
    ).toBe("0");
  });
  it("rejects malformed input and caller-supplied authority or activation flags", async () => {
    const input = request();
    for (const body of [
      { ...input, approved: true },
      { ...input, productionActivationAllowed: true },
      { ...input, expectedAuthorizationSha256: "invalid" },
      { ...input, purpose: "actual_acceptance" },
    ])
      expect((await post(paths[0]!, body)).status).toBe(400);
    expect(
      (
        await post(paths[1]!, {
          authorizationId: input.authorizationId,
          includeBodies: true,
        })
      ).status,
    ).toBe(400);
  });
  it("requires exact independent isolated authority, queues once, and exposes body-free owner progress", async () => {
    const environmentId = randomUUID();
    let isolationChecks = 0;
    const runtime: CrmAcquisitionDiagnosticRuntime = {
      environmentId,
      implementationCommit: FIXTURE_CI_COMMIT,
      imageDigest: FIXTURE_API_DIGEST,
      side: "api",
      schemaVersion: 90,
      consentIsolationBinding: {
        databaseInstanceArn: "controlled-db",
        databaseSecretArn: "controlled-secret",
        databaseEndpoint: "controlled.invalid",
        ecsClusterArn: "controlled-cluster",
      },
      verifyIsolation: async (input) => {
        isolationChecks++;
        return (
          input.environmentId === environmentId &&
          input.databaseName === fixture.database.name &&
          (input.purpose === "oauth_bootstrap" ||
            input.deploymentIdentity === "controlled-disposable-fixture")
        );
      },
    };
    const diagnosticPost = (path: string, body: unknown) =>
      post(path, body, token, "POST", runtime);
    for (const path of [
      "/crm/business/policy/save",
      "/crm/business/mail/controls/activate",
      "/ask/answers/request",
      "/replies/composer/send",
      "/crm/business/mail/import/request",
    ])
      expect((await post(path, {}, token, "POST", runtime)).status).toBe(404);
    const mailbox = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'scoped-fixture@example.test','scoped-fixture@example.test','connected') RETURNING id",
        [fixture.alpha.workspaceId, fixture.alpha.admin.userId],
      )
    ).rows[0];
    if (!mailbox) throw new Error("fixture mailbox missing");
    const policy = businessPolicySchema.parse(
      (await post("/crm/business/policy/read", { mailboxId: mailbox.id })).body,
    );
    if (!policy.accountBinding || !policy.generation)
      throw new Error("fixture binding missing");
    const observed = (
      await fixture.db.query<{ id: string }>(
        "INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'scoped-fixture@example.test',$4,$5) RETURNING id",
        [
          fixture.alpha.workspaceId,
          mailbox.id,
          fixture.alpha.admin.userId,
          policy.generation,
          [
            "https://www.googleapis.com/auth/gmail.readonly",
            "https://www.googleapis.com/auth/gmail.send",
          ],
        ],
      )
    ).rows[0];
    if (!observed) throw new Error("fixture OAuth observation missing");
    const releaseReference = await storeFixtureCiGateRecord(
      fixture.db,
      "105240",
    );
    const authorization: CrmAcquisitionDiagnosticAuthorization = {
      id: randomUUID(),
      purpose: "acquisition_acceptance",
      workspaceId: fixture.alpha.workspaceId,
      mailboxId: mailbox.id,
      ownerUserId: fixture.alpha.admin.userId,
      providerAccountId: "scoped-fixture@example.test",
      accountBinding: policy.accountBinding,
      generation: policy.generation,
      oauthGrantObservationId: observed.id,
      environmentId,
      databaseName: fixture.database.name,
      deploymentIdentity: "controlled-disposable-fixture",
      workerDeploymentIdentity: "controlled-disposable-worker-fixture",
      databaseInstanceArn: "synthetic-rds-instance",
      databaseSecretArn: "synthetic-db-secret",
      databaseEndpoint: "synthetic-db.invalid",
      ecsClusterArn: "synthetic-cluster",
      implementationCommit: FIXTURE_CI_COMMIT,
      apiImageDigest: FIXTURE_API_DIGEST,
      workerImageDigest: FIXTURE_WORKER_DIGEST,
      schemaVersion: 90,
      releaseReference,
      disclosureVersion: CRM_MAIL_CAPTURE_DISCLOSURE.version,
      disclosureSha256: CRM_MAIL_CAPTURE_DISCLOSURE.sha256,
      consentReference: "controlled fixture consent",
      providerPolicyReference: "controlled fixture policy",
      reviewedBy: fixture.alpha.admin.userId,
      reviewReference: "controlled fixture independent review",
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      validUntil: new Date(Date.now() + 3600000).toISOString(),
      maxReads: 8,
      maxUnits: 84,
      metadataUnits: 20,
      bodyUnits: 20,
      messages: [
        {
          messageId: "received_fixture",
          threadId: "received_thread",
          origin: "received",
          fromAt: "2026-01-01T00:00:00Z",
          toAt: "2027-01-01T00:00:00Z",
        },
        {
          messageId: "sent_fixture",
          threadId: "sent_thread",
          origin: "sent",
          fromAt: "2026-01-01T00:00:00Z",
          toAt: "2027-01-01T00:00:00Z",
        },
      ],
    };
    await fixture.db.query("SET ROLE migration");
    try {
      expect(
        await provisionCrmAcquisitionDiagnostic(fixture.db, authorization),
      ).toMatchObject({ ok: true });
    } finally {
      await fixture.db.query("RESET ROLE");
    }
    const input = {
      ...request(),
      authorizationId: authorization.id,
      expectedAuthorizationSha256:
        crmAcquisitionDiagnosticFingerprint(authorization),
    };
    expect(
      (
        await post(paths[0]!, input, token, "POST", {
          ...runtime,
          verifyIsolation: async () => false,
        })
      ).body,
    ).toMatchObject({
      status: "refused",
      reason: "diagnostic_authority_unavailable",
    });
    const valid = { ...input, commandId: randomUUID() };
    expect(
      (await post(paths[0]!, valid, token, "POST", runtime)).body,
    ).toMatchObject({
      status: "accepted",
      replayed: false,
      result: {
        authorizationId: authorization.id,
        status: "queued",
        productionActivationAllowed: false,
      },
    });
    expect(
      (await post(paths[0]!, valid, token, "POST", runtime)).body,
    ).toMatchObject({ status: "accepted", replayed: true });
    expect(
      (
        await post(
          paths[0]!,
          { ...valid, expectedAuthorizationSha256: "b".repeat(64) },
          token,
          "POST",
          runtime,
        )
      ).body,
    ).toMatchObject({ status: "refused", reason: "command_payload_mismatch" });
    expect(
      (
        await fixture.db.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM jobs WHERE kind='crm.mail_capture' AND payload->>'diagnosticAuthorizationId'=$1",
          [authorization.id],
        )
      ).rows[0]?.count,
    ).toBe(2);
    expect(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          token,
          "POST",
          { ...runtime, environmentId: randomUUID() },
        )
      ).status,
    ).toBe(404);
    const progress = crmAcquisitionDiagnosticReadResultSchema.parse(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          token,
          "POST",
          runtime,
        )
      ).body,
    );
    expect(progress).toMatchObject({
      purpose: "acquisition_acceptance",
      transport: "not_started",
      authorizationSha256: crmAcquisitionDiagnosticFingerprint(authorization),
      coverage: "explicit_scoped_partial",
      releaseReference,
      authorizedMessages: 2,
      attemptedReads: 0,
      observedUnits: 0,
      conservedUnits: 0,
      productionActivationAllowed: false,
    });
    expect(progress.copies).toHaveLength(2);
    expect(
      progress.copies.every(
        (copy) => copy.availability === "awaiting_recapture",
      ),
    ).toBe(true);
    const salesperson = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    expect(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          salesperson,
          "POST",
          runtime,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await post(
          paths[0]!,
          { ...input, commandId: randomUUID() },
          salesperson,
          "POST",
          runtime,
        )
      ).body,
    ).toMatchObject({ status: "refused", reason: "diagnostic_owner_required" });
    const otherWorkspace = (
      await issueSessionFor(fixture, fixture.beta, fixture.beta.admin)
    ).accessToken;
    expect(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          otherWorkspace,
          "POST",
          runtime,
        )
      ).status,
    ).toBe(404);
    let providerCalls = 0;
    let pausedMessage: string | null = null;
    let pauseFormat = "full";
    let faultMessage: string | null = null;
    let faultMode: "thread" | "date" | "origin" | "id" | "ambiguous" | null =
      null;
    let bodyStarted = () => {};
    let releaseBody = () => {};
    let heldBody = Promise.resolve();
    const originals: Record<string, string> & {
      received_fixture: string;
      sent_fixture: string;
      wait_fixture: string;
    } = {
      received_fixture: "Controlled incoming original.",
      sent_fixture: "Controlled sent reply.",
      wait_fixture: "Controlled pending original.",
    };
    const gmail = createGmailHttpClient({
      apiBaseUrl: "https://controlled-gmail.invalid",
      fetch: async (url) => {
        providerCalls++;
        const parsed = new URL(url);
        if (parsed.pathname.endsWith("/profile"))
          return {
            status: 200,
            headers: {},
            body: JSON.stringify({
              emailAddress: "scoped-fixture@example.test",
              historyId: "1",
            }),
          };
        const messageId = parsed.pathname.split("/").at(-1);
        if (!messageId || !Object.hasOwn(originals, messageId))
          throw new Error("unexpected controlled HTTP request");
        const format = parsed.searchParams.get("format");
        if (messageId === pausedMessage && format === pauseFormat) {
          bodyStarted();
          await heldBody;
        }
        if (
          messageId === faultMessage &&
          faultMode === "ambiguous" &&
          format === "full"
        )
          throw new Error("controlled ambiguous response");
        const sent = messageId === "sent_fixture";
        const body = {
          id:
            messageId === faultMessage && faultMode === "id"
              ? "wrong_actual_id"
              : messageId,
          threadId:
            messageId === faultMessage && faultMode === "thread"
              ? "wrong_thread"
              : sent
                ? "sent_thread"
                : messageId === "wait_fixture"
                  ? "wait_thread"
                  : messageId === "received_fixture"
                    ? "received_thread"
                    : `thread_${messageId}`,
          labelIds: [
            sent || (messageId === faultMessage && faultMode === "origin")
              ? "SENT"
              : "INBOX",
          ],
          internalDate: String(
            Date.parse(
              messageId === faultMessage && faultMode === "date"
                ? "2024-06-01T12:00:00Z"
                : "2026-06-01T12:00:00Z",
            ),
          ),
          payload: {
            mimeType: "text/plain",
            headers: [
              {
                name: "From",
                value: sent
                  ? "scoped-fixture@example.test"
                  : "unknown-business@example.test",
              },
              {
                name: "To",
                value: sent
                  ? "unknown-business@example.test"
                  : "scoped-fixture@example.test",
              },
              { name: "Subject", value: "Controlled diagnostic" },
              { name: "Date", value: "Mon, 1 Jun 2026 12:00:00 +0000" },
            ],
            ...(parsed.searchParams.get("format") === "full"
              ? {
                  body: {
                    data: Buffer.from(originals[messageId]!).toString(
                      "base64url",
                    ),
                  },
                }
              : {}),
          },
        };
        return { status: 200, headers: {}, body: JSON.stringify(body) };
      },
    });
    const capture = createCrmAcquisitionDiagnosticCapture({
      runtime: {
        ...runtime,
        side: "worker",
        verifyIsolation: async (input) =>
          input.environmentId === environmentId &&
          input.databaseName === fixture.database.name &&
          input.deploymentIdentity === authorization.workerDeploymentIdentity,
        imageDigest: FIXTURE_WORKER_DIGEST,
      },
      transport: "controlled",
      gmail,
      openSession: async () => {
        const cluster = process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE];
        if (!cluster) throw new Error("controlled database unavailable");
        const url = new URL(cluster);
        url.pathname = `/${fixture.database.name}`;
        const client = new pg.Client({ connectionString: url.toString() });
        await client.connect();
        await client.query("SET ROLE app_runtime");
        return { session: client, close: () => client.end() };
      },
      resolveAccess: async (input) => ({
        mailboxId: input.mailboxId,
        providerAccountId: "scoped-fixture@example.test",
        generation: policy.generation!,
        access: {
          accessToken: randomUUID(),
          expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 3600,
        },
      }),
    });
    const registry = new HandlerRegistry();
    registerHandlers(registry, {
      classifier: undefined,
      mail: undefined,
      send: undefined,
      research: undefined,
      crmMailCapture: {
        provider: {
          read: async () => {
            throw new Error("ordinary capture remains disabled");
          },
        },
        diagnostic: capture,
      },
    });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-scoped-diagnostic",
      limit: 10,
    });
    const copied = crmAcquisitionDiagnosticReadResultSchema.parse(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          token,
          "POST",
          runtime,
        )
      ).body,
    );
    expect(copied).toMatchObject({
      transport: "controlled",
      authorizationSha256: crmAcquisitionDiagnosticFingerprint(authorization),
      releaseReference,
      coverage: "explicit_scoped_partial",
      attemptedReads: 8,
      observedUnits: 84,
      conservedUnits: 0,
      accountingProvenance: "documented_current_schedule",
      accountingBuckets: [
        {
          scheduleVersion: "gmail-2026-05-01",
          attemptedReads: 8,
          observedUnits: 84,
          conservedUnits: 0,
        },
      ],
      productionActivationAllowed: false,
    });
    expect(copied.copies).toHaveLength(2);
    expect(
      copied.copies.every((copy) => copy.availability === "available"),
      JSON.stringify(copied),
    ).toBe(true);
    expect(providerCalls).toBe(8);
    const ordinaryJob = await enqueueJob(fixture.db, {
      workspaceId: fixture.alpha.workspaceId,
      kind: "crm.mail_capture",
      idempotencyKey: `controlled-ordinary-disabled:${randomUUID()}`,
      payload: {
        mailboxId: authorization.mailboxId,
        providerMessageId: "ordinary_disabled",
        providerAccountId: authorization.providerAccountId,
        generation: authorization.generation,
        conversationId: randomUUID(),
        controlsRevision: 1,
        policyRevision: 1,
        decisionRevision: 0,
      },
    });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-ordinary-disabled",
      limit: 10,
    });
    expect(providerCalls).toBe(8);
    expect(
      (
        await fixture.db.query<{
          state: string;
          progress: { outcome: string };
        }>(
          "SELECT state,payload->'progress' AS progress FROM jobs WHERE id=$1",
          [ordinaryJob.jobId],
        )
      ).rows[0],
    ).toMatchObject({
      state: "done",
      progress: null,
    });

    const listed = mailSourceListSchema.parse(
      (
        await diagnosticPost("/crm/business/mail/list", {
          mailboxId: mailbox.id,
          limit: 10,
        })
      ).body,
    );
    expect(listed.sources).toHaveLength(2);
    const hashes = Object.values(originals).map((text) => ({
      text,
      hash: createHash("sha256").update(text).digest("hex"),
    }));
    for (const copy of copied.copies) {
      let found = false;
      const refusals: string[] = [];
      for (const original of hashes) {
        const read = await diagnosticPost("/crm/business/mail/read/v2", {
          sourceId: copy.sourceId,
          sourceRevision: copy.sourceRevision,
          contentHash: original.hash,
        });
        const canonical = mailConversationV2Schema.parse(read.body);
        if (canonical.state === "unavailable") refusals.push(canonical.reason);
        if (canonical.state === "available") {
          expect(canonical.source.passage).toBe(original.text);
          expect(canonical.source.direction).toBe(
            original.text === originals.sent_fixture ? "outgoing" : "incoming",
          );
          const exact = {
            sourceId: copy.sourceId,
            sourceRevision: copy.sourceRevision,
            contentHash: original.hash,
          };
          expect(
            (await diagnosticPost("/crm/business/mail/evidence/read", exact))
              .status,
          ).toBe(404);
          const processingSource = {
            workspaceId: fixture.alpha.workspaceId,
            sourceId: copy.sourceId,
            kind: "mail" as const,
            revision: copy.sourceRevision,
            contentHash: original.hash,
            locator: null,
          };
          expect(
            (
              await diagnosticPost(
                "/crm/processing/source/read",
                processingSource,
              )
            ).status,
          ).toBe(404);
          expect(
            (
              await post("/ask/read", {
                operation: "passages",
                scope: { sources: [processingSource] },
                query: "Controlled",
                limit: 10,
              })
            ).status,
          ).toBe(404);
          expect(
            (await post("/crm/business/mail/evidence/read", exact)).body,
          ).toMatchObject({ reason: "diagnostic_source_unavailable" });
          found = true;
          expect(read.status).toBe(200);
          break;
        }
      }
      expect(
        found,
        JSON.stringify({ copy, refusals, listed: listed.sources }),
      ).toBe(true);
      expect(
        (
          await diagnosticPost("/crm/business/mail/delete", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            sourceId: copy.sourceId,
            expectedRevision: copy.sourceRevision,
          })
        ).body,
      ).toMatchObject({ status: "accepted" });
      for (const original of hashes)
        expect(
          mailConversationV2Schema.parse(
            (
              await diagnosticPost("/crm/business/mail/read/v2", {
                sourceId: copy.sourceId,
                sourceRevision: copy.sourceRevision,
                contentHash: original.hash,
              })
            ).body,
          ),
        ).toMatchObject({ state: "unavailable", source: null });
    }
    expect(
      (
        await post(
          paths[0]!,
          { ...valid, commandId: randomUUID() },
          token,
          "POST",
          runtime,
        )
      ).body,
    ).toMatchObject({ status: "accepted" });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-scoped-diagnostic-replay",
      limit: 10,
    });
    expect(providerCalls).toBe(8);
    const deleted = crmAcquisitionDiagnosticReadResultSchema.parse(
      (
        await post(
          paths[1]!,
          { authorizationId: authorization.id },
          token,
          "POST",
          runtime,
        )
      ).body,
    );
    expect(
      deleted.copies.every((copy) => copy.availability === "deleted"),
    ).toBe(true);
    const pendingAuthorization = {
      ...authorization,
      id: randomUUID(),
      maxReads: 4,
      maxUnits: 42,
      messages: [
        {
          messageId: "wait_fixture",
          threadId: "wait_thread",
          origin: "received" as const,
          fromAt: "2026-01-01T00:00:00Z",
          toAt: "2027-01-01T00:00:00Z",
        },
      ],
    };
    await fixture.db.query("SET ROLE migration");
    try {
      expect(
        await provisionCrmAcquisitionDiagnostic(
          fixture.db,
          pendingAuthorization,
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await fixture.db.query("RESET ROLE");
    }
    const pendingCommand = {
      ...request(),
      authorizationId: pendingAuthorization.id,
      expectedAuthorizationSha256:
        crmAcquisitionDiagnosticFingerprint(pendingAuthorization),
    };
    expect(
      (await diagnosticPost(paths[0]!, pendingCommand)).body,
    ).toMatchObject({ status: "accepted" });
    const pending = crmAcquisitionDiagnosticReadResultSchema.parse(
      (
        await diagnosticPost(paths[1]!, {
          authorizationId: pendingAuthorization.id,
        })
      ).body,
    );
    expect(pending.copies).toHaveLength(1);
    const pendingCopy = pending.copies[0]!;
    expect(pendingCopy.availability).toBe("awaiting_recapture");
    const reachedBody = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    heldBody = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    pausedMessage = "wait_fixture";
    const running = runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-delete-during-body-wait",
      limit: 10,
    });
    try {
      await Promise.race([
        reachedBody,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("controlled body boundary not reached")),
            5000,
          ),
        ),
      ]);
      expect(
        (
          await diagnosticPost("/crm/business/mail/delete", {
            commandId: randomUUID(),
            clientVersion: CURRENT_CLIENT_VERSION,
            sourceId: pendingCopy.sourceId,
            expectedRevision: pendingCopy.sourceRevision,
          })
        ).body,
      ).toMatchObject({ status: "accepted" });
    } finally {
      releaseBody();
      await running;
    }
    const afterDelete = crmAcquisitionDiagnosticReadResultSchema.parse(
      (
        await diagnosticPost(paths[1]!, {
          authorizationId: pendingAuthorization.id,
        })
      ).body,
    );
    expect(afterDelete).toMatchObject({
      transport: "controlled",
      attemptedReads: 4,
      observedUnits: 42,
      conservedUnits: 0,
      productionActivationAllowed: false,
      copies: [
        {
          sourceId: pendingCopy.sourceId,
          availability: "deleted",
          sourceRevision: 2,
        },
      ],
    });
    expect(
      mailConversationV2Schema.parse(
        (
          await diagnosticPost("/crm/business/mail/read/v2", {
            sourceId: pendingCopy.sourceId,
            sourceRevision: pendingCopy.sourceRevision,
            contentHash: createHash("sha256")
              .update(originals.wait_fixture)
              .digest("hex"),
          })
        ).body,
      ),
    ).toMatchObject({ state: "unavailable", source: null });
    const callsAfterDelete = providerCalls;
    expect(
      (await diagnosticPost(paths[0]!, pendingCommand)).body,
    ).toMatchObject({ status: "accepted", replayed: true });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-delete-during-body-wait-replay",
      limit: 10,
    });
    expect(providerCalls).toBe(callsAfterDelete);
    expect(
      crmAcquisitionDiagnosticReadResultSchema.parse(
        (
          await diagnosticPost(paths[1]!, {
            authorizationId: pendingAuthorization.id,
          })
        ).body,
      ),
    ).toEqual(afterDelete);
    async function scenarioAuthorization(messageId: string, maxUnits = 42) {
      originals[messageId] = "Controlled scoped fault original.";
      const grant = {
        ...authorization,
        id: randomUUID(),
        maxReads: 4,
        maxUnits,
        messages: [
          {
            messageId,
            threadId: `thread_${messageId}`,
            origin: "received" as const,
            fromAt: "2026-01-01T00:00:00Z",
            toAt: "2027-01-01T00:00:00Z",
          },
        ],
      };
      await fixture.db.query("SET ROLE migration");
      try {
        expect(
          await provisionCrmAcquisitionDiagnostic(fixture.db, grant),
        ).toMatchObject({ ok: true });
      } finally {
        await fixture.db.query("RESET ROLE");
      }
      const command = {
        ...request(),
        authorizationId: grant.id,
        expectedAuthorizationSha256: crmAcquisitionDiagnosticFingerprint(grant),
      };
      expect((await diagnosticPost(paths[0]!, command)).body).toMatchObject({
        status: "accepted",
      });
      return { grant, command };
    }
    async function scenarioProgress(authorizationId: string) {
      return crmAcquisitionDiagnosticReadResultSchema.parse(
        (await diagnosticPost(paths[1]!, { authorizationId })).body,
      );
    }
    for (const mode of ["thread", "date", "origin", "id"] as const) {
      faultMode = mode;
      faultMessage = `fault_${mode}`;
      const scoped = await scenarioAuthorization(faultMessage);
      const callsBefore = providerCalls;
      await runOnce(await fixture.database.appRuntimeSession(), {
        registry,
        owner: `controlled-scope-${mode}`,
        limit: 10,
      });
      const result = await scenarioProgress(scoped.grant.id);
      expect(result).toMatchObject({
        transport: "controlled",
        attemptedReads: 2,
        observedUnits: 21,
        conservedUnits: 0,
      });
      expect(
        result.copies.every((copy) => copy.availability !== "available"),
      ).toBe(true);
      expect(providerCalls - callsBefore).toBe(2);
    }
    faultMode = null;
    faultMessage = null;
    pauseFormat = "metadata";
    pausedMessage = "revoked_metadata";
    const revoked = await scenarioAuthorization(pausedMessage);
    const reachedMetadata = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    heldBody = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const revokeRunning = runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-revoke-during-metadata",
      limit: 10,
    });
    try {
      await Promise.race([
        reachedMetadata,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("controlled metadata boundary not reached")),
            5000,
          ),
        ),
      ]);
      await fixture.db.query("SET ROLE migration");
      try {
        expect(
          await revokeCrmAcquisitionDiagnostic(fixture.db, {
            workspaceId: fixture.alpha.workspaceId,
            authorizationId: revoked.grant.id,
            reference: "controlled metadata revocation",
          }),
        ).toMatchObject({ ok: true });
      } finally {
        await fixture.db.query("RESET ROLE");
      }
    } finally {
      releaseBody();
      await revokeRunning;
    }
    const revokedProgress = await scenarioProgress(revoked.grant.id);
    expect(revokedProgress).toMatchObject({
      transport: "controlled",
      attemptedReads: 2,
      observedUnits: 21,
      conservedUnits: 0,
    });
    expect(
      revokedProgress.copies.every((copy) => copy.availability !== "available"),
    ).toBe(true);
    pausedMessage = null;
    faultMode = "ambiguous";
    faultMessage = "ambiguous_body";
    const ambiguous = await scenarioAuthorization(faultMessage);
    const ambiguousRun = await runOnce(
      await fixture.database.appRuntimeSession(),
      { registry, owner: "controlled-ambiguous-body", limit: 10 },
    );
    const uncertain = await scenarioProgress(ambiguous.grant.id);
    expect(
      uncertain,
      JSON.stringify({ ambiguousRun, uncertain }),
    ).toMatchObject({
      transport: "controlled",
      attemptedReads: 3,
      observedUnits: 21,
      conservedUnits: 20,
    });
    expect(
      uncertain.copies.every((copy) => copy.availability !== "available"),
    ).toBe(true);
    const uncertainCalls = providerCalls;
    expect(
      (await diagnosticPost(paths[0]!, ambiguous.command)).body,
    ).toMatchObject({ status: "accepted", replayed: true });
    await fixture.db.query(
      "UPDATE jobs SET run_at=clock_timestamp(),not_before=clock_timestamp() WHERE workspace_id=$1 AND payload->>'diagnosticAuthorizationId'=$2 AND state='retryable'",
      [fixture.alpha.workspaceId, ambiguous.grant.id],
    );
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-ambiguous-body-restart",
      limit: 10,
    });
    expect(providerCalls).toBe(uncertainCalls);
    expect(await scenarioProgress(ambiguous.grant.id)).toMatchObject({
      attemptedReads: 3,
      observedUnits: 21,
      conservedUnits: 20,
    });
    faultMode = null;
    faultMessage = null;
    await fixture.db.query("SET ROLE migration");
    try {
      expect(
        await revokeCrmAcquisitionDiagnostic(fixture.db, {
          workspaceId: fixture.alpha.workspaceId,
          authorizationId: authorization.id,
          reference: "controlled fixture revoke",
        }),
      ).toMatchObject({ ok: true });
    } finally {
      await fixture.db.query("RESET ROLE");
    }
    expect(
      (
        await post(
          paths[0]!,
          { ...input, commandId: randomUUID() },
          token,
          "POST",
          runtime,
        )
      ).body,
    ).toMatchObject({
      status: "refused",
      reason: "diagnostic_authority_unavailable",
    });
    expect(
      crmAcquisitionDiagnosticReadResultSchema.parse(
        (
          await post(
            paths[1]!,
            { authorizationId: authorization.id },
            token,
            "POST",
            runtime,
          )
        ).body,
      ),
    ).toEqual(deleted);
    expect(
      (await post("/crm/business/policy/read", { mailboxId: mailbox.id })).body,
    ).toMatchObject({ enabled: false, revision: 0 });
    const budgetLimited = await scenarioAuthorization(
      "budget_limited_body",
      24,
    );
    const beforeLimited = providerCalls;
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-limited-units",
      limit: 10,
    });
    expect(providerCalls - beforeLimited).toBe(2);
    expect(await scenarioProgress(budgetLimited.grant.id)).toMatchObject({
      attemptedReads: 2,
      observedUnits: 21,
      conservedUnits: 0,
    });
    expect(
      (await scenarioProgress(budgetLimited.grant.id)).copies.every(
        (copy) => copy.availability !== "available",
      ),
    ).toBe(true);
    expect(
      (await diagnosticPost(paths[0]!, budgetLimited.command)).body,
    ).toMatchObject({ status: "accepted", replayed: true });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-limited-replay",
      limit: 10,
    });
    expect(providerCalls - beforeLimited).toBe(2);
    const retainedScoped = await scenarioAuthorization(
      "cleanup_retained_original",
    );
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-retained-before-cleanup",
      limit: 10,
    });
    const retainedCopy = (await scenarioProgress(retainedScoped.grant.id))
      .copies[0]!;
    expect(retainedCopy.availability).toBe("available");
    const cleanupScoped = await scenarioAuthorization("cleanup_body_wait");
    const cleanupAmbiguous = await scenarioAuthorization(
      "cleanup_ambiguous_wait",
    );
    const cleanupRequest = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      mailboxId: mailbox.id,
      reason: "controlled_complete",
    };
    const cleanupPost = (body: unknown) =>
      dispatch(
        {
          method: "POST",
          path: "/gmail/acquisition/cleanup",
          body,
          query: new URLSearchParams(),
          headers: { authorization: `Bearer ${token}` },
        },
        {
          session: db,
          auth: { ...fixture.deps, db },
          supportedClientVersions: fixture.deps.config.supportedClientVersions,
          sendingEnabled: false,
          crmAcquisitionDiagnosticRuntime: runtime,
          mail: {
            pushVerifier: { verify: async () => null },
            gmail,
            config: {
              clientId: "controlled-isolated",
              redirectUri: "https://controlled.invalid/oauth/gmail/callback",
              authorizationEndpoint: "https://controlled.invalid/authorize",
              tokenEndpoint: "https://controlled.invalid/token",
              revocationEndpoint: "https://controlled.invalid/revoke",
              apiBaseUrl: "https://controlled-gmail.invalid",
              pushTopicName: "unused",
              pushAudience: "unused",
              pushServiceAccountEmail: "unused",
              hostedDomain: fixture.hostedDomain,
              baselineDays: 30,
            },
            secrets: {
              names: () => ["gmail_oauth_client_secret"],
              read: async () => "controlled-secret",
            },
            cipher: localEnvelopeCipher("controlled-cleanup"),
            stateSigningKey: Buffer.alloc(48, 1),
          },
        },
      );
    const cleanupReached = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    heldBody = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    pausedMessage = "cleanup_body_wait";
    pauseFormat = "full";
    const cleanupRunning = runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-local-cleanup-during-body",
      limit: 1,
    });
    let ambiguousCleanupRunning: ReturnType<typeof runOnce> | undefined;
    try {
      await Promise.race([
        cleanupReached,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("cleanup body wait not reached")),
            5000,
          ),
        ),
      ]);
      const ambiguousReached = new Promise<void>((resolve) => {
        bodyStarted = resolve;
      });
      pausedMessage = "cleanup_ambiguous_wait";
      faultMessage = "cleanup_ambiguous_wait";
      faultMode = "ambiguous";
      ambiguousCleanupRunning = runOnce(
        await fixture.database.appRuntimeSession(),
        {
          registry,
          owner: "controlled-local-cleanup-ambiguous-wait",
          limit: 1,
        },
      );
      await Promise.race([
        ambiguousReached,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("ambiguous cleanup wait not reached")),
            5000,
          ),
        ),
      ]);
      const beforeCleanup = providerCalls;
      expect((await cleanupPost(cleanupRequest)).body).toMatchObject({
        status: "accepted",
        result: {
          localDisconnected: true,
          providerRevoked: false,
          trustedRevocationPending: true,
        },
      });
      expect(providerCalls).toBe(beforeCleanup);
    } finally {
      releaseBody();
      await cleanupRunning;
      await ambiguousCleanupRunning;
    }
    expect(await scenarioProgress(cleanupScoped.grant.id)).toMatchObject({
      attemptedReads: 3,
      observedUnits: 41,
      conservedUnits: 0,
      productionActivationAllowed: false,
    });
    expect(
      (await scenarioProgress(cleanupScoped.grant.id)).copies.every(
        (copy) => copy.availability !== "available",
      ),
    ).toBe(true);
    expect(await scenarioProgress(ambiguous.grant.id)).toMatchObject({
      attemptedReads: 3,
      observedUnits: 21,
      conservedUnits: 20,
    });
    expect(await scenarioProgress(cleanupAmbiguous.grant.id)).toMatchObject({
      attemptedReads: 3,
      observedUnits: 21,
      conservedUnits: 20,
    });
    expect(
      (await scenarioProgress(cleanupAmbiguous.grant.id)).copies.every(
        (copy) => copy.availability !== "available",
      ),
    ).toBe(true);
    const retainedRead = {
      sourceId: retainedCopy.sourceId,
      sourceRevision: retainedCopy.sourceRevision,
      contentHash: createHash("sha256")
        .update(originals["cleanup_retained_original"]!)
        .digest("hex"),
    };
    const retainedAfterCleanup = mailConversationV2Schema.parse(
      (await diagnosticPost("/crm/business/mail/read/v2", retainedRead)).body,
    );
    expect(retainedAfterCleanup.state).toBe("available");
    if (retainedAfterCleanup.state === "available")
      expect(retainedAfterCleanup.source.passage).toBe(
        "Controlled scoped fault original.",
      );
    expect(
      (
        await diagnosticPost("/crm/business/mail/delete", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          sourceId: retainedCopy.sourceId,
          expectedRevision: retainedCopy.sourceRevision,
        })
      ).body,
    ).toMatchObject({ status: "accepted" });
    expect(
      mailConversationV2Schema.parse(
        (await diagnosticPost("/crm/business/mail/read/v2", retainedRead)).body,
      ).state,
    ).toBe("unavailable");
    const settledCalls = providerCalls;
    expect(
      (await cleanupPost({ ...cleanupRequest, commandId: randomUUID() })).body,
    ).toMatchObject({
      status: "accepted",
      result: {
        tokenDeleted: false,
        providerRevoked: false,
        trustedRevocationPending: true,
      },
    });
    expect(
      (await diagnosticPost(paths[0]!, cleanupScoped.command)).body,
    ).toMatchObject({ status: "accepted", replayed: true });
    expect(
      (
        await diagnosticPost(paths[0]!, {
          ...cleanupScoped.command,
          commandId: randomUUID(),
        })
      ).body,
    ).toMatchObject({
      status: "refused",
      reason: "diagnostic_authority_unavailable",
    });
    await runOnce(await fixture.database.appRuntimeSession(), {
      registry,
      owner: "controlled-cleanup-no-restart",
      limit: 10,
    });
    expect(providerCalls).toBe(settledCalls);
    expect(isolationChecks).toBeGreaterThan(0);
  });
});
