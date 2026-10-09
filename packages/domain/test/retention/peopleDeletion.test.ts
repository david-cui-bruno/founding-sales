import { afterAll, beforeAll, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '../../db/testing/testDatabase.ts';
import { repositoryContext, workspaceScope } from '../../db/workspaceScope.ts';
import { createPerson, addSelectedSource, readPerson } from '../../crm/people.ts';
import { previewDeletion, commitDeletion, REDACTED_NAME } from '../../retention/deletion.ts';
import { recordingSuppressionJournal } from '../../suppression/journal.ts';
import { seedTwoWorkspaces, type TwoWorkspaces } from '../db/support/fixtures.ts';
import { seedCrm, type SeededCrm } from '../db/support/crmFixtures.ts';

let database: TestDatabase;
let members: TwoWorkspaces;
let crm: SeededCrm;
beforeAll(async () => {
  database = await createTestDatabase();
  members = await seedTwoWorkspaces(database.session);
  crm = await seedCrm(database.session, members);
});
afterAll(async () => { await database.drop(); });

it('deleting an operational contact also removes its bridged copied source without deleting unrelated person history', async () => {
  const context = repositoryContext(workspaceScope(members.alpha.workspaceId, {
    kind: 'user', userId: members.alpha.admin.userId, role: 'admin',
  }), database.session);
  // A legacy bridge fixture; the observable assertions use public CRM/deletion reads.
  await database.session.query(
    'INSERT INTO crm_people(workspace_id,id,owner_user_id,full_name) VALUES($1,$2,$3,$4)',
    [members.alpha.workspaceId, crm.alpha.contactId, members.alpha.admin.userId, 'Legacy Correspondent'],
  );
  await database.session.query(
    'INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$2)',
    [members.alpha.workspaceId, crm.alpha.contactId],
  );
  const unrelated = await createPerson(context, 'Unrelated Correspondent');
  if (!unrelated.ok || unrelated.value.personId === undefined) throw new Error('person fixture failed');
  await addSelectedSource(context, {
    personId: crm.alpha.contactId, sourceKey: 'legacy-source', excerpt: 'Private legacy conversation',
    occurredAt: '2026-10-01T14:00:00.000Z',
  });
  await addSelectedSource(context, {
    personId: unrelated.value.personId, sourceKey: 'other-source', excerpt: 'Unrelated history remains',
    occurredAt: '2026-10-02T14:00:00.000Z',
  });
  const preview = await previewDeletion(context, {
    targetKind: 'contact', firmId: crm.alpha.firmId, contactId: crm.alpha.contactId,
  });
  if (!preview.ok || preview.value === undefined) throw new Error('deletion preview failed');
  const deleted = await commitDeletion(context, {
    requestId: preview.value.requestId, previewHash: preview.value.previewHash,
    commandId: 'delete-legacy-person-copy', journal: recordingSuppressionJournal(),
  });
  expect(deleted.ok).toBe(true);
  const legacy = await readPerson(context, crm.alpha.contactId);
  expect(legacy?.person.fullName).toBe(REDACTED_NAME);
  expect(legacy?.sources).toEqual([expect.objectContaining({ availability: 'deleted', excerpt: null, contentHash: null })]);
  expect((await readPerson(context, unrelated.value.personId))?.sources[0]?.excerpt).toBe('Unrelated history remains');
});
