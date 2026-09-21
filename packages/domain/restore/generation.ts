import type { Queryable } from '../db/queryable.ts';
import { readSystemGeneration } from '../db/schemaRange.ts';
import { listOpenHolds, releaseHoldsOfReason } from './holds.ts';

/**
 * Appendix E step 9: "an authenticated admin advances `system_generation`; restore
 * holds release only after every other applicable hold is reevaluated."
 *
 * ## What this function is, and what it deliberately is not
 *
 * It is the write: the next generation row, attributed to a named admin, and the
 * release of the `restore_in_progress` holds and of nothing else.
 *
 * It is **not** the authentication. The specification asks for "a deliberate human act
 * with a normal active, device-bound admin session", and a command line has no
 * session. So the honest thing a tool can do is refuse to act without an admin's user
 * id, check that the id really is an active admin, and record it — which is what
 * `system_generations_operator_advance_attributed` requires of the row anyway. An
 * operator who wants the device-bound act uses the API; see
 * `docs/decisions/g12g-the-operations-command-line.md` for what that costs and why the
 * rehearsal gets this instead.
 */

export type AdvanceRefusal = 'admin_missing' | 'not_admin' | 'generation_absent';

export interface GenerationAdvance {
  readonly generation: number;
  readonly previousGeneration: number;
  readonly releasedRestoreHolds: number;
  readonly otherHoldsStillHeld: number;
}

export type AdvanceResult =
  | { readonly ok: true; readonly value: GenerationAdvance }
  | { readonly ok: false; readonly reason: AdvanceRefusal };

export interface AdvanceInput {
  /** The admin this act is attributed to. Never optional: an unattributed advance is not one. */
  readonly adminUserId?: string | undefined;
  readonly notes?: string | undefined;
}

export async function advanceSystemGeneration(db: Queryable, input: AdvanceInput): Promise<AdvanceResult> {
  const adminUserId = input.adminUserId?.trim();
  if (adminUserId === undefined || adminUserId.length === 0) return { ok: false, reason: 'admin_missing' };

  const admin = await db.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM workspace_memberships
      WHERE user_id = $1 AND role = 'admin' AND status = 'active'`,
    [adminUserId],
  );
  if (Number(admin.rows[0]?.count ?? '0') < 1) return { ok: false, reason: 'not_admin' };

  const previousGeneration = await readSystemGeneration(db);
  if (previousGeneration === null) return { ok: false, reason: 'generation_absent' };

  const { rows } = await db.query<{ generation: string }>(
    `INSERT INTO system_generations (generation, reason, established_at, established_by_user_id, notes)
     VALUES ((SELECT max(generation) + 1 FROM system_generations), 'restore_completed', now(), $1, $2)
     RETURNING generation::text AS generation`,
    [adminUserId, input.notes?.trim() === '' ? null : (input.notes ?? null)],
  );
  const generation = Number(rows[0]?.generation ?? '0');

  // The release is last, and it is selective. Every other hold is left exactly as it
  // was, which is what the drill measures before and after (4.3).
  const released = await releaseHoldsOfReason(db, 'restore_in_progress');
  const others = await listOpenHolds(db, { excludeReason: 'restore_in_progress' });

  return {
    ok: true,
    value: {
      generation,
      previousGeneration,
      releasedRestoreHolds: released.length,
      otherHoldsStillHeld: others.length,
    },
  };
}
