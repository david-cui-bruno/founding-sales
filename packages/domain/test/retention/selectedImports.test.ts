import { beforeAll, afterAll, expect, it } from "vitest";
import {
  createTestDatabase,
  type TestDatabase,
} from "../../db/testing/testDatabase.ts";
import { repositoryContext, workspaceScope } from "../../db/workspaceScope.ts";
import {
  seedTwoWorkspaces,
  type TwoWorkspaces,
} from "../db/support/fixtures.ts";
import { seedCrm, type SeededCrm } from "../db/support/crmFixtures.ts";
import {
  previewSelectedImport,
  commitSelectedImport,
  readSelectedImports,
} from "../../crm/selectedImports.ts";
import { previewDeletion, commitDeletion } from "../../retention/deletion.ts";
import { recordingSuppressionJournal } from "../../suppression/journal.ts";
let database: TestDatabase;
let members: TwoWorkspaces;
let crm: SeededCrm;
beforeAll(async () => {
  database = await createTestDatabase();
  members = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, members);
});
afterAll(async () => database.drop());
it("previews and receipts the exact imported-metadata redaction with firm deletion", async () => {
  const context = repositoryContext(
    workspaceScope(members.alpha.workspaceId, {
      kind: "user",
      userId: members.alpha.admin.userId,
      role: "admin",
    }),
    database.session,
  );
  const selection = {
    text: "Sensitive selected quotation",
    subtype: "pasted_text" as const,
    label: "Sensitive transcript label",
    direction: "draft" as const,
    participants: [
      {
        label: "Sensitive speaker",
        endpoint: null,
        provenance: "user_supplied" as const,
      },
    ],
    occurredAt: null,
    attachments: [{ name: "Sensitive attachment", url: null }],
  };
  const preview = await previewSelectedImport(context, selection);
  if (preview === null) throw new Error("preview fixture");
  const imported = await commitSelectedImport(context, {
    ...selection,
    personId: null,
    firmId: crm.alpha.firmId,
    importKey: "retention-import",
    previewHash: preview.previewHash,
    parserVersion: "selected-v1",
    commandId: "retention-import",
    clientVersion: "1.0.13",
  });
  expect(imported.ok).toBe(true);
  const deletion = await previewDeletion(context, {
    targetKind: "firm",
    firmId: crm.alpha.firmId,
  });
  if (!deletion.ok || deletion.value === undefined)
    throw new Error("deletion fixture");
  expect(deletion.value.redacts["crm_selected_imports"]).toBe(1);
  const result = await commitDeletion(context, {
    requestId: deletion.value.requestId,
    previewHash: deletion.value.previewHash,
    commandId: "delete-import",
    journal: recordingSuppressionJournal(),
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("deletion failed");
  expect(result.value?.redacted["crm_selected_imports"]).toBe(1);
  const page = await readSelectedImports(context, {
    personId: null,
    firmId: crm.alpha.firmId,
    limit: 50,
  });
  expect(JSON.stringify(page)).not.toContain("Sensitive");
  expect(page).toMatchObject({
    imports: [
      {
        source: { availability: "deleted", excerpt: null },
        metadata: { label: null, participants: null, attachments: null },
      },
    ],
  });
});
