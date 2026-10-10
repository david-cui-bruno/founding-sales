import { expect, it } from "vitest";
import { createTestDatabase } from "../../db/testing/testDatabase.ts";
import { seedTwoWorkspaces } from "./support/fixtures.ts";
import { repositoryContext, workspaceScope } from "../../db/workspaceScope.ts";
import { requestCrmAcquisitionDiagnostic } from "../../mail/crmAcquisitionDiagnostic.ts";
it("refuses diagnostic acquisition without an isolated runtime and changes no ordinary controls or jobs", async () => {
  const db = await createTestDatabase();
  try {
    const seeded = await seedTwoWorkspaces(db.session);
    const runtime = await db.appRuntimeSession();
    const context = repositoryContext(
      workspaceScope(seeded.alpha.workspaceId, {
        kind: "user",
        userId: seeded.alpha.admin.userId,
        role: "admin",
      }),
      runtime,
    );
    expect(
      await requestCrmAcquisitionDiagnostic(context, {
        authorizationId: "00000000-0000-4000-8000-000000000001",
        expectedAuthorizationSha256: "a".repeat(64),
      }),
    ).toEqual({ ok: false, reason: "diagnostic_unavailable" });
    expect(
      (await db.session.query("SELECT count(*)::int AS n FROM jobs")).rows[0],
    ).toEqual({ n: 0 });
  } finally {
    await db.drop();
  }
});
