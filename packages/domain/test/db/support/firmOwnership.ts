import type { RepositoryContext } from '../../../db/workspaceScope.ts';

/** Fixture-only ownership change for current ACL, privacy and send-race tests.
 * This is not a reassignment workflow and creates no authority, holds or tasks. */
export async function reassignFixtureFirm(
  context: RepositoryContext,
  input: { firmId: string; toUserId: string; reason?: string },
): Promise<{ ok: true }> {
  const result = await context.db.query(
    'UPDATE firms SET assigned_user_id=$3,updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id',
    [context.scope.workspaceId, input.firmId, input.toUserId],
  );
  if (result.rows.length !== 1) throw new Error('fixture firm missing');
  return { ok: true };
}
