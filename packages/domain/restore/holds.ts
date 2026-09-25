import type { HoldReasonCode } from '@fss/contracts';
import type { Queryable } from '../db/queryable.ts';
import { repositoryContext, workspaceScope } from '../db/workspaceScope.ts';
import { ALL_BLOCKED_ACTION_KINDS, listHoldsByReason, openHold, releaseHold, type OpenHold } from '../policy/index.ts';
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

/**
 * Appendix E step 1: "the restored database's `system_generation` differs from the
 * operator-controlled expected generation; restore holds block sending and dialing."
 *
 * Until lane g56 nothing opened these holds. The worker logged the mismatch and the
 * release at step 9 released holds nobody had opened, so a restored database held
 * nothing (rehearsal run 36062337914, 24 September 2026).
 *
 * ## The scope, and why one per workspace
 *
 * `active_holds.workspace_id` is not null, and every gate asks `listApplicableHolds`,
 * which reads one workspace's rows and matches a `workspace`-scope hold for every
 * subject. There is no system-wide hold to open, so the restore is held by one
 * workspace-scope hold in each workspace, blocking every action kind the schema
 * knows. Research included: nothing the restored database decides is acted on until
 * step 9 says it has been reconciled.
 *
 * ## What it refuses to do
 *
 * It opens nothing when the two generations agree. Deciding that there was a restore
 * is not the caller's to get wrong. It opens nothing in a workspace that already holds
 * an open restore hold, so a worker that restarts during the protocol, or two workers
 * starting in the same deployment, add no second row: the advisory lock makes the
 * read-then-insert one step. And it touches no other hold, because 4.3's "clearing
 * one hold never clears another" has a twin: opening one never rewrites another.
 *
 * The caller holds the transaction. The lock is transaction-scoped and would be
 * released at the end of the first statement otherwise.
 */

/** Serialises every opener. A text key, hashed by PostgreSQL, so it cannot collide by accident. */
export const RESTORE_HOLDS_LOCK_KEY = 'fss.restore_holds.open';

/** What a restore hold is opened by. Stored in `source_event_id`, never trusted for anything. */
export type RestoreHoldOpener = 'worker' | 'fss';

export interface OpenRestoreHoldsInput {
  /** What the database reports, `readSystemGeneration`. */
  readonly observedGeneration: number;
  /** What the operator pinned. */
  readonly expectedGeneration: number;
  readonly openedBy: RestoreHoldOpener;
}

export interface OpenedRestoreHolds {
  /** False when the generations agree, in which case nothing was read or written. */
  readonly mismatch: boolean;
  /** One per workspace that had none. */
  readonly opened: readonly { readonly workspaceId: string; readonly holdId: string }[];
  /** Workspaces that already held an open restore hold and so were left alone. */
  readonly alreadyHeld: number;
}

export async function openRestoreHolds(db: Queryable, input: OpenRestoreHoldsInput): Promise<OpenedRestoreHolds> {
  if (input.observedGeneration === input.expectedGeneration) {
    return { mismatch: false, opened: [], alreadyHeld: 0 };
  }
  await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [RESTORE_HOLDS_LOCK_KEY]);

  const opened: { workspaceId: string; holdId: string }[] = [];
  let alreadyHeld = 0;
  for (const workspaceId of await listWorkspaceIds(db)) {
    const context = repositoryContext(workspaceScope(workspaceId, RESTORE_ACTOR), db);
    const existing = await listHoldsByReason(context, { reason: 'restore_in_progress' });
    if (existing.length > 0) {
      alreadyHeld += 1;
      continue;
    }
    const holdId = await openHold(context, {
      scopeKind: 'workspace',
      reasonCode: 'restore_in_progress',
      blockedActionKinds: ALL_BLOCKED_ACTION_KINDS,
      sourceEventKind: 'restore.generation_mismatch',
      sourceEventId: `${input.openedBy}:${String(input.observedGeneration)}->${String(input.expectedGeneration)}`,
      recoveryAction: 'advance_generation',
    });
    opened.push({ workspaceId, holdId });
  }
  return { mismatch: true, opened, alreadyHeld };
}
