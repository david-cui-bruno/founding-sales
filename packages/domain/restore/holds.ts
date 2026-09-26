import type { HoldReasonCode } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import { listHoldsByReason } from '../policy/holds.ts';
import { type OpenHold } from '../policy/types.ts';

/**
 * `fss admin holds list`: every open hold in the database, workspace by workspace.
 *
 * Each workspace is asked through its own `WorkspaceScope`, rather than with one
 * cross-workspace statement over `active_holds`: the scoped read already exists, it is the
 * one the send and dial paths use, and a second statement would be a second place for the
 * filter to be wrong.
 */

export interface ScopedOpenHold extends OpenHold {
  readonly workspaceId: string;
}

export interface HoldFilter {
  readonly reason?: HoldReasonCode | undefined;
  readonly excludeReason?: HoldReasonCode | undefined;
}

/** The actor every operations command acts as. The tool is never a user. */
export const RESTORE_ACTOR = { kind: 'system', component: 'migration' } as const;

/** Every workspace id. Operations commands act on the whole database, never one workspace. */
export async function listWorkspaceIds(db: Queryable): Promise<readonly string[]> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM workspaces ORDER BY id');
  return rows.map(row => row.id);
}

export async function listOpenHolds(db: Queryable, filter: HoldFilter = {}): Promise<readonly ScopedOpenHold[]> {
  const found: ScopedOpenHold[] = [];
  for (const workspaceId of await listWorkspaceIds(db)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), db);
    for (const hold of await listHoldsByReason(context, filter)) found.push({ ...hold, workspaceId });
  }
  return found;
}
