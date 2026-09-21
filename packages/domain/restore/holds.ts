import type { HoldReasonCode } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import { listHoldsByReason, releaseHold, type OpenHold } from '../policy/index.ts';
import { listWorkspaceIds } from './counts.ts';

/**
 * `fss admin holds list` (Appendix E steps 1 and 9).
 *
 * The drill asks two questions of the whole database: "is a `restore_in_progress`
 * hold in force" before step 9, and "is every *other* hold still in force" after it.
 * Both are answered here by walking the workspaces and asking each one through its own
 * `WorkspaceScope`, rather than with one cross-workspace statement over
 * `active_holds`: the scoped read already exists, it is the one the send and dial
 * paths use, and a second statement would be a second place for the filter to be
 * wrong.
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

export async function listOpenHolds(db: Queryable, filter: HoldFilter = {}): Promise<readonly ScopedOpenHold[]> {
  const found: ScopedOpenHold[] = [];
  for (const workspaceId of await listWorkspaceIds(db)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), db);
    for (const hold of await listHoldsByReason(context, filter)) found.push({ ...hold, workspaceId });
  }
  return found;
}

/**
 * Release every hold of one reason, and nothing else.
 *
 * Section 4.3: "Clearing one hold never clears another." So the release is by id,
 * one hold at a time, through the function the pause release already uses — a
 * `WHERE reason_code = $1` update would be shorter and would be the exact shape of
 * the mistake 4.3 names.
 */
export async function releaseHoldsOfReason(
  db: Queryable,
  reason: HoldReasonCode,
): Promise<readonly ScopedOpenHold[]> {
  const released: ScopedOpenHold[] = [];
  for (const hold of await listOpenHolds(db, { reason })) {
    const context = repositoryContext(workspaceScope(hold.workspaceId, RESTORE_ACTOR), db);
    const outcome = await releaseHold(context, hold.id);
    if (outcome !== null) released.push(hold);
  }
  return released;
}
