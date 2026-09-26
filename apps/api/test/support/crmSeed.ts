import { createContact, type CreateContactInput } from '@fss/domain/crm/contacts.ts';
import { createFirm, type CreateFirmInput } from '@fss/domain/crm/firms.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import type { AuthFixture, SeededWorkspace } from './authFixture.ts';

/**
 * A firm or a contact for a route test, written by the domain as the workspace's admin.
 *
 * `/firms/create` and `/contacts/create` had no caller outside the tests and went in
 * wave 2 (S6); the Mac adds a firm through `/crm/firms/add` or an import. The tests
 * that only needed a firm to exist now get one here, with the same domain rules
 * (`createFirm`, `createContact`) the routes ran.
 */
function adminContext(fixture: AuthFixture, workspace: SeededWorkspace) {
  return repositoryContext(
    workspaceScope(workspace.workspaceId, { kind: 'user', userId: workspace.admin.userId, role: 'admin' }),
    fixture.db,
  );
}

export async function seedFirm(
  fixture: AuthFixture,
  input: CreateFirmInput,
  workspace: SeededWorkspace = fixture.alpha,
): Promise<string> {
  const created = await createFirm(adminContext(fixture, workspace), input);
  if (!created.ok) throw new Error(`seedFirm refused: ${created.reason}`);
  return created.value.id;
}

export async function seedContact(
  fixture: AuthFixture,
  input: CreateContactInput,
  workspace: SeededWorkspace = fixture.alpha,
): Promise<string> {
  const created = await createContact(adminContext(fixture, workspace), input);
  if (!created.ok) throw new Error(`seedContact refused: ${created.reason}`);
  return created.value.id;
}
