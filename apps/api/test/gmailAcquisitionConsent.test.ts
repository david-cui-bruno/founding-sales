import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gmailConnectResultSchema, gmailStatusSchema } from "@fss/contracts";
import {
  createGmailHttpClient,
  type HttpFetch,
} from "@fss/domain/mail/gmailClientHttp.ts";
import { localEnvelopeCipher } from "@fss/domain/mail/envelope.ts";
import type { CrmAcquisitionDiagnosticRuntime } from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import type { MailRoutingDeps } from "../src/routes/types.ts";
import { dispatch } from "../src/server.ts";
import {
  createAuthFixture,
  CURRENT_CLIENT_VERSION,
  type AuthFixture,
} from "./support/authFixture.ts";
import { issueSessionFor } from "./support/sessionFixture.ts";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const TOKEN = "https://oauth2.googleapis.com/token";
const PROFILE = "https://gmail.googleapis.com/gmail/v1/users/me/profile";
describe("capture-only consent through authenticated Gmail commands", () => {
  let fixture: AuthFixture;
  let token: string;
  let mail: MailRoutingDeps;
  let acceptedState: string;
  const requests: string[] = [];
  let witnessEnabled = true;
  const witnessTransactions: (string | null)[] = [];
  let scopes = READONLY;
  let address: string;
  let profileWait: Promise<void> | undefined;
  let profileFailure = false;
  let tokenFailure: "known" | "unknown" | undefined;
  let begunAttemptId: string | undefined;
  let profileEntered: (() => void) | undefined;
  const runtime: CrmAcquisitionDiagnosticRuntime = {
    environmentId: randomUUID(),
    implementationCommit: "a".repeat(40),
    imageDigest: "sha256:" + "b".repeat(64),
    side: "api",
    schemaVersion: 90,
    consentIsolationBinding: {
      databaseInstanceArn: "arn:aws:rds:us-east-1:000000000000:db:controlled",
      databaseSecretArn:
        "arn:aws:secretsmanager:us-east-1:000000000000:secret:controlled",
      databaseEndpoint: "controlled.invalid",
      ecsClusterArn: "arn:aws:ecs:us-east-1:000000000000:cluster/controlled",
    },
    verifyIsolation: async (input) => {
      const state = await fixture.db.query<{ txid: string | null }>(
        "SELECT txid_current_if_assigned()::text AS txid",
      );
      witnessTransactions.push(state.rows[0]!.txid);
      return (
        witnessEnabled &&
        input.databaseName === fixture.database.name &&
        input.purpose === "oauth_bootstrap"
      );
    },
  };
  const fetch: HttpFetch = async (url) => {
    requests.push(url);
    if (url === TOKEN && tokenFailure === "unknown")
      throw new Error("private token exchange uncertainty");
    if (url === TOKEN && tokenFailure === "known")
      return {
        status: 400,
        headers: {},
        body: JSON.stringify({ error: "invalid_grant" }),
      };
    if (url === TOKEN)
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({
          access_token: "controlled-access",
          refresh_token: "controlled-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: scopes,
        }),
      };
    if (url === PROFILE) {
      profileEntered?.();
      await profileWait;
      if (profileFailure)
        throw new Error("private ambiguous profile transport");
      return {
        status: 200,
        headers: {},
        body: JSON.stringify({ emailAddress: address, historyId: "1234" }),
      };
    }
    throw new Error("unexpected external provider action");
  };
  const call = (
    path: string,
    body?: unknown,
    query: Record<string, string> = {},
    diagnostic: CrmAcquisitionDiagnosticRuntime | null = runtime,
  ) =>
    dispatch(
      {
        method:
          path === "/oauth/gmail/callback" || path === "/gmail/status"
            ? "GET"
            : "POST",
        path,
        body,
        query: new URLSearchParams(query),
        headers:
          path === "/oauth/gmail/callback"
            ? {}
            : { authorization: `Bearer ${token}` },
      },
      {
        session: fixture.db,
        auth: fixture.deps,
        mail,
        supportedClientVersions: fixture.deps.config.supportedClientVersions,
        sendingEnabled: false,
        ...(diagnostic ? { crmAcquisitionDiagnosticRuntime: diagnostic } : {}),
      },
    );
  const begin = async (extra: Record<string, unknown> = {}) => {
    const reply = await call("/gmail/connect", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      ...extra,
    });
    expect(reply.status).toBe(200);
    begunAttemptId = gmailConnectResultSchema.parse(
      (reply.body as { result: unknown }).result,
    ).attemptId;
    return new URL(
      gmailConnectResultSchema.parse((reply.body as { result: unknown }).result)
        .authorizationUrl,
    );
  };
  beforeAll(async () => {
    fixture = await createAuthFixture({ purpose: "acquisition_diagnostic" });
    token = (
      await issueSessionFor(fixture, fixture.alpha, fixture.alpha.salesperson)
    ).accessToken;
    address = fixture.alpha.salesperson.email;
    mail = {
      pushVerifier: { verify: async () => null },
      gmail: createGmailHttpClient({
        fetch,
        apiBaseUrl: "https://gmail.googleapis.com",
      }),
      config: {
        clientId: "isolated-client",
        redirectUri: "https://isolated.example/oauth/gmail/callback",
        authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenEndpoint: TOKEN,
        revocationEndpoint: "https://oauth2.googleapis.com/revoke",
        apiBaseUrl: "https://gmail.googleapis.com",
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
      cipher: localEnvelopeCipher("acquisition-consent-test"),
      stateSigningKey: randomBytes(48),
    };
  });
  afterAll(async () => fixture.stop());
  it("refuses absent or failed physical isolation before any OAuth action", async () => {
    const { consentIsolationBinding, ...missing } = runtime;
    void consentIsolationBinding;
    const body = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
    };
    expect(
      (await call("/gmail/connect", body, {}, missing)).body,
    ).toMatchObject({ status: "refused", reason: "grant_refused" });
    witnessEnabled = false;
    expect(
      (await call("/gmail/connect", { ...body, commandId: randomUUID() })).body,
    ).toMatchObject({ status: "refused", reason: "grant_refused" });
    witnessEnabled = true;
    expect(requests).toEqual([]);
  });
  it("refuses a failed callback witness before exchange/profile and records a body-free refusal", async () => {
    const state = (await begin()).searchParams.get("state")!;
    const attempt = begunAttemptId;
    witnessEnabled = false;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "unwitnessed",
        })
      ).status,
    ).toBe(409);
    witnessEnabled = true;
    expect(requests).toEqual([]);
    expect(
      gmailStatusSchema.parse((await call("/gmail/status")).body)
        .lastGrantRefusal,
    ).toMatchObject({ reason: "grant_refused", attemptId: attempt });
  });
  it("requests only read access for a fresh diagnostic mailbox without provider calls", async () => {
    const url = await begin();
    expect(url.searchParams.get("scope")).toBe(READONLY);
    expect(requests).toEqual([]);
    expect(witnessTransactions.every((txid) => txid === null)).toBe(true);
  });
  it("refuses diagnostic state in ordinary or another environment before token exchange", async () => {
    const state = (await begin()).searchParams.get("state")!;
    const before = requests.length;
    expect(
      (
        await call(
          "/oauth/gmail/callback",
          undefined,
          { state, code: "wrong-mode" },
          null,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await call(
          "/oauth/gmail/callback",
          undefined,
          { state, code: "wrong-env" },
          { ...runtime, environmentId: randomUUID() },
        )
      ).status,
    ).toBe(409);
    expect(requests.length).toBe(before);
  });
  it("refuses switch intent even before an isolated mailbox exists", async () => {
    const before = requests.length;
    const reply = await call("/gmail/connect", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      switchTo: `other@${fixture.hostedDomain}`,
    });
    expect(reply.body).toMatchObject({
      status: "refused",
      reason: "grant_refused",
    });
    expect(requests.length).toBe(before);
  });
  it("refuses a same-domain account different from the consenting owner", async () => {
    const state = (await begin()).searchParams.get("state")!;
    address = `other@${fixture.hostedDomain}`;
    const before = requests.length;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "wrong-account",
        })
      ).status,
    ).toBe(409);
    expect(requests.slice(before)).toEqual([TOKEN, PROFILE]);
    expect(
      gmailStatusSchema.parse((await call("/gmail/status")).body).connected,
    ).toBe(false);
    address = fixture.alpha.salesperson.email;
    requests.length = 0;
  });
  it("refuses ordinary or expired state and cannot select diagnostic mode from input", async () => {
    const plain = await call(
      "/gmail/connect",
      { commandId: randomUUID(), clientVersion: CURRENT_CLIENT_VERSION },
      {},
      null,
    );
    const ordinary = new URL(
      gmailConnectResultSchema.parse((plain.body as { result: unknown }).result)
        .authorizationUrl,
    );
    expect(ordinary.searchParams.get("scope")?.split(" ")).toEqual([
      READONLY,
      "https://www.googleapis.com/auth/gmail.send",
    ]);
    const before = requests.length;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state: ordinary.searchParams.get("state")!,
          code: "ordinary-state",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call("/gmail/connect", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
          acquisitionEnvironmentId: runtime.environmentId,
        })
      ).status,
    ).toBe(400);
    mail = { ...mail, now: () => new Date(Date.now() - 20 * 60 * 1000) };
    const expired = (await begin()).searchParams.get("state")!;
    mail = { ...mail, now: () => new Date() };
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state: expired,
          code: "expired",
        })
      ).status,
    ).toBe(400);
    expect(requests.length).toBe(before);
  });
  it("refuses a broader returned grant without acquiring a profile or token copy", async () => {
    const state = (await begin()).searchParams.get("state")!;
    scopes = READONLY + " https://www.googleapis.com/auth/gmail.send";
    const before = requests.length;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "broader-grant",
        })
      ).status,
    ).toBe(409);
    expect(requests.slice(before)).toEqual([TOKEN]);
    scopes = READONLY;
    requests.length = 0;
  });
  it("conserves an ambiguous callback profile once and refuses replay without external retry", async () => {
    const state = (await begin()).searchParams.get("state")!;
    const attempt = begunAttemptId;
    profileFailure = true;
    const before = requests.length;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "profile-ambiguous",
        })
      ).status,
    ).toBe(409);
    profileFailure = false;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "replay-profile",
        })
      ).status,
    ).toBe(409);
    expect(requests.slice(before)).toEqual([TOKEN, PROFILE]);
    const ledger = await fixture.db.query<{
      action: string;
      detail: { units: number };
    }>(
      `SELECT action,detail FROM audit_events WHERE workspace_id=$1 AND subject_id=$2 AND action LIKE 'mailbox.acquisition_oauth_profile_%' ORDER BY occurred_at,id`,
      [fixture.alpha.workspaceId, attempt],
    );
    expect(
      ledger.rows.map((row) => ({
        action: row.action,
        units: row.detail.units,
      })),
    ).toEqual([
      { action: "mailbox.acquisition_oauth_profile_reserved", units: 1 },
      { action: "mailbox.acquisition_oauth_profile_unknown", units: 1 },
    ]);
    expect(JSON.stringify(ledger.rows)).not.toContain("private ambiguous");
    requests.length = 0;
  });
  it("failed exchanges spend zero profile units and cannot retry the signed attempt", async () => {
    for (const failure of ["known", "unknown"] as const) {
      const state = (await begin()).searchParams.get("state")!;
      const attempt = begunAttemptId;
      tokenFailure = failure;
      const before = requests.length;
      expect(
        (
          await call("/oauth/gmail/callback", undefined, {
            state,
            code: "failed-exchange",
          })
        ).status,
      ).toBe(409);
      tokenFailure = undefined;
      expect(
        (
          await call("/oauth/gmail/callback", undefined, {
            state,
            code: "repeat-exchange",
          })
        ).status,
      ).toBe(409);
      expect(requests.slice(before)).toEqual([TOKEN]);
      expect(
        (
          await fixture.db.query(
            `SELECT action FROM audit_events WHERE workspace_id=$1 AND subject_id=$2 AND action LIKE 'mailbox.acquisition_oauth_profile_%'`,
            [fixture.alpha.workspaceId, attempt],
          )
        ).rows,
      ).toEqual([]);
    }
    requests.length = 0;
  });
  it("finishes fresh readonly consent without claiming coverage or staging ordinary acquisition", async () => {
    const state = (await begin()).searchParams.get("state")!;
    acceptedState = state;
    const reply = await call("/oauth/gmail/callback", undefined, {
      state,
      code: "controlled-code",
    });
    expect(reply.status).toBe(200);
    expect(requests).toEqual([TOKEN, PROFILE]);
    const status = gmailStatusSchema.parse((await call("/gmail/status")).body);
    expect(status.connected).toBe(true);
    expect(status.mailbox?.baseline).toBeNull();
    expect(status.mailbox?.coverageWatermarkAt).toBeNull();
    const observations = await fixture.db.query<{
      granted_scopes: string[];
      provider_account_id: string;
    }>(
      `SELECT granted_scopes,provider_account_id FROM mailbox_oauth_grant_observations WHERE workspace_id=$1 AND owner_user_id=$2`,
      [fixture.alpha.workspaceId, fixture.alpha.salesperson.userId],
    );
    expect(observations.rows).toEqual([
      { granted_scopes: [READONLY], provider_account_id: address },
    ]);
    expect(
      (
        await fixture.db.query(`SELECT kind FROM jobs WHERE workspace_id=$1`, [
          fixture.alpha.workspaceId,
        ])
      ).rows,
    ).toEqual([]);
    expect(
      (
        await fixture.db.query(
          `SELECT id FROM sending_domains WHERE workspace_id=$1`,
          [fixture.alpha.workspaceId],
        )
      ).rows,
    ).toEqual([]);
  });
  it("refuses same-account reuse before another consent or token exchange", async () => {
    const before = requests.length;
    const reply = await call("/gmail/connect", {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
    });
    expect(reply.body).toMatchObject({
      status: "refused",
      reason: "grant_refused",
    });
    expect(requests.length).toBe(before);
  });
  it("requires authenticated owner cleanup with a strict command payload", async () => {
    const mailboxId = gmailStatusSchema.parse(
      (await call("/gmail/status")).body,
    ).mailbox!.id;
    const payload = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      mailboxId,
      reason: "test",
    };
    const ownerToken = token;
    token = "";
    expect((await call("/gmail/acquisition/cleanup", payload)).status).toBe(
      401,
    );
    token = (await issueSessionFor(fixture, fixture.alpha, fixture.alpha.admin))
      .accessToken;
    expect(
      (await call("/gmail/acquisition/cleanup", payload)).body,
    ).toMatchObject({ status: "refused", reason: "mailbox_unknown" });
    token = ownerToken;
    expect(
      (await call("/gmail/acquisition/cleanup", { ...payload, extra: true }))
        .status,
    ).toBe(400);
    expect(
      gmailStatusSchema.parse((await call("/gmail/status")).body).connected,
    ).toBe(true);
  });
  it("refuses ordinary disconnect and performs idempotent local cleanup without provider effects", async () => {
    const status = gmailStatusSchema.parse((await call("/gmail/status")).body);
    const mailboxId = status.mailbox!.id;
    const body = {
      commandId: randomUUID(),
      clientVersion: CURRENT_CLIENT_VERSION,
      mailboxId,
      reason: "diagnostic_complete",
    };
    const before = requests.length;
    expect(
      (await call("/gmail/disconnect", { ...body, commandId: randomUUID() }))
        .body,
    ).toMatchObject({ status: "refused", reason: "grant_refused" });
    witnessEnabled = false;
    expect(
      (
        await call("/gmail/acquisition/cleanup", {
          ...body,
          commandId: randomUUID(),
        })
      ).body,
    ).toMatchObject({ status: "refused", reason: "grant_refused" });
    expect(
      gmailStatusSchema.parse((await call("/gmail/status")).body).connected,
    ).toBe(true);
    witnessEnabled = true;
    const cleaned = await call("/gmail/acquisition/cleanup", body);
    expect(cleaned.body).toMatchObject({
      status: "accepted",
      replayed: false,
      result: {
        mailboxId,
        tokenDeleted: true,
        localDisconnected: true,
        providerRevoked: false,
        trustedRevocationPending: true,
      },
    });
    expect((await call("/gmail/acquisition/cleanup", body)).body).toMatchObject(
      { status: "accepted", replayed: true },
    );
    expect(
      (
        await call("/gmail/acquisition/cleanup", {
          ...body,
          commandId: randomUUID(),
        })
      ).body,
    ).toMatchObject({ result: { tokenDeleted: false } });
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state: acceptedState,
          code: "stale-consent",
        })
      ).status,
    ).toBe(409);
    expect(requests.length).toBe(before);
    expect(
      gmailStatusSchema.parse((await call("/gmail/status")).body).connected,
    ).toBe(false);
    expect(
      (await fixture.db.query("SELECT mailbox_id FROM mailbox_tokens")).rows,
    ).toEqual([]);
    expect(
      (
        await call("/gmail/connect", {
          commandId: randomUUID(),
          clientVersion: CURRENT_CLIENT_VERSION,
        })
      ).body,
    ).toMatchObject({ status: "refused", reason: "grant_refused" });
    expect(
      (
        await call(
          "/gmail/acquisition/cleanup",
          { ...body, commandId: randomUUID() },
          {},
          null,
        )
      ).status,
    ).toBe(404);
  });
  it("a second callback cannot replace a mailbox connected during the first profile wait", async () => {
    token = (
      await issueSessionFor(fixture, fixture.beta, fixture.beta.salesperson)
    ).accessToken;
    address = fixture.beta.salesperson.email;
    const state = (await begin()).searchParams.get("state")!;
    const secondState = (await begin()).searchParams.get("state")!;
    let release!: () => void;
    profileWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      profileEntered = resolve;
    });
    const first = call("/oauth/gmail/callback", undefined, {
      state,
      code: "held-profile",
    });
    await entered;
    const beforeDuplicate = requests.length;
    expect(
      (
        await call("/oauth/gmail/callback", undefined, {
          state,
          code: "duplicate-attempt",
        })
      ).status,
    ).toBe(409);
    expect(requests.length).toBe(beforeDuplicate);
    profileWait = undefined;
    profileEntered = undefined;
    try {
      expect(
        (
          await call("/oauth/gmail/callback", undefined, {
            state: secondState,
            code: "other-code",
          })
        ).status,
      ).toBe(200);
    } finally {
      release();
    }
    expect((await first).status).toBe(409);
    const status = gmailStatusSchema.parse((await call("/gmail/status")).body);
    expect(status.connected).toBe(true);
    expect(status.mailbox?.baseline).toBeNull();
    expect(
      (
        await fixture.db.query(
          "SELECT generation FROM mailboxes WHERE workspace_id=$1",
          [fixture.beta.workspaceId],
        )
      ).rows,
    ).toEqual([{ generation: 1 }]);
    expect(
      (
        await fixture.db.query(
          "SELECT id FROM mailbox_oauth_grant_observations WHERE workspace_id=$1",
          [fixture.beta.workspaceId],
        )
      ).rows,
    ).toHaveLength(1);
  });
});
