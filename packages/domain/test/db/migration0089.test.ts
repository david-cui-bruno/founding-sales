import { expect, it } from "vitest";
import { createTestDatabase } from "../../db/testing/testDatabase.ts";
import {
  applyMigrations,
  readAppliedSchemaVersion,
} from "../../db/migrationRunner.ts";
import { seedTwoWorkspaces } from "./support/fixtures.ts";
import { seedCrm } from "./support/crmFixtures.ts";
import { seedMail } from "./support/mailFixtures.ts";
import { seedMailCaptureCatalogFixture } from "./support/mailCaptureCases.ts";

it("upgrades actual schema88 without changing ordinary copies, controls, identities or authority", async () => {
  const db = await createTestDatabase({ throughVersion: 88 });
  try {
    const seeded = await seedTwoWorkspaces(db.session),
      crm = await seedCrm(db.session, seeded),
      mail = await seedMail(db.session, seeded, crm);
    await seedMailCaptureCatalogFixture({
      session: db.session,
      seeded,
      crm,
      mail,
    });
    const snapshot = async () => ({
      sources: (
        await db.session.query(
          "SELECT to_jsonb(s)-'diagnostic_authorization_id' AS row FROM crm_mail_sources s ORDER BY source_id",
        )
      ).rows,
      controls: (
        await db.session.query(
          "SELECT to_jsonb(c) AS row FROM crm_mail_capture_controls c ORDER BY mailbox_id",
        )
      ).rows,
      identities: (
        await db.session.query(
          "SELECT to_jsonb(i) AS row FROM crm_mail_capture_identities i ORDER BY id",
        )
      ).rows,
      oauth: (
        await db.session.query("SELECT * FROM mailbox_oauth_grant_observations")
      ).rows,
      authority: (
        await db.session.query(
          "SELECT * FROM crm_capability_authority_receipts",
        )
      ).rows,
    });
    const before = await snapshot();
    await applyMigrations(db.session, { throughVersion: 89 });
    expect(await readAppliedSchemaVersion(db.session)).toBe(89);
    expect(await snapshot()).toEqual(before);
    expect(
      (
        await db.session.query(
          "SELECT diagnostic_authorization_id FROM crm_mail_sources",
        )
      ).rows,
    ).toEqual([{ diagnostic_authorization_id: null }]);
    expect(
      (
        await db.session.query(
          "SELECT * FROM crm_acquisition_diagnostic_authorizations",
        )
      ).rows,
    ).toEqual([]);
    expect(
      (await db.session.query("SELECT * FROM crm_acquisition_diagnostic_reads"))
        .rows,
    ).toEqual([]);
    const runtime = await db.appRuntimeSession();
    expect(
      (
        await runtime.query(
          "SELECT has_table_privilege(current_user,'crm_acquisition_diagnostic_authorizations','INSERT') AS insert,has_table_privilege(current_user,'crm_acquisition_diagnostic_authorizations','UPDATE') AS update,has_table_privilege(current_user,'crm_acquisition_diagnostic_authorizations','SELECT') AS read",
        )
      ).rows[0],
    ).toEqual({ insert: false, update: false, read: true });
  } finally {
    await db.drop();
  }
});
