import { createContact, type CreateContactInput } from '@fss/domain/crm/contacts.ts';
import { createFirm, type CreateFirmInput } from '@fss/domain/crm/firms.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { grantFollowUpPermission } from '@fss/domain/sequences/followUpPermissions.ts';
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

/**
 * An evidenced follow-up permission, as the reply card or the call outcome would grant
 * one (migration 0025).
 *
 * The evidence is a real `call_logs` row for the same firm and person, because
 * `verifyFollowUpPermission` re-reads it and refuses a permission whose evidence does not
 * hold up — which is the whole point of the design and not something a test may stub.
 *
 * `agreed_sequence` is the scope tests want by default: it permits the whole of a named
 * sequence, so a multi-step fixture version runs under it, and a send does not spend it.
 */
export async function seedFollowUpPermission(
  fixture: AuthFixture,
  input: {
    readonly firmId: string;
    readonly contactId: string;
    readonly opportunityId?: string | undefined;
    readonly sequenceId: string;
  },
  workspace: SeededWorkspace = fixture.alpha,
): Promise<string> {
  const context = adminContext(fixture, workspace);
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO call_logs
       (workspace_id, firm_id, contact_id, opportunity_id, outcome, step_effect, occurred_at, actor_user_id)
     VALUES ($1, $2, $3, $4, 'interested', 'none', now() - interval '1 second', $5)
     RETURNING id`,
    [
      workspace.workspaceId,
      input.firmId,
      input.contactId,
      input.opportunityId ?? null,
      workspace.admin.userId,
    ],
  );
  const granted = await grantFollowUpPermission(context, {
    firmId: input.firmId,
    contactId: input.contactId,
    kind: 'agreed_sequence',
    scope: 'agreed_sequence',
    callLogId: rows[0]?.id ?? '',
    sequenceId: input.sequenceId,
    grantedByUserId: workspace.admin.userId,
  });
  if (!granted.ok) throw new Error(`seedFollowUpPermission refused: ${granted.reason}`);
  return granted.value.id;
}
