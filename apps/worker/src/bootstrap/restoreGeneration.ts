import { readSystemGeneration, withTransaction, type SessionQueryable } from '@fss/domain/db';
import { listOpenHolds, openRestoreHolds, type RestoreHoldOpener } from '@fss/domain/restore';
import { errorFields, type Logger } from './log.ts';

/**
 * Appendix E step 1, as one function with three callers (lane g56).
 *
 *   * **the worker**, at startup, once the schema range is proved (`worker.ts`);
 *   * **`fss admin restore-holds open --expected-generation <n>`**, which an operator
 *     runs on the operations task definition against a restored instance *before* any
 *     service is pointed at it, so the API's dial gate never sees that database
 *     unheld;
 *   * **`fss drill`**, which runs that command as step 1a, so the automated drill
 *     exercises exactly the code a production restore depends on.
 *
 * ## What it does
 *
 * Compares the database's `system_generation` with the generation the operator
 * expects. When the operator expects none, or the two agree, it does nothing. When
 * they differ it opens one restore hold per workspace (`openRestoreHolds`, idempotent)
 * in one transaction and logs `restore_generation_mismatch` — the exact event
 * `infra/modules/observability/main.tf` turns into `RestoreGenerationMismatches`,
 * which 13.3 makes immediately critical. The drill's log stream lands in the worker
 * log group, so the drill raises the same metric the worker does.
 *
 * The line is written even when the write fails, and the failure is then thrown: the
 * alarm must not depend on the hold, and a process that could not hold a restored
 * database must not go on to act on it.
 *
 * ## While it persists (audit O16, lane g81)
 *
 * The startup line is one event, and the alarm over it is one datapoint of one minute
 * with missing data not breaching, so a mismatch that was still there an hour later
 * read OK three minutes after the worker started. `observeRestoreGeneration` below is
 * the continuing half: the worker's metric loop calls it on every pass, and while the
 * pinned generation and the database's still differ it writes the same event again,
 * so `RestoreGenerationMismatches` reads one per pass for as long as the condition
 * lasts and none once it is resolved. The alarm keeps the log-derived metric rather
 * than a `PutMetricData` gauge for the reason the observability module gives for all
 * three immediately-critical metrics — a task that cannot reach the metrics API still
 * raises them through its log stream — and because `fss drill` and
 * `fss admin restore-holds open`, which have no metric loop, raise it the same way.
 */

export interface RestoreGenerationCheck {
  /** Null when the operator pinned nothing, in which case nothing was checked. */
  readonly expectedGeneration: number | null;
  readonly observedGeneration: number | null;
  readonly mismatch: boolean;
  readonly holdsOpened: number;
  readonly holdsAlreadyOpen: number;
  /** Open `restore_in_progress` holds after the check, across every workspace. */
  readonly restoreHoldsInForce: number;
}

export interface RestoreGenerationOptions {
  /** Null or absent: unpinned, and the check is not made. */
  readonly expectedGeneration: number | null | undefined;
  /** What `checkWorkerStartup` already read, so the worker does not read it twice. */
  readonly observedGeneration?: number | null | undefined;
  readonly openedBy: RestoreHoldOpener;
  readonly log: Logger;
}

export async function enforceRestoreGeneration(
  session: SessionQueryable,
  options: RestoreGenerationOptions,
): Promise<RestoreGenerationCheck> {
  const expectedGeneration = options.expectedGeneration ?? null;
  const observedGeneration =
    options.observedGeneration === undefined ? await readSystemGeneration(session) : options.observedGeneration;

  // The same rule `restoreSuspected` states: no pin, or a database that reports no
  // generation at all, is not a restore this check can name.
  if (expectedGeneration === null || observedGeneration === null || observedGeneration === expectedGeneration) {
    const inForce = expectedGeneration === null ? 0 : (await listOpenHolds(session, { reason: 'restore_in_progress' })).length;
    return {
      expectedGeneration,
      observedGeneration,
      mismatch: false,
      holdsOpened: 0,
      holdsAlreadyOpen: 0,
      restoreHoldsInForce: inForce,
    };
  }

  let opened;
  try {
    opened = await withTransaction(session, async () =>
      openRestoreHolds(session, { observedGeneration, expectedGeneration, openedBy: options.openedBy }),
    );
  } catch (error) {
    options.log.log('error', 'restore_generation_mismatch', {
      expected_generation: expectedGeneration,
      observed_generation: observedGeneration,
      restore_holds: 'not_opened',
      ...errorFields(error),
    });
    throw error;
  }

  // The exact event name infra/modules/observability/main.tf turns into
  // RestoreGenerationMismatches, which 13.3 makes immediately critical.
  options.log.log('error', 'restore_generation_mismatch', {
    expected_generation: expectedGeneration,
    observed_generation: observedGeneration,
    restore_holds_opened: opened.opened.length,
    restore_holds_already_open: opened.alreadyHeld,
  });

  return {
    expectedGeneration,
    observedGeneration,
    mismatch: true,
    holdsOpened: opened.opened.length,
    holdsAlreadyOpen: opened.alreadyHeld,
    restoreHoldsInForce: (await listOpenHolds(session, { reason: 'restore_in_progress' })).length,
  };
}

export interface RestoreGenerationObservation {
  readonly expectedGeneration: number | null;
  readonly observedGeneration: number | null;
  readonly mismatch: boolean;
}

/**
 * The mismatch as a continuing condition: read, compare and, while they differ, log
 * `restore_generation_mismatch` again. Nothing is written to the database; the holds
 * are `enforceRestoreGeneration`'s, opened once at startup.
 *
 * Unpinned, or a database that reports no generation, is not a restore this can name
 * and is never a mismatch — the same rule as the startup check.
 */
export async function observeRestoreGeneration(
  session: SessionQueryable,
  options: { readonly expectedGeneration: number | null | undefined; readonly log: Logger },
): Promise<RestoreGenerationObservation> {
  const expectedGeneration = options.expectedGeneration ?? null;
  if (expectedGeneration === null) return { expectedGeneration, observedGeneration: null, mismatch: false };
  const observedGeneration = await readSystemGeneration(session);
  if (observedGeneration === null || observedGeneration === expectedGeneration) {
    return { expectedGeneration, observedGeneration, mismatch: false };
  }
  const inForce = (await listOpenHolds(session, { reason: 'restore_in_progress' })).length;
  // The exact event infra/modules/observability/main.tf counts, once per pass while
  // the condition lasts: this is what keeps the immediately-critical alarm in ALARM.
  options.log.log('error', 'restore_generation_mismatch', {
    expected_generation: expectedGeneration,
    observed_generation: observedGeneration,
    restore_holds_in_force: inForce,
    continuing: true,
  });
  return { expectedGeneration, observedGeneration, mismatch: true };
}
