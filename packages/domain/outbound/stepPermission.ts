import type { HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { WorkspaceHolidayCalendar } from '../src/rules/businessDays.ts';
import { placeEmailSend } from '../src/rules/sendingWindow.ts';
import { currentHolidayCalendar, holidayCalendarByVersion } from '../sequences/calendars.ts';
import { CHANNEL_ACTION_KINDS, composeEligibility, suppressionSource, type StepEligibilityInput } from '../sequences/eligibility.ts';
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
  mailbox: { readonly id: string; readonly ownerUserId: string; readonly kind: string },
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
  // The fence and the enrollment must name the same **person**, and the fence's route
  // must be that person's own address (GPT-6 review of PR 332, P0-2). Every fence the
  // sequence engine prepares takes its contact from its enrollment and its route from
  // that contact, so a mismatch is not a state the product produces; before this check
  // it was a state nothing refused, and a permission granted about one person could
  // have addressed another at the same firm.
  if (fence.contactId !== null && fence.contactId !== enrollment.contactId) {
    return refuseSend('step_ineligible', 'contact_mismatch');
  }
  if (execution.contactId !== enrollment.contactId) {
    return refuseSend('step_ineligible', 'execution_contact_mismatch');
  }
  const route = await routeOfFence(context, fence);
  if (route === null) return refuseSend('route_invalid', 'frozen_route_gone');
  if (route.contactId !== enrollment.contactId) return refuseSend('step_ineligible', 'route_owner_mismatch');
  if (route.address !== fence.recipientAddress) {
    return refuseSend('step_ineligible', 'recipient_address_mismatch');
  }
  // And the bytes: the fence's frozen template version must be the one **its own step**
  // names (P0-2 of the second review of PR 332). The permission binds the bytes for a
  // `single_email`, and for an `agreed_sequence` David's agreed scope is *the published
  // version's steps* — so the step's template is the agreed template, and a fence frozen
  // on some other approved template is bytes nobody agreed to whatever the scope is.
  // `templateApprovalSource` only asks whether the frozen template is approved, which a
  // swapped-in approved template also is.
  const stepTemplateVersionId = await templateOfStep(context, execution.stepId);
  if (stepTemplateVersionId !== null && fence.templateVersionId !== stepTemplateVersionId) {
    return refuseSend('step_ineligible', 'template_not_the_step’s');
  }

  const input: StepEligibilityInput = {
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
  };

  // Contact-wide suppression first, before the cold-outreach refusal below (review of
  // slice S4, P2-a). `decideSend` has checked the firm and the fence's own recipient
  // address, but an opt-out recorded on *another* address of the same person is only
  // seen by `suppressionSource`, and it is the fact that must be reported: a person who
  // asked to stop must never be shown as merely waiting for a mailbox. The composition
  // asks the same source again first; asking it here as well costs one statement.
  const suppression = await suppressionSource().evaluate(context, input);
  if (!suppression.ok) return refuseSend(sendRefusalForIneligibility(suppression.reasonCode), suppression.reasonCode);

  // The dispatch path's own question about this fence (send-path v2, slice S4): a
  // prospecting e-mail does not leave through Gmail, whatever the mailbox is labelled.
  // Asked before the rest of the composition, beside the other fence-against-enrollment
  // checks, because it is about the fence and the path rather than about the step: the
  // composition's `coldOutreachTransportSource` asks the step's half.
  const coldOutreach = coldOutreachDispatchRefusal(enrollment, mailbox);
  if (coldOutreach !== null) return refuseSend('step_ineligible', coldOutreach);

  const outcome = await composeEligibility().evaluate(context, input);
  if (!outcome.ok) {
    const detail = outcome.detail === undefined ? outcome.reasonCode : `${outcome.reasonCode}:${outcome.detail}`;
    return refuseSend(sendRefusalForIneligibility(outcome.reasonCode), detail);
  }
  return acceptSend({ execution, enrollment });
}

/**
 * Why this fence may not leave through the Gmail dispatch path as cold outreach, or null
 * (send-path v2, slice S4; David, 30 September 2026: "creating an enrollment must not
 * enable cold Gmail outreach").
 *
 * `decideStepPermission` is reached only from `decideSend`, and `decideSend` only from
 * `outbound/send.ts`, whose one external call is `gmail.sendMessage`. So every fence
 * asked about here is on the Gmail dispatch path, and every fence is an e-mail. The rule
 * is therefore "this is the Gmail path and the enrollment is prospecting" — and **not**
 * "the fence's mailbox is not a cold-outreach mailbox": migration 0026 admits the kind
 * `cold_outreach` as a label, and a label must never authorise Gmail as cold outreach
 * (P0-5 of the plan review). The mailbox's kind is read only to be named in the detail,
 * so an operator reading a held fence sees which mailbox it would have left through.
 *
 * Under the send gate, inside the claiming transaction (`send.ts`'s `recheckAndClaim`),
 * so a prepared fence — one prepared before this rule existed, or held and returning
 * through dispatch — is refused before the claim, and Gmail is never asked.
 *
 * `step_ineligible` rather than a refusal of its own: `holdReasonForRefusal` opens no
 * `active_holds` row for it. The detail starts with `cold_outreach_mailbox_required`,
 * the shape every eligibility refusal already takes here, and the worker's hand-off
 * (`refusalFor` in `apps/worker/src/handlers/outboundSendHandoff.ts`) turns that first
 * code into the step's hold because it is in `SEND_HANDOFF_REFUSALS` — so a prepared or
 * resumed fence refused here leaves its step held with the same reason the eligibility
 * source gives, not `scoped_pause`.
 *
 * Contact-wide suppression is asked before this (`decideStepPermission`): an opt-out
 * on another address of the same person is reported as the suppression, never as this.
 */
export function coldOutreachDispatchRefusal(
  enrollment: Pick<EnrollmentRow, 'originKind'>,
  mailbox: { readonly kind: string },
): string | null {
  if (enrollment.originKind !== 'prospecting') return null;
  return `cold_outreach_mailbox_required:gmail_dispatch:${mailbox.kind}`;
}

/**
 * The address a fence froze, and whose it is.
 *
 * `frozenRouteOutcome` in `sequences/eligibility.ts` asks whether the route is usable at
 * the version the fence named; it does not ask *whose* it is or what it reads. Both are
 * this function's, because the fence's `recipient_address` is the string that actually
 * reaches Gmail, and an address that is no longer the route's — a correction, a merge —
 * is bytes addressed to somebody the permission never named.
 */
/**
 * The template version one step names, or null for a step that names none (a call task).
 *
 * `sequence_steps` is immutable once its version is published, so this is the agreed
 * bytes for every scope: the enrollment runs one published version, and the permission
 * was granted about that version's steps.
 */
async function templateOfStep(context: RepositoryContext, stepId: string): Promise<string | null> {
  const { rows } = await context.db.query<{ template_version_id: string | null }>(
    'SELECT template_version_id FROM sequence_steps WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, stepId],
  );
  return rows[0]?.template_version_id ?? null;
}

async function routeOfFence(
  context: RepositoryContext,
  fence: OutboundFenceRow,
): Promise<{ readonly contactId: string; readonly address: string } | null> {
  if (fence.recipientRouteId === null) return null;
  const { rows } = await context.db.query<{ contact_id: string; address: string }>(
    'SELECT contact_id, address FROM email_addresses WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, fence.recipientRouteId],
  );
  const row = rows[0];
  return row === undefined ? null : { contactId: row.contact_id, address: row.address };
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
