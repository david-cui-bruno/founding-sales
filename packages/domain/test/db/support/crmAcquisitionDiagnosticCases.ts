import { randomUUID } from "node:crypto";
import type { SessionQueryable } from "../../../db/queryable.ts";
import type { TwoWorkspaces } from "./fixtures.ts";
import type { SeededMail } from "./mailFixtures.ts";
import type { SeededCrm } from "./crmFixtures.ts";
import { seedMailCaptureCatalogFixture } from "./mailCaptureCases.ts";
interface Fixture {
  session: SessionQueryable;
  seeded: TwoWorkspaces;
  mail: SeededMail;
  crm: SeededCrm;
}
interface Case {
  constraint: string;
  run(f: Fixture): Promise<unknown>;
}
type Row = Record<string, unknown>;
const absent = "00000000-0000-4000-8000-000000009999",
  table = "crm_acquisition_diagnostic_authorizations";
const insert = (f: Fixture, target: string, row: Row) =>
  f.session.query(
    `INSERT INTO ${target}(${Object.keys(row).join(",")}) VALUES(${Object.keys(
      row,
    )
      .map((_, i) => `$${i + 1}`)
      .join(",")})`,
    Object.values(row),
  );
function grant(f: Fixture): Row {
  const id = randomUUID(),
    workspace_id = f.seeded.alpha.workspaceId,
    owner_user_id = f.seeded.alpha.admin.userId,
    mailbox_id = f.mail.alpha.mailboxId;
  return {
    workspace_id,
    id,
    owner_user_id,
    mailbox_id,
    authorization_sha256: "a".repeat(64),
    authorization_document: JSON.stringify({
      id,
      purpose: "acquisition_acceptance",
      workspaceId: workspace_id,
      ownerUserId: owner_user_id,
      mailboxId: mailbox_id,
    }),
    verified_at: "2026-10-01",
    valid_until: "2026-11-01",
  };
}
function patched(row: Row, patch: Row) {
  const doc = JSON.parse(String(row["authorization_document"]));
  if ("workspace_id" in patch) doc.workspaceId = patch["workspace_id"];
  if ("mailbox_id" in patch) doc.mailboxId = patch["mailbox_id"];
  if ("owner_user_id" in patch) doc.ownerUserId = patch["owner_user_id"];
  return { ...row, authorization_document: JSON.stringify(doc), ...patch };
}
export const CRM_ACQUISITION_DIAGNOSTIC_CONSTRAINT_CASES: Case[] = [];
for (const [constraint, patch] of Object.entries({
  crm_diagnostic_hash: { authorization_sha256: "bad" },
  crm_diagnostic_document: { authorization_document: "{}" },
  crm_diagnostic_dates: { valid_until: "2026-09-01" },
  crm_diagnostic_revocation_reference: {
    revoked_at: "2026-10-02",
    revocation_reference: "",
  },
  crm_diagnostic_revocation_pair: { revoked_at: "2026-10-02" },
  crm_diagnostic_mailbox_fk: { mailbox_id: absent },
  crm_diagnostic_owner_fk: { owner_user_id: absent },
}))
  CRM_ACQUISITION_DIAGNOSTIC_CONSTRAINT_CASES.push({
    constraint,
    run: (f) => insert(f, table, patched(grant(f), patch)),
  });
CRM_ACQUISITION_DIAGNOSTIC_CONSTRAINT_CASES.push({
  constraint: "crm_diagnostic_authorization_pk",
  run: async (f) => {
    const row = grant(f);
    await insert(f, table, row);
    return insert(f, table, row);
  },
});
for (const [constraint, patch] of Object.entries({
  crm_diagnostic_message: { message_id: "bad id" },
  crm_diagnostic_operation: { operation: "send" },
  crm_diagnostic_transport: { transport: "invented" },
  crm_diagnostic_state: { state: "sent" },
  crm_diagnostic_units: { units: 0 },
  crm_diagnostic_operation_units: { units: 1 },
  crm_diagnostic_read_authorization_fk: { authorization_id: absent },
}))
  CRM_ACQUISITION_DIAGNOSTIC_CONSTRAINT_CASES.push({
    constraint,
    run: async (f) => {
      const a = grant(f);
      await insert(f, table, a);
      return insert(f, "crm_acquisition_diagnostic_reads", {
        workspace_id: a["workspace_id"],
        authorization_id: a["id"],
        message_id: "message",
        operation: "body",
        transport: "controlled",
        state: "calling",
        units: 5,
        ...patch,
      });
    },
  });
CRM_ACQUISITION_DIAGNOSTIC_CONSTRAINT_CASES.push(
  {
    constraint: "crm_diagnostic_read_pk",
    run: async (f) => {
      const a = grant(f);
      await insert(f, table, a);
      const row = {
        workspace_id: a["workspace_id"],
        authorization_id: a["id"],
        message_id: "message",
        operation: "body",
        transport: "controlled",
        state: "calling",
        units: 5,
      };
      await insert(f, "crm_acquisition_diagnostic_reads", row);
      return insert(f, "crm_acquisition_diagnostic_reads", row);
    },
  },
  {
    constraint: "crm_mail_source_context_authority",
    run: async (f) => {
      await seedMailCaptureCatalogFixture(f);
      return f.session.query(
        "UPDATE crm_mail_sources SET conversation_id=NULL",
      );
    },
  },
  {
    constraint: "crm_mail_source_diagnostic_fk",
    run: async (f) => {
      await seedMailCaptureCatalogFixture(f);
      return f.session.query(
        "UPDATE crm_mail_sources SET conversation_id=NULL,diagnostic_authorization_id=$1",
        [absent],
      );
    },
  },
);
