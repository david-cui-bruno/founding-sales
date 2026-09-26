import type { HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { placeEmailSend } from '../src/rules/sendingWindow.ts';
import { currentHolidayCalendar, holidayCalendarByVersion } from '../sequences/calendars.ts';
import { CHANNEL_ACTION_KINDS, composeEligibility } from '../sequences/eligibility.ts';
import { readEnrollment, readStepExecution } from '../sequences/rows.ts';
import type { EnrollmentRow, StepExecutionRow } from '../sequences/types.ts';
import type { OutboundFenceRow } from './fence.ts';
import { acceptSend, refuseSend, type SendRefusalCode, type SendResult } from './types.ts';

/**
 * The step's whole permission to send, re-asked for a prepared fence immediately
 * before the dispatch claim (specification 11.2, 7.3, 12.2, 12.4).
 *
 * 11.2: "Before every external action, the worker re-reads inside the claiming
 * transaction: control mode; applicable holds; effective suppressions; ownership;
 * route eligibility and version; mailbox health and coverage; template approval;
 * policy; limits; time window; and prerequisites."
 *
 * A reply confirmed between the preparation and the dispatch sets the opportunity
 * manual and ends the enrollment, and the fence it left behind must not go. So the
 * gate asks the sequences lane's own composition,
 * `composeEligibility`, which is the function `runDueStepExecution` asked when it
 * prepared the fence: one implementation, asked twice, with the fence's frozen
 * envelope the only thing the second asking adds (`FrozenEnvelope`).
 *
 * The fence and the enrollment must also still describe the same work. Every fence the
 * sequence engine prepares takes its firm, opportunity and owner from its enrollment,
 * so a mismatch is not a state the product produces; it is refused rather than
 * explained, because a send is the one thing that cannot be taken back.
 */

export interface StepPermission {
  readonly execution: StepExecutionRow;
  readonly enrollment: EnrollmentRow;
}

/**
 * Ask the authoritative eligibility about one fence.
 *
 * `mailbox` is the fence's own mailbox — the one that would send. The enrollment's
 * owner must be its owner: a firm reassigned after the fence was prepared keeps its
 * *dispatching* mail with the former mailbox (Appendix A), but a fence that has not
 * been claimed yet belongs to nobody's mailbox any more.
 */
export async function decideStepPermission(
  context: RepositoryContext,
  fence: OutboundFenceRow,
  mailbox: { readonly id: string; readonly ownerUserId: string },
  now: Date,
): Promise<SendResult<StepPermission>> {
  if (fence.originKind !== 'step_execution' || fence.stepExecutionId === null) {
    return refuseSend('step_ineligible', 'no_step_execution');
  }
  const execution = await readStepExecution(context, fence.stepExecutionId);
  if (execution === null) return refuseSend('step_ineligible', 'execution_missing');
  if (fence.enrollmentId !== null && fence.enrollmentId !== execution.enrollmentId) {
    return refuseSend('step_ineligible', 'enrollment_mismatch');
  }
  const enrollment = await readEnrollment(context, { enrollmentId: execution.enrollmentId });
  if (enrollment === null) return refuseSend('step_ineligible', 'enrollment_missing');
  if (enrollment.firmId !== fence.firmId) return refuseSend('step_ineligible', 'firm_mismatch');
  if (fence.opportunityId !== null && fence.opportunityId !== enrollment.opportunityId) {
    return refuseSend('step_ineligible', 'opportunity_mismatch');
  }
  if (enrollment.assignedUserId !== mailbox.ownerUserId) return refuseSend('step_ineligible', 'reassignment');

  const outcome = await composeEligibility().evaluate(context, {
    execution,
    opportunityId: enrollment.opportunityId,
    firmId: fence.firmId,
    // The fence's own contact: its recipient is one of that contact's routes, and a
    // handle suppression covers "every email address of this contact".
    contactId: fence.contactId ?? enrollment.contactId,
    ownerUserId: enrollment.assignedUserId,
    channel: 'email',
    actionKind: CHANNEL_ACTION_KINDS.email,
    now: now.toISOString(),
    frozen: {
      routeId: fence.recipientRouteId,
      routeVersion: fence.recipientRouteVersion,
      templateVersionId: fence.templateVersionId,
    },
  });
  if (!outcome.ok) {
    const detail = outcome.detail === undefined ? outcome.reasonCode : `${outcome.reasonCode}:${outcome.detail}`;
    return refuseSend(sendRefusalForIneligibility(outcome.reasonCode), detail);
  }
  return acceptSend({ execution, enrollment });
}

/**
 * One of section 15's hold reasons as the sending lane's refusal.
 *
 * The codes that have a refusal of their own keep it — suppression, coverage, the
 * template, the route family, and a disconnected mailbox as `grant_revoked` — so an
 * operator reading a held fence sees the word the step would have shown. Everything
 * else — a reply's hold, a pause, manual mode, a stopped enrollment, a reassignment —
 * is `step_ineligible`, with the section 15 code as the detail, never a
 * provider-shaped refusal: Gmail was never asked anything. `holdReasonForRefusal` opens
 * no hold for `step_ineligible`, because the thing blocking the step is already
 * somebody's hold or state, and 4.3's "clearing one hold never clears another" needs
 * there to be one.
 */
export function sendRefusalForIneligibility(code: HoldReasonCode): SendRefusalCode {
  switch (code) {
    case 'firm_suppressed':
    case 'handle_suppressed':
    case 'coverage_incomplete':
    case 'template_unapproved':
      return code;
    case 'mailbox_disconnected':
      return 'grant_revoked';
    case 'route_missing':
    case 'route_candidate':
    case 'route_invalid':
    case 'route_retired':
      return 'route_invalid';
    default:
      return 'step_ineligible';
  }
}

/**
 * The holidays a send on this enrollment's behalf must not fall on (11.2, Appendix D;
 * S09).
 *
 * Both calendars, and deliberately: the version the enrollment froze *and* the
 * workspace's current one. The frozen version exists so that a supersession does not
 * re-time a cadence halfway through — it is about *when work is due*. The dispatch
 * window is a different question, *whether today is a sending day at all*, and it is a
 * licence rather than a schedule. A holiday an administrator added this morning is a
 * day nobody wants email to go out, whichever calendar the step was planned under; a
 * holiday removed since the enrollment began was a day the step's own placement already
 * skipped, so honouring it costs at most the one day. The union refuses in both cases,
 * which is the direction a send that cannot be taken back should err in.
 */
export async function dispatchHolidayCalendar(
  context: RepositoryContext,
  enrollment: EnrollmentRow,
): Promise<WorkspaceHolidayCalendar> {
  const frozen = await holidayCalendarByVersion(context, enrollment.holidayCalendarVersion);
  const current = await currentHolidayCalendar(context);
  const dates = [...new Set([...frozen.dates, ...current.dates])].sort();
  return { version: `${frozen.version}+${current.version}`, dates };
}

/**
 * Whether `now` is inside 11.2's window in the fence's zone, on a sending day.
 *
 * `placeEmailSend` is the placement rule `runEmailStep` used to put the step where it
 * is; asking it about the dispatch instant is asking the same rule, holidays included,
 * whether that instant is a place a send may be, so a fence held overnight on the eve
 * of a holiday does not go out on it.
 */
export function insideSendingWindow(now: Date, zone: string, calendar: WorkspaceHolidayCalendar): boolean {
  return placeEmailSend(now.toISOString(), zone, { calendar }).inPlace;
}
