import type { FollowUpPreviewResponse, FollowUpPreviewStep } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { readFirm } from '../crm/firms.ts';
import { databaseNow } from '../policy/clock.ts';
import { resolveStepDue } from '../src/rules/cadence.ts';
import { localParts } from '../src/rules/localClock.ts';
import { placeEmailSend } from '../src/rules/sendingWindow.ts';
import { currentHolidayCalendar } from '../sequences/calendars.ts';
import { stepForCadence } from '../sequences/enrollments.ts';
import { readSequenceVersion } from '../sequences/rows.ts';
import { isStepChannel, type SequenceStepRow } from '../sequences/types.ts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { readTemplateVersion } from '../templates/templates.ts';

/**
 * What an agreed sequence would send, and when (send-path v2, slice S3).
 *
 * David, 30 September 2026: *"Include no email / one approved email / an agreed approved
 * sequence in the first calling-to-booking milestone. Show the messages and timing and
 * record the prospect's agreement."* The Today card asks this before the outcome is
 * recorded, so the salesperson can read the plan back to the person on the call.
 *
 * ## The same arithmetic enrolment uses
 *
 * An estimate that disagrees with the schedule is worse than none, so nothing here is a
 * second implementation:
 *
 *   * the due instant of every step is `resolveStepDue(stepForCadence(step), anchor,
 *     zone, calendar)` — exactly the call `enrollContact` makes for the first step and
 *     `agreedSequenceExpiry` makes for all of them (start-anchored, 11.1);
 *   * an e-mail's expected instant is `placeEmailSend(due, zone, { calendar })` — the
 *     call `runEmailStep` makes before it releases a send (11.2, Appendix G 32);
 *   * the zone is the firm's `time_zone`, which enrolment freezes, and the calendar is
 *     the workspace's current one (`currentHolidayCalendar`), which enrolment freezes by
 *     version; the answer names that version.
 *
 * The anchor is `previewAt`, or the database's now. The one thing that can make the
 * real first due differ is the anchor itself — enrolment anchors at its own
 * transaction's `now()`, a moment after this read — which is why a test anchors both at
 * the same instant and asserts the same due.
 *
 * ## What it refuses
 *
 * The same things enrolment would, so the card never previews a plan it cannot start:
 * a firm that is not this caller's to act on, a contact not at the firm, a version that
 * is not this workspace's (`version_unknown`, whether foreign or absent), not published,
 * without steps or with a removed channel, and a firm whose zone was never established.
 */

export const FOLLOW_UP_PREVIEW_REFUSALS = [
  'firm_unknown',
  'not_assigned',
  'contact_unknown',
  'version_unknown',
  'version_not_published',
  'version_has_no_steps',
  'step_unknown',
  'firm_zone_unknown',
  'invalid_input',
] as const;
export type FollowUpPreviewRefusal = (typeof FOLLOW_UP_PREVIEW_REFUSALS)[number];

export type FollowUpPreviewResult =
  | { readonly ok: true; readonly value: FollowUpPreviewResponse }
  | { readonly ok: false; readonly reason: FollowUpPreviewRefusal };

export interface FollowUpPreviewInput {
  readonly firmId: string;
  readonly contactId: string;
  readonly sequenceVersionId: string;
  /** The instant the enrolment would start. Absent means the database's now. */
  readonly previewAt?: string | undefined;
}

export async function previewFollowUp(
  context: RepositoryContext,
  input: FollowUpPreviewInput,
): Promise<FollowUpPreviewResult> {
  const refuse = (reason: FollowUpPreviewRefusal): FollowUpPreviewResult => ({ ok: false, reason });

  const firm = await readFirm(context, input.firmId);
  if (firm === null || firm.status !== 'active') return refuse('firm_unknown');
  // The caller who could record the outcome and so start the plan: the assignee or an
  // admin, which is the rule `logCallOutcome` applies under the lock.
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuse(permitted.reason === 'not_assigned' ? 'not_assigned' : 'firm_unknown');

  const { rows: contacts } = await context.db.query(
    // Active, as `enrollContact` requires: an inactive person cannot be enrolled, so the
    // card must not preview a plan for them (review of S3, P2-a).
    "SELECT 1 FROM contacts WHERE workspace_id = $1 AND id = $2 AND firm_id = $3 AND status = 'active'",
    [context.scope.workspaceId, input.contactId, input.firmId],
  );
  if (contacts.length === 0) return refuse('contact_unknown');

  const version = await readSequenceVersion(context, input.sequenceVersionId);
  if (version === null) return refuse('version_unknown');
  if (version.state !== 'published') return refuse('version_not_published');
  if (version.steps.length === 0) return refuse('version_has_no_steps');
  if (!version.steps.every(step => isStepChannel(step.channel))) return refuse('step_unknown');

  const zone = firm.time_zone;
  if (zone === null) return refuse('firm_zone_unknown');

  let anchoredAt: string;
  if (input.previewAt === undefined) {
    anchoredAt = await databaseNow(context);
  } else {
    const parsed = Date.parse(input.previewAt);
    if (!Number.isFinite(parsed)) return refuse('invalid_input');
    anchoredAt = new Date(parsed).toISOString();
  }

  const calendar = await currentHolidayCalendar(context);
  const { rows: sequences } = await context.db.query<{ name: string }>(
    'SELECT name FROM sequences WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, version.sequenceId],
  );

  const steps: FollowUpPreviewStep[] = [];
  const schedule = scheduleOf(version.steps, anchoredAt, zone, calendar);
  for (const [index, step] of version.steps.entries()) {
    const planned = schedule[index];
    if (planned === undefined) continue;
    const email = step.channel === 'email';
    const template =
      email && step.templateVersionId !== null ? await readTemplateVersion(context, step.templateVersionId) : null;
    steps.push({
      ordinal: step.ordinal,
      channel: step.channel,
      templateVersionId: email ? step.templateVersionId : null,
      templateName: template?.name ?? null,
      subject: template?.subject ?? null,
      templateApproved: email ? template !== null && template.approvedAt !== null : null,
      dueAt: planned.dueAt,
      estimatedAt: planned.sendAt,
    });
  }

  return {
    ok: true,
    value: {
      sequenceVersionId: version.id,
      sequenceName: sequences[0]?.name ?? 'A sequence',
      version: version.version,
      firmTimeZone: zone,
      holidayCalendarVersion: calendar.version,
      anchoredAt,
      steps,
    },
  };
}

/** One step's place in a schedule: when it falls due, and when it is expected to happen. */
export interface PlannedStep {
  readonly ordinal: number;
  readonly dueAt: string;
  /** For an e-mail, the send window's placement of `dueAt`; for a call task, `dueAt`. */
  readonly sendAt: string;
}

/**
 * The schedule of a version started at `anchor`: the arithmetic enrolment and dispatch
 * use (`resolveStepDue`, then `placeEmailSend` for an e-mail), in one place, so the
 * preview and the command's re-check can never compute it two ways.
 */
export function scheduleOf(
  steps: readonly SequenceStepRow[],
  anchor: string,
  zone: string,
  calendar: WorkspaceHolidayCalendar,
): readonly PlannedStep[] {
  return steps.map(step => {
    const dueAt = resolveStepDue(stepForCadence(step), anchor, zone, calendar).dueAt;
    return {
      ordinal: step.ordinal,
      dueAt,
      sendAt: step.channel === 'email' ? placeEmailSend(dueAt, zone, { calendar }).sendAt : dueAt,
    };
  });
}

/** The basis of the preview the person was read, as the card carries it on the command. */
export interface PreviewBasis {
  readonly anchorAt: string;
  readonly timeZone: string;
  readonly calendarVersionId: string;
  readonly steps?: readonly { readonly ordinal: number; readonly sendAt: string }[] | undefined;
}

/**
 * Whether the schedule an enrolment started now would have is the schedule the person
 * was read (review of S3, round 2, P1-A): the same zone, the same calendar version, and
 * every step on the same local day in the firm's zone and within fifteen minutes of the
 * instant the card showed (`PREVIEW_DRIFT_TOLERANCE_MS`). `now` is the
 * transaction's sampled `now()`, which is the instant `enrollContact` anchors at in the
 * same transaction. A step missing from either side is a difference.
 */
export function previewBasisHolds(
  basis: PreviewBasis,
  current: {
    readonly steps: readonly SequenceStepRow[];
    readonly now: string;
    readonly zone: string | null;
    readonly calendar: WorkspaceHolidayCalendar;
  },
): boolean {
  if (current.zone === null || current.zone !== basis.timeZone) return false;
  if (current.calendar.version !== basis.calendarVersionId) return false;
  if (basis.steps === undefined) return true;
  const zone = current.zone;
  const schedule = scheduleOf(current.steps, current.now, zone, current.calendar);
  if (schedule.length !== basis.steps.length) return false;
  return schedule.every(planned => {
    const shown = basis.steps?.find(entry => entry.ordinal === planned.ordinal);
    return (
      shown !== undefined &&
      localParts(shown.sendAt, zone).date === localParts(planned.sendAt, zone).date &&
      Math.abs(Date.parse(shown.sendAt) - Date.parse(planned.sendAt)) <= PREVIEW_DRIFT_TOLERANCE_MS
    );
  });
}

/**
 * How far a step may drift from the instant the card showed and still be the step the
 * person agreed to: fifteen minutes, on the same local day in the firm's zone
 * (coordinator's rule, 30 September 2026). An hour-delay step drifts by exactly the time
 * between the preview and the recording, which is minutes; a day change — a window that
 * closed, a holiday, midnight — is a different date and is always stale.
 */
export const PREVIEW_DRIFT_TOLERANCE_MS = 15 * 60_000;
