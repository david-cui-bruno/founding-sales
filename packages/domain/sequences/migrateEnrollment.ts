import type { RepositoryContext } from '../db/workspaceScope.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { resolveStepDue } from '../src/rules/cadence.ts';
import { placeEmailSend } from '../src/rules/sendingWindow.ts';
import { holidayCalendarByVersion } from './calendars.ts';
import { completeEnrollment, FollowUpReuseError, stepForCadence, stopEnrollments } from './enrollments.ts';
import { bindFollowUpPermission, readFollowUpPermission, verifyFollowUpPermission } from './followUpPermissions.ts';
import { loadEnrollmentForUpdate, readSequenceVersion } from './rows.ts';
import { acceptSequence, refuseSequence, type SequenceResult } from './types.ts';

/**
 * Moving a running enrollment to a newer published version, explicitly (send-path v2, S2).
 *
 * David, 30 September 2026: *"Existing enrollments keep their original steps, template
 * versions, and cadence. Edits affect new enrollments by default. Explicitly migrating an
 * enrollment must preserve completed steps and the agreed follow-up scope."*
 *
 * An enrollment is frozen to its version (11.2), and since this slice a published version
 * never changes (`definitions.ts`), so the only way a person already in a plan receives
 * the edited plan is this command. It **supersedes** rather than remaps: the old
 * enrollment ends `migration_superseded` with its history intact, and a new enrollment
 * on the target version starts where the old one had got to. Nothing is rewritten.
 *
 * ## What carries over, and what does not
 *
 *   * **The completed steps.** The old enrollment's completed executions must be exactly
 *     ordinals 1..k — a contiguous prefix, none cancelled, none skipped, nothing unfinished
 *     below k + 1 — or the command refuses `completed_prefix_required`. The new enrollment
 *     starts at ordinal k + 1 of the target and never at 1 again; its 1..k are the old
 *     enrollment's rows, reached through `migrated_from_enrollment_id`.
 *   * **The cadence anchor.** `started_at` is copied from the old row in SQL (so no
 *     microsecond is lost to a JavaScript `Date`), with the frozen zone and holiday
 *     calendar, and step k + 1 is due at the target's delay for that step from that
 *     anchor — 11.1's start-anchored cadence, the same rule every successor uses. When
 *     that instant has already passed (k > 0), the step is placed at its delay from now
 *     instead and the answer names the new instant (`rescheduledTo`): a migration never
 *     makes a replacement e-mail due on the next tick.
 *   * **Only the next execution.** One row, ordinal k + 1. A target with no step k + 1 is
 *     a plan already finished, and the new enrollment completes at once
 *     (`sequence_complete`).
 *   * **The agreed scope.** A `follow_up` run moves only on a **fresh** permission for the
 *     target version, granted from evidence and verified with `verifyFollowUpPermission`
 *     exactly as `enrollContact` verifies one, then bound to the **new** enrollment. The old
 *     permission stays bound to the old enrollment, which has ended: a permission buys one
 *     enrollment (`follow_up_permissions_one_enrollment`), so it can never buy another, and
 *     nothing sends on an ended one. It is not revoked and not marked consumed — it was
 *     neither withdrawn nor spent on a message; its run ended. An `agreed_sequence` run
 *     offered no fresh permission refuses `agreed_scope_bound`, because an agreement to one
 *     immutable version is not an agreement to another. `prospecting` moves without one.
 *   * **`cold_legacy` never moves** (`cold_legacy_never_revived`): moving it would be the
 *     revival David ruled out.
 *
 * ## The lock order, and what it excludes
 *
 * Send gate EXCLUSIVE → the old enrollment → the fresh permission → the firm →
 * opportunity → contact (`docs/greenfield/decisions/follow-up-eligibility-20260929.md`
 * §6a and its 30 September § for this command). The gate first, because ending the old
 * enrollment is a stop fact and every stop-fact writer takes the gate before any row: a
 * dispatch claim holds it SHARED for its whole transaction, so a claim in flight makes
 * this command wait, and this command in flight makes a claim wait and then find the old
 * enrollment ended. The step runner does not take the gate; it locks the enrollment
 * first (`lockStepWithEnrollment`), which this command has also locked, so the two
 * serialize on that row instead.
 *
 * `enrollment_dispatching` is read after those locks: any execution of the old enrollment
 * in state `dispatched`, or with an outbound fence while the execution is unfinished, or
 * with a fence `dispatching` or `reconciling` at all. Bytes that may already have left, or
 * are frozen for the old version's step, are not something a migration can take back.
 *
 * The old enrollment ends **before** the new one is inserted, so neither
 * `sequence_enrollments_one_active_per_contact` nor the firm's one-prospecting rule ever
 * sees two live rows.
 */

export interface MigrateEnrollmentInput {
  readonly enrollmentId: string;
  readonly targetSequenceVersionId: string;
  /** The fresh permission a `follow_up` run moves on. Refused for the other origins. */
  readonly permissionId?: string | undefined;
  /** The person's reason, kept in the audit event. */
  readonly changeNote?: string | undefined;
}

export interface MigratedEnrollment {
  readonly oldEnrollmentId: string;
  readonly newEnrollmentId: string;
  /** The completed ordinals the new enrollment inherits, 1..k. */
  readonly carriedOrdinals: readonly number[];
  /** k + 1: the one step scheduled, or the step the plan would have been at when it has run out. */
  readonly nextOrdinal: number;
  /** True when the target has no step k + 1 and the new enrollment completed at once. */
  readonly completed: boolean;
  /**
   * When step k + 1's planned instant (the target's delay from the original anchor) had
   * already passed, the instant it was moved to instead — its delay counted from now and,
   * for an e-mail, placed in the sending window. Null when it kept the plan, or when there
   * is no next step.
   */
  readonly rescheduledTo: string | null;
}

interface ExecutionForPrefix {
  readonly ordinal: number;
  readonly state: string;
  readonly result: string | null;
}

/**
 * The completed prefix of an enrollment's executions: k, or null when the completed
 * steps are not exactly 1..k with nothing else below k + 1.
 */
export function completedPrefix(executions: readonly ExecutionForPrefix[]): number | null {
  const completed = executions.filter(execution => execution.state === 'completed');
  if (executions.some(execution => execution.state === 'cancelled')) return null;
  if (completed.some(execution => execution.result === 'skipped')) return null;
  const ordinals = completed.map(execution => execution.ordinal).sort((left, right) => left - right);
  if (!ordinals.every((ordinal, index) => ordinal === index + 1)) return null;
  const k = ordinals.length;
  // Whatever is unfinished must be the step after the prefix: a pending step below it
  // is a hole, and one above it is a step that ran out of order.
  const unfinished = executions.filter(execution => execution.state !== 'completed');
  if (unfinished.some(execution => execution.ordinal !== k + 1)) return null;
  return k;
}

/**
 * Migrate one live enrollment to a published version of the same sequence.
 *
 * Every refusal is decided before anything is written, because a refusal commits with
 * its receipt. The one exception is the permission bind, which is conditional in SQL; a
 * lost bind throws `FollowUpReuseError` and takes the whole transaction, the old
 * enrollment's end included, with it.
 */
export async function migrateEnrollment(
  context: RepositoryContext,
  input: MigrateEnrollmentInput,
): Promise<SequenceResult<MigratedEnrollment>> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user') return refuseSequence('admin_only');

  // 1. The send gate, exclusively, before any row.
  await lockSendGateForStopFact(context);

  // 2. The old enrollment.
  const old = await loadEnrollmentForUpdate(context, input.enrollmentId);
  if (old === null) return refuseSequence('enrollment_unknown');

  // 3. The fresh permission, locked when one is offered. Decided below, after the
  //    authorization, so a person who may not act here learns nothing about it.
  const offered =
    input.permissionId === undefined
      ? null
      : (
          await context.db.query<{ enrollment_id: string | null }>(
            'SELECT enrollment_id FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
            [context.scope.workspaceId, input.permissionId],
          )
        ).rows[0] ?? null;

  // 4. The firm, and who may act on it: an administrator, or its assigned salesperson.
  const { rows: firms } = await context.db.query<{ assigned_user_id: string | null; status: string }>(
    'SELECT assigned_user_id, status FROM firms WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, old.firmId],
  );
  const firm = firms[0];
  if (firm === undefined || firm.status !== 'active') return refuseSequence('firm_unknown');
  if (actor.role !== 'admin' && firm.assigned_user_id !== actor.userId) return refuseSequence('not_assigned');

  if (old.endedAt !== null || old.state !== 'active') return refuseSequence('enrollment_not_live');
  if (old.originKind === 'cold_legacy') return refuseSequence('cold_legacy_never_revived');
  if (old.originKind === 'prospecting' && input.permissionId !== undefined) return refuseSequence('invalid_input');
  if (old.originKind === 'follow_up' && input.permissionId === undefined) {
    const agreed = old.permissionId === null ? null : await readFollowUpPermission(context, old.permissionId);
    return refuseSequence(agreed?.scope === 'agreed_sequence' ? 'agreed_scope_bound' : 'follow_up_not_permitted');
  }
  // A permission that already bought a run — the old one's, or anybody's — is not fresh.
  if (input.permissionId !== undefined && (offered === null || offered.enrollment_id !== null)) {
    return refuseSequence('follow_up_not_permitted');
  }

  const { rows: opportunities } = await context.db.query<{ status: string }>(
    'SELECT status FROM opportunities WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, old.opportunityId],
  );
  if (opportunities[0]?.status !== 'open') return refuseSequence('opportunity_not_open');
  const { rows: contacts } = await context.db.query<{ status: string }>(
    'SELECT status FROM contacts WHERE workspace_id = $1 AND id = $2 FOR UPDATE',
    [context.scope.workspaceId, old.contactId],
  );
  if (contacts[0]?.status !== 'active') return refuseSequence('contact_unknown');

  // 5. The target: a published version of the same sequence, and not the one it runs.
  //    Its row is held FOR SHARE until the commit (PR 335 review, P2-a): publishing a
  //    newer version retires this one with an UPDATE, which waits, so a publication cannot
  //    retire the target between this check and the insert. Taken last, after every row
  //    above; `publishVersion` takes no row this command holds before it, so no cycle.
  await context.db.query('SELECT id FROM sequence_versions WHERE workspace_id = $1 AND id = $2 FOR SHARE', [
    context.scope.workspaceId,
    input.targetSequenceVersionId,
  ]);
  const current = await readSequenceVersion(context, old.sequenceVersionId);
  const target = await readSequenceVersion(context, input.targetSequenceVersionId);
  if (current === null || target === null) return refuseSequence('version_unknown');
  if (target.sequenceId !== current.sequenceId) return refuseSequence('version_other_sequence');
  if (target.id === current.id) return refuseSequence('invalid_input');
  if (target.state === 'retired') return refuseSequence('version_retired');
  if (target.state !== 'published') return refuseSequence('version_not_published');

  // 6. Nothing in flight, and a contiguous completed prefix.
  const { rows: inFlight } = await context.db.query<{ dispatching: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM step_executions e
         LEFT JOIN outbound_messages f ON f.workspace_id = e.workspace_id AND f.step_execution_id = e.id
        WHERE e.workspace_id = $1 AND e.enrollment_id = $2
          AND (e.state = 'dispatched'
               OR (f.id IS NOT NULL
                   AND (e.state NOT IN ('completed', 'cancelled') OR f.state IN ('dispatching', 'reconciling'))))
     ) AS dispatching`,
    [context.scope.workspaceId, old.id],
  );
  if (inFlight[0]?.dispatching === true) return refuseSequence('enrollment_dispatching');

  const { rows: executions } = await context.db.query<{ ordinal: number; state: string; result: string | null }>(
    `SELECT ordinal, state, result FROM step_executions
      WHERE workspace_id = $1 AND enrollment_id = $2
      ORDER BY ordinal
      FOR UPDATE`,
    [context.scope.workspaceId, old.id],
  );
  const k = completedPrefix(executions.map(row => ({ ...row, ordinal: Number(row.ordinal) })));
  if (k === null) return refuseSequence('completed_prefix_required');
  const next = target.steps.find(step => step.ordinal === k + 1);

  // 7. The fresh permission's own evidence, re-read, for the target plan.
  if (input.permissionId !== undefined) {
    const { rows: clockNow } = await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const verdict = await verifyFollowUpPermission(context, input.permissionId, {
      firmId: old.firmId,
      contactId: old.contactId,
      now: (clockNow[0]?.now ?? new Date()).toISOString(),
      sequenceVersionId: target.id,
      stepCount: target.steps.length,
      // The bytes that would leave next, which is step k + 1, not the plan's first.
      templateVersionId: next?.templateVersionId ?? null,
      // A one-message scope buys an e-mail step k + 1 with the agreed bytes, never a call
      // and never a target with nothing left (PR 335 review, P1-5).
      nextStep: next === undefined ? null : { channel: next.channel, templateVersionId: next.templateVersionId },
    });
    if (!verdict.ok) return refuseSequence('follow_up_not_permitted');
  }

  // 8. Where step k + 1 goes, decided before anything is written.
  //
  // PR 335 review, P1-6: a step whose planned instant has already passed is not sent on
  // the next tick. For k > 0 it is placed at the target's delay for that step counted
  // from now — the spacing a successor keeps when its predecessor ran late — and the
  // answer says so (`rescheduledTo`). "Now" is `clock_timestamp()`, read here, after every
  // lock is held: the transaction's `now()` is the instant it began, before it waited for
  // the gate, and a plan that passed during that wait would read as not yet late. The
  // first step of a run that has done nothing (k = 0) keeps the plan.
  //
  // An e-mail is then placed in the sending window with `placeEmailSend` — the rule the
  // step runner applies — on the frozen zone and calendar, so the instant compared with
  // the permission below and answered as `rescheduledTo` is the instant it can send.
  let schedule: { readonly dueAt: string; readonly sourceZone: string; readonly ruleVersion: string } | null = null;
  let rescheduledTo: string | null = null;
  if (next !== undefined) {
    const calendar = await holidayCalendarByVersion(context, old.holidayCalendarVersion);
    const planned = resolveStepDue(stepForCadence(next), old.startedAt, old.firmTimeZone, calendar);
    const { rows: clock } = await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
    const now = (clock[0]?.now ?? new Date()).toISOString();
    const late = k > 0 && Date.parse(planned.dueAt) <= Date.parse(now);
    const due = late ? resolveStepDue(stepForCadence(next), now, old.firmTimeZone, calendar) : planned;
    const sendsAt =
      next.channel === 'email' ? placeEmailSend(due.dueAt, old.firmTimeZone, { calendar }).sendAt : due.dueAt;
    schedule = { dueAt: late ? sendsAt : due.dueAt, sourceZone: due.sourceZone, ruleVersion: due.ruleVersion };
    if (late) rescheduledTo = sendsAt;

    // PR 335 review, rounds 2–6: a fresh permission buys this run only if the run can do
    // what it was agreed for before the permission ends. Checked here, before the old row
    // is touched; a refusal leaves the old enrollment active and the permission unbound.
    //
    //   * The remainder (k + 1 … n) must **begin with an e-mail**, and that e-mail's placed
    //     instant (above: `clock_timestamp()` after the locks, the frozen zone and
    //     calendar, `placeEmailSend`) must precede `expires_at`, else
    //     `permission_expires_before_step`.
    //   * A remainder that begins with a **call task** is refused
    //     `remainder_starts_with_call`. When its e-mail becomes due depends on when the
    //     call is completed, which depends on when Today builds its card — a projection
    //     that could only be made exact by coupling the migration to Today's
    //     materialisation. Fail closed instead: record a new agreement from the call card,
    //     where a call-first agreed sequence is enrolled directly (S3).
    if (input.permissionId !== undefined) {
      if (next.channel !== 'email') return refuseSequence('remainder_starts_with_call');
      const { rows: bound } = await context.db.query<{ expires_at: Date }>(
        'SELECT expires_at FROM follow_up_permissions WHERE workspace_id = $1 AND id = $2',
        [context.scope.workspaceId, input.permissionId],
      );
      const expiresAt = bound[0]?.expires_at;
      if (expiresAt === undefined || Date.parse(sendsAt) >= expiresAt.getTime()) {
        return refuseSequence('permission_expires_before_step');
      }
    }
  }

  // 9. Supersede: end the old enrollment first, then insert the new one.
  await stopEnrollments(context, {
    enrollmentId: old.id,
    reason: 'migration_superseded',
    cancelReason: 'superseded by an explicit migration',
  });

  const { rows: inserted } = await context.db.query<{ id: string }>(
    `INSERT INTO sequence_enrollments
       (workspace_id, sequence_version_id, opportunity_id, firm_id, contact_id, assigned_user_id,
        started_at, firm_time_zone, holiday_calendar_version, origin_kind, permission_id,
        migrated_from_enrollment_id)
     SELECT workspace_id, $3, opportunity_id, firm_id, contact_id, assigned_user_id,
            started_at, firm_time_zone, holiday_calendar_version, origin_kind, $4, id
       FROM sequence_enrollments
      WHERE workspace_id = $1 AND id = $2
     RETURNING id`,
    [context.scope.workspaceId, old.id, target.id, input.permissionId ?? null],
  );
  const newEnrollmentId = inserted[0]?.id;
  if (newEnrollmentId === undefined) throw new Error('the superseding enrollment was not written');

  if (next !== undefined && schedule !== null) {
    await context.db.query(
      `INSERT INTO step_executions
         (workspace_id, enrollment_id, step_id, firm_id, contact_id, channel, ordinal,
          due_at, not_before, original_due_at, source_zone, rule_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, GREATEST($8::timestamptz, now()), $8::timestamptz, $9, $10)`,
      [
        context.scope.workspaceId,
        newEnrollmentId,
        next.id,
        old.firmId,
        old.contactId,
        next.channel,
        next.ordinal,
        schedule.dueAt,
        schedule.sourceZone,
        schedule.ruleVersion,
      ],
    );
  }

  // The permission buys this run and only this one; zero rows takes everything back.
  // The grant's own bound is kept: it was computed for the target version's plan.
  if (input.permissionId !== undefined) {
    const bound = await bindFollowUpPermission(context, input.permissionId, newEnrollmentId);
    if (!bound) throw new FollowUpReuseError(input.permissionId);
  }

  if (next === undefined) await completeEnrollment(context, newEnrollmentId);

  const carriedOrdinals = Array.from({ length: k }, (_, index) => index + 1);
  await recordCrmAuditEvent(context, {
    action: 'enrollment.migrated',
    subjectKind: 'sequence_enrollment',
    subjectId: newEnrollmentId,
    detail: {
      oldEnrollmentId: old.id,
      fromSequenceVersionId: current.id,
      targetSequenceVersionId: target.id,
      originKind: old.originKind,
      oldPermissionId: old.permissionId,
      permissionId: input.permissionId ?? null,
      carriedOrdinals,
      nextOrdinal: k + 1,
      completed: next === undefined,
      rescheduledTo,
      changeNote: input.changeNote ?? null,
    },
  });

  return acceptSequence({
    oldEnrollmentId: old.id,
    newEnrollmentId,
    carriedOrdinals,
    nextOrdinal: k + 1,
    completed: next === undefined,
    rescheduledTo,
  });
}
