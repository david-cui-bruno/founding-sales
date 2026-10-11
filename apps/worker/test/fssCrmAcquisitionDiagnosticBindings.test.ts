import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import {
  asSession,
  CLUSTER_URL_ENVIRONMENT_VARIABLE,
  TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,
} from "@fss/domain/db/testing/testDatabase.ts";
import {
  seedTwoWorkspaces,
  type TwoWorkspaces,
} from "@fss/domain/test/db/support/fixtures.ts";
import {applyMigrations} from "@fss/domain/db/migrationRunner.ts";
import { main } from "../src/tools/fss.ts";
let admin: pg.Client,
  client: pg.Client,
  seeded: TwoWorkspaces,
  url: string,
  mailbox: string,
  observation: string;
const name = `fss_diagnostic_bindings_${randomUUID().replaceAll("-", "")}`;
const readonly = "https://www.googleapis.com/auth/gmail.readonly";
beforeAll(async () => {
  admin = new pg.Client({
    connectionString: process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!,
  });
  await admin.connect();
  await admin.query(
    `CREATE DATABASE "${name}"`,
  );
  const value = new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);
  value.pathname = `/${name}`;
  url = value.toString();
  client = new pg.Client({ connectionString: url });
  await client.connect();
  await applyMigrations(asSession({query:(text,values)=>client.query(text,values),connect:async()=>{},end:async()=>{}}),{throughVersion:90});
  seeded = await seedTwoWorkspaces(
    asSession({
      query: (text, values) => client.query(text, values),
      connect: async () => {
        await client.connect();
      },
      end: () => client.end(),
    }),
  );
  mailbox = (
    await client.query<{ id: string }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,last_sync_error) VALUES($1,$2,'diagnostic@example.test','diagnostic@example.test','connected','private-error-not-for-output') RETURNING id",
      [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
    )
  ).rows[0]!.id;
  observation = (
    await client.query<{ id: string }>(
      "INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'diagnostic@example.test',1,$4) RETURNING id",
      [
        seeded.alpha.workspaceId,
        mailbox,
        seeded.alpha.admin.userId,
        [readonly],
      ],
    )
  ).rows[0]!.id;
});
afterAll(async () => {
  await client?.end();
  await admin?.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  await admin?.end();
});
async function run(
  overrides: Record<string, string> = {},
  options: Record<string, string> = {},
) {
  const output: string[] = [],
    errors: string[] = [];
  const out = vi.spyOn(process.stdout, "write").mockImplementation((value) => {
    output.push(String(value));
    return true;
  });
  const err = vi.spyOn(process.stderr, "write").mockImplementation((value) => {
    errors.push(String(value));
    return true;
  });
  try {
    return {
      code: await main(
        [
          "admin",
          "crm-acquisition-diagnostic",
          "bindings",
          "--workspace",
          options["workspace"] ?? seeded.alpha.workspaceId,
          "--mailbox",
          options["mailbox"] ?? mailbox,
          "--owner",
          options["owner"] ?? seeded.alpha.admin.userId,
        ],
        {
          FSS_MIGRATION_DATABASE_URL: url,
          FSS_ENVIRONMENT: "rehearsal",
          ...overrides,
        },
      ),
      stdout: output.join(""),
      stderr: errors.join(""),
    };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}
it("exports actual connected owner and readonly observation for isolated review without private contents or authority", async () => {
  const result = await run();
  expect(result.code, result.stdout + result.stderr).toBe(0);
  const value = JSON.parse(result.stdout);
  expect(value).toMatchObject({
    workspaceId: seeded.alpha.workspaceId,
    mailboxId: mailbox,
    ownerUserId: seeded.alpha.admin.userId,
    providerAccountId: "diagnostic@example.test",
    generation: 1,
    oauthGrantObservationId: observation,
    databaseName: name,
    schemaVersion: 90,
    readOnly: true,
    productionActivationAllowed: false,
  });
  expect(value.accountBinding).toMatch(/^[a-f0-9]{64}$/u);
  expect(Object.keys(value).sort()).toEqual(
    [
      "accountBinding",
      "databaseName",
      "disclosureSha256",
      "disclosureVersion",
      "generation",
      "mailboxId",
      "oauthGrantObservationId",
      "ownerUserId",
      "productionActivationAllowed",
      "providerAccountId",
      "readOnly",
      "schemaVersion",
      "workspaceId",
    ].sort(),
  );
  expect(result.stdout + result.stderr).not.toContain(
    "private-error-not-for-output",
  );
});
it("refuses application credentials even when presented in the migration slot", async () => {
  const runtime = new URL(url);
  runtime.searchParams.set("options", "-c role=app_runtime");
  const result = await run({ FSS_MIGRATION_DATABASE_URL: runtime.toString() });
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "trusted_operations_required",
  );
});
it("refuses production, missing migration credentials and a non-isolated actual database", async () => {
  expect((await run({ FSS_ENVIRONMENT: "production" })).code).toBe(20);
  expect(
    (await run({ FSS_MIGRATION_DATABASE_URL: "", DATABASE_URL: url })).code,
  ).toBe(20);
  const other = new URL(url);
  other.pathname = new URL(
    process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!,
  ).pathname;
  const result = await run({ FSS_MIGRATION_DATABASE_URL: other.toString() });
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "diagnostic_bindings_environment_mismatch",
  );
});
it("refuses malformed, wrong-workspace, wrong-owner and absent mailbox selections", async () => {
  for (const options of [
    { workspace: "not-a-uuid" },
    { workspace: seeded.beta.workspaceId },
    { owner: seeded.beta.admin.userId },
    { mailbox: randomUUID() },
  ])
    expect((await run({}, options)).code).toBe(20);
});
it("requires current-generation readonly consent and never falls back to an older narrower observation", async () => {
  await client.query(
    "UPDATE mailboxes SET generation=2 WHERE workspace_id=$1 AND id=$2",
    [seeded.alpha.workspaceId, mailbox],
  );
  let result = await run();
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "diagnostic_bindings_consent_unavailable",
  );
  await client.query(
    "INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'diagnostic@example.test',2,$4)",
    [seeded.alpha.workspaceId, mailbox, seeded.alpha.admin.userId, [readonly]],
  );
  expect((await run()).code).toBe(0);
  await client.query(
    "INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'diagnostic@example.test',2,$4)",
    [
      seeded.alpha.workspaceId,
      mailbox,
      seeded.alpha.admin.userId,
      [readonly, "https://www.googleapis.com/auth/gmail.send"],
    ],
  );
  result = await run();
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "diagnostic_bindings_consent_unavailable",
  );
  expect(result.stdout + result.stderr).not.toContain("gmail.send");
});
it("refuses disconnected mailboxes instead of exporting a previously valid consent binding", async () => {
  await client.query(
    "UPDATE mailboxes SET status='disconnected',disconnected_at=clock_timestamp(),disconnect_reason='controlled test' WHERE workspace_id=$1 AND id=$2",
    [seeded.alpha.workspaceId, mailbox],
  );
  const result = await run();
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "diagnostic_bindings_mailbox_unavailable",
  );
});
it("refuses an inactive owner without exporting existing mailbox identifiers", async () => {
  await client.query(
    "INSERT INTO workspace_memberships(workspace_id,user_id,role,status) VALUES($1,$2,'admin','active')",
    [seeded.alpha.workspaceId, seeded.beta.admin.userId],
  );
  await client.query(
    "UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",
    [seeded.alpha.workspaceId, seeded.alpha.admin.userId],
  );
  const result = await run();
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe(
    "diagnostic_bindings_owner_unavailable",
  );
  expect(result.stdout).toBe("");
});
it("requires inherited migration authority rather than mere role membership", async () => {
  const role = `diagnostic_noinherit_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE ROLE "${role}" NOINHERIT`);
  await admin.query(`GRANT migration TO "${role}"`);
  try {
    const connection = new URL(url);
    connection.searchParams.set("options", `-c role=${role}`);
    const result = await run({
      FSS_MIGRATION_DATABASE_URL: connection.toString(),
    });
    expect(result.code).toBe(20);
    expect(JSON.parse(result.stderr.trim()).reason).toBe(
      "trusted_operations_required",
    );
  } finally {
    await admin.query(`DROP ROLE "${role}"`);
  }
});

it("refuses the current schema rather than silently widening the historical schema90 diagnostic",async()=>{
 const currentName=`${name}_current`;
 await admin.query(`CREATE DATABASE "${currentName}" TEMPLATE "${process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE]!}"`);
 try{
  const current=new URL(url);current.pathname=`/${currentName}`;
  const currentClient=new pg.Client({connectionString:current.toString()});await currentClient.connect();
  try{expect((await currentClient.query<{version:number}>('SELECT max(version) AS version FROM schema_versions')).rows[0]?.version).toBe(96);}finally{await currentClient.end();}
  const result=await run({FSS_MIGRATION_DATABASE_URL:current.toString()});
  expect(result.code).toBe(20);
  expect(JSON.parse(result.stderr.trim()).reason).toBe('diagnostic_bindings_environment_mismatch');
  expect(result.stdout).toBe('');
 }finally{await admin.query(`DROP DATABASE IF EXISTS "${currentName}" WITH (FORCE)`);}
});
