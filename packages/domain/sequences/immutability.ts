import type { RepositoryContext } from '../db/workspaceScope.ts';

/**
 * The database's immutability guards, answered as refusals (send-path v2, S2).
 *
 * Migration 0026 puts back the two triggers 0019 removed: the steps of a version that
 * has left `draft` cannot be updated or deleted (`sequence_steps_published_immutable`),
 * and an approved template version cannot change anything but its name, `retired_at`
 * and `updated_at` (`template_versions_approved_immutable`). The commands in `definitions.ts` and `templates/templates.ts` never ask for
 * either — an edit of something frozen writes a new version instead — and they lock the
 * row they decide about before they decide, so the trigger is the backstop for a path
 * nobody has thought of rather than a rule anybody relies on.
 *
 * A backstop that answers 500 is still a 500, though. `underImmutabilityGuard` runs the
 * writes inside a savepoint, and a trigger refusal rolls the savepoint back and comes
 * out as the caller's refusal value, which commits with its receipt like every other.
 * Any other error propagates unchanged.
 */

/** The two messages 0026's triggers raise, and nothing else raises. */
const IMMUTABILITY_MESSAGES = [
  'the steps of a published sequence version are immutable',
  'an approved template version is immutable',
] as const;

/**
 * Whether `error` is one of 0026's immutability refusals. Both triggers raise
 * `restrict_violation` (23001), which other constraint triggers in this schema raise
 * too, so the match is the code and the message together: another trigger refusing
 * inside the same writes is a real bug and must still be a 500.
 */
export function isImmutabilityRefusal(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === '23001' &&
    typeof message === 'string' &&
    IMMUTABILITY_MESSAGES.some(prefix => message.startsWith(prefix))
  );
}

const SAVEPOINT = 'immutability_guard';

/**
 * Run `work` so that a trigger refusal undoes what it wrote and answers `refusal`.
 *
 * Inside a transaction — every command, through `runCommand` — this is a savepoint.
 * Outside one (a test calling the domain on an autocommit session) the work is its own
 * transaction, which gives the same answer.
 */
export async function underImmutabilityGuard<R extends { readonly ok: boolean }>(
  context: RepositoryContext,
  refusal: () => R,
  work: () => Promise<R>,
): Promise<R> {
  let nested = true;
  try {
    await context.db.query(`SAVEPOINT ${SAVEPOINT}`);
  } catch (error) {
    // 25P01 no_active_sql_transaction: not inside a transaction block.
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
    await context.db.query('BEGIN');
  }
  const undo = async (): Promise<void> => {
    if (nested) {
      await context.db.query(`ROLLBACK TO SAVEPOINT ${SAVEPOINT}`);
      await context.db.query(`RELEASE SAVEPOINT ${SAVEPOINT}`);
    } else {
      await context.db.query('ROLLBACK');
    }
  };
  let result: R;
  try {
    result = await work();
  } catch (error) {
    await undo();
    if (isImmutabilityRefusal(error)) return refusal();
    throw error;
  }
  await context.db.query(nested ? `RELEASE SAVEPOINT ${SAVEPOINT}` : 'COMMIT');
  return result;
}
