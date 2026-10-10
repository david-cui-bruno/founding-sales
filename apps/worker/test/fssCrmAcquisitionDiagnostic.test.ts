import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  createTestDatabase,
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  type TestDatabase,
} from "@fss/domain/db/testing/testDatabase.ts";
import {
  seedTwoWorkspaces,
  type TwoWorkspaces,
} from "@fss/domain/test/db/support/fixtures.ts";
import type { CrmAcquisitionDiagnosticAuthorization } from "@fss/contracts";
import { crmAcquisitionDiagnosticFingerprint } from "@fss/domain/mail/crmAcquisitionDiagnostic.ts";
import { CRM_MAIL_CAPTURE_DISCLOSURE } from "@fss/domain/crm/capabilityAuthority.ts";
import { main } from "../src/tools/fss.ts";
import {
  crmAcquisitionDiagnosticProvisionCommand,
  crmAcquisitionDiagnosticRevokeCommand,
} from "../src/tools/fss/crmAcquisitionDiagnostic.ts";
import { readToolConfig } from "../src/tools/fss/config.ts";
let db: TestDatabase, seeded: TwoWorkspaces, url: string, mailboxId: string;
beforeAll(async () => {
  db = await createTestDatabase();
  seeded = await seedTwoWorkspaces(db.session);
  const value = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);
  value.pathname = `/${db.name}`;
  url = value.toString();
  mailboxId = (
    await db.session.query<{ id: string }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'diagnostic@example.test','diagnostic@example.test','connected') RETURNING id",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    )
  ).rows[0]!.id;
});
afterAll(async () => db.drop());
function grant(): CrmAcquisitionDiagnosticAuthorization {
  return {
    id: randomUUID(),
    purpose: "acquisition_acceptance",
    workspaceId: seeded.alpha.workspaceId,
    mailboxId,
    ownerUserId: seeded.alpha.admin.userId,
    providerAccountId: "diagnostic@example.test",
    accountBinding: "a".repeat(64),
    generation: 1,
    oauthGrantObservationId: randomUUID(),
    environmentId: randomUUID(),
    databaseName: db.name,
    databaseInstanceArn: "controlled-rds",
    databaseSecretArn: "controlled-secret",
    databaseEndpoint: "controlled.example.test",
    ecsClusterArn: "controlled-cluster",
    deploymentIdentity: "controlled-api",
    workerDeploymentIdentity: "controlled-worker",
    implementationCommit: "c".repeat(40),
    apiImageDigest: "sha256:" + "a".repeat(64),
    workerImageDigest: "sha256:" + "b".repeat(64),
    schemaVersion: 89,
    releaseReference: "controlled release",
    disclosureVersion: CRM_MAIL_CAPTURE_DISCLOSURE.version,
    disclosureSha256: CRM_MAIL_CAPTURE_DISCLOSURE.sha256,
    consentReference: "controlled owner consent",
    providerPolicyReference: "controlled policy",
    reviewedBy: seeded.alpha.admin.userId,
    reviewReference: "controlled independent scope review",
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    validUntil: new Date(Date.now() + 3600000).toISOString(),
    maxReads: 4,
    maxUnits: 12,
    metadataUnits: 5,
    bodyUnits: 5,
    messages: [
      {
        messageId: "controlled-message",
        threadId: "controlled-thread",
        origin: "received",
        fromAt: "2026-01-01T00:00:00Z",
        toAt: "2027-01-01T00:00:00Z",
      },
    ],
  };
}
const encode = (
  g: CrmAcquisitionDiagnosticAuthorization,
  hash = crmAcquisitionDiagnosticFingerprint(g),
) => [
  "admin",
  "crm-acquisition-diagnostic",
  "provision",
  "--json-base64",
  Buffer.from(JSON.stringify(g)).toString("base64"),
  "--sha256",
  hash,
];
async function run(args: string[], migration = true) {
  const output: string[] = [],
    errors: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
      output.push(String(value));
      return true;
    }),
    err = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
      errors.push(String(value));
      return true;
    });
  try {
    return {
      code: await main(
        args,
        migration ? { FSS_MIGRATION_DATABASE_URL: url } : { DATABASE_URL: url },
      ),
      stdout: output.join(""),
      stderr: errors.join(""),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
it("trusted provision is review-hashed, idempotent and never enables controls or queues reads", async () => {
  const g = grant();
  const result = await run(encode(g));
  expect(result.code, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    authorizationId: g.id,
    sha256: crmAcquisitionDiagnosticFingerprint(g),
  });
  expect((await run(encode(g))).code).toBe(0);
  expect(
    (await run(encode({ ...g, reviewReference: "different reviewed scope" })))
      .code,
  ).toBe(20);
  expect((await db.session.query("SELECT id FROM jobs")).rows).toEqual([]);
  expect(
    (await db.session.query("SELECT * FROM crm_mail_capture_controls")).rows,
  ).toEqual([]);
  expect(
    (await db.session.query("SELECT * FROM crm_capability_authority_receipts"))
      .rows,
  ).toEqual([]);
});
it("refuses missing trusted credentials, digest drift and copied bodies without exposing content", async () => {
  const g = grant();
  expect((await run(encode(g), false)).code).toBe(20);
  expect((await run(encode(g, "b".repeat(64)))).code).toBe(20);
  const secret = "private original must never enter a grant";
  const malformed = Buffer.from(
    JSON.stringify({ ...g, body: secret }),
  ).toString("base64");
  const denied = await run([
    "admin",
    "crm-acquisition-diagnostic",
    "provision",
    "--json-base64",
    malformed,
    "--sha256",
    crmAcquisitionDiagnosticFingerprint(g),
  ]);
  expect(denied.code).toBe(20);
  expect(denied.stdout + denied.stderr).not.toContain(secret);
  expect(
    (
      await db.session.query(
        "SELECT id FROM crm_acquisition_diagnostic_authorizations WHERE id=$1",
        [g.id],
      )
    ).rows,
  ).toEqual([]);
});
it("application role cannot provision/revoke and trusted revocation cannot replace the grant", async () => {
  const g = grant(),
    session = await db.appRuntimeSession(),
    base = {
      session,
      config: readToolConfig({ DATABASE_URL: url }),
      environment: {},
      switches: new Set<string>(),
    };
  expect(
    await crmAcquisitionDiagnosticProvisionCommand({
      ...base,
      options: {
        "--json-base64": Buffer.from(JSON.stringify(g)).toString("base64"),
        "--sha256": crmAcquisitionDiagnosticFingerprint(g),
      },
    }),
  ).toMatchObject({ ok: false, reason: "trusted_operations_required" });
  expect((await run(encode(g))).code).toBe(0);
  expect(
    await crmAcquisitionDiagnosticRevokeCommand({
      ...base,
      options: {
        "--workspace": g.workspaceId,
        "--authorization": g.id,
        "--reference": "unauthorized",
      },
    }),
  ).toMatchObject({ ok: false, reason: "trusted_operations_required" });
  const args = [
    "admin",
    "crm-acquisition-diagnostic",
    "revoke",
    "--workspace",
    g.workspaceId,
    "--authorization",
    g.id,
    "--reference",
    "controlled revoked",
  ];
  expect((await run(args)).code).toBe(0);
  expect((await run(args)).code).toBe(0);
  expect(
    (
      await db.session.query<{
        authorization_document: unknown;
        revocation_reference: string;
      }>(
        "SELECT authorization_document,revocation_reference FROM crm_acquisition_diagnostic_authorizations WHERE id=$1",
        [g.id],
      )
    ).rows[0],
  ).toEqual({
    authorization_document: g,
    revocation_reference: "controlled revoked",
  });
});
it("once-only read ledger conserves unknown dispatches and cannot rewrite observed accounting", async () => {
  const g = grant();
  expect((await run(encode(g))).code).toBe(0);
  const runtime = await db.appRuntimeSession();
  await runtime.query(
    "INSERT INTO crm_acquisition_diagnostic_reads(workspace_id,authorization_id,message_id,operation,transport,state,units) VALUES($1,$2,'controlled-message','body','controlled','calling',5)",
    [g.workspaceId, g.id],
  );
  await runtime.query(
    "UPDATE crm_acquisition_diagnostic_reads SET state='unknown' WHERE authorization_id=$1",
    [g.id],
  );
  await expect(
    runtime.query(
      "UPDATE crm_acquisition_diagnostic_reads SET state='observed' WHERE authorization_id=$1",
      [g.id],
    ),
  ).rejects.toMatchObject({ code: "P0001" });
  await expect(
    runtime.query(
      "DELETE FROM crm_acquisition_diagnostic_reads WHERE authorization_id=$1",
      [g.id],
    ),
  ).rejects.toMatchObject({ code: "42501" });
  expect(
    (
      await runtime.query(
        "SELECT state,units FROM crm_acquisition_diagnostic_reads WHERE authorization_id=$1",
        [g.id],
      )
    ).rows,
  ).toEqual([{ state: "unknown", units: 5 }]);
});
