import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listApplicableHolds } from '../policy/holds.ts';
import { effectiveSendingEnabled } from '../settings/effective.ts';
import { readSetting } from '../settings/store.ts';
import { firstSuppressed } from '../suppression/effective.ts';
import { EMAIL_WINDOW, localParts } from '../src/index.ts';
import { effectiveDailyCap, ensureRamp, openSendDay, type RampRow, type SendDayRow } from './ramp.ts';
import {
  authenticationPasses,
  decideDomainGuard,
  readPrimarySendingDomain,
  type DomainGuardDecision,
  type SendingDomainRow,
} from './domainGuard.ts';
import { refuseSend, acceptSend, type SendResult } from './types.ts';
import type { OutboundFenceRow } from './fence.ts';

/**
 * Everything that must be true before a fence may be dispatched (11.2, 12.6, 12.7,
 * 4.2, 9.2).
 *
 * This is the last check before an irreversible action, so it is deliberately
 * paranoid in three ways.
 *
 * **It re-reads everything.** Nothing here trusts a value the caller computed. The
 * window is re-derived from the firm's zone, the cap from the ramp, the suppression
 * from `effective_suppressions`, the holds from `active_holds` — all at the instant
 * of the send. Appendix G 3 and 6 are precisely the case where something committed
 * between the eligibility read and the dispatch, and a gate that trusted an earlier
 * answer would send after the reply linearized.
 *
 * **It runs in the dispatching transaction.** The caller holds the fence's attempt
 * token and has not yet called Gmail. So a suppression committing during the gate
 * either commits before these reads see it — refusal — or after the send, which is
 * the same instant ordering a human would accept.
 *
 * **Order matters, and cheapest-first is the wrong order.** The checks are ordered by
 * *consequence*: the ones that mean "this must never be sent to this person" come
 * before the ones that mean "not right now". A suppressed recipient who is also over
 * the daily cap should be reported as suppressed, because that is the fact somebody
 * needs to see.
 */

export interface SendGateDeps {
  /** Database time, so the window and the guard agree with the fence's timestamps. */
  readonly now?: (() => Date) | undefined;
  /**
   * 16.2's deployment half: this build's statement that the rehearsal gate passed on
   * the digests that are deployed.
   *
   * It is an argument rather than a configuration read for the reason
   * `effectiveSendingEnabled` is a pure rule: the fact belongs to the *process*, which
   * knows which image it is, and a domain function that went looking for it would be
   * reading an environment variable from inside a transaction.
   *
   * Absent means **false**. A caller that forgot to pass it gets a held send and a
   * refusal that names why, which is the conservative direction: the failure mode of
   * defaulting the other way is sending from an artifact nobody rehearsed.
   */
  readonly deploymentSendingEnabled?: boolean | undefined;
}

export interface SendPlan {
  readonly fence: OutboundFenceRow;
  readonly mailbox: { readonly id: string; readonly address: string; readonly ownerUserId: string };
  readonly domain: SendingDomainRow;
  readonly ramp: RampRow;
  readonly day: SendDayRow;
  readonly cap: number;
  readonly guard: DomainGuardDecision;
}

type MailboxRow = {
  id: string;
  owner_user_id: string;
  email_address: string;
  status: string;
  sync_state: string;
};

export async function decideSend(
  context: RepositoryContext,
  fence: OutboundFenceRow,
  deps: SendGateDeps = {},
): Promise<SendResult<SendPlan>> {
  const now = deps.now?.() ?? new Date();

  const mailboxRead = await context.db.query<MailboxRow>(
    'SELECT id, owner_user_id, email_address, status, sync_state FROM mailboxes WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, fence.mailboxId],
  );
  const mailbox = mailboxRead.rows[0];
  if (mailbox === undefined) return refuseSend('mailbox_unknown');
  if (mailbox.status !== 'connected') return refuseSend('mailbox_inactive');

  // ---------------------------------------------------------------- never send
  // 9.2, and the strongest refusal there is. A suppressed handle or firm is not a
  // scheduling problem.
  const suppressed = await firstSuppressed(context, [
    { scope: 'firm', canonicalKey: fence.firmId },
    { scope: 'handle', canonicalKey: fence.recipientAddress },
  ]);
  if (suppressed !== null) {
    return refuseSend(suppressed.scope === 'firm' ? 'firm_suppressed' : 'handle_suppressed');
  }

  // 12.3's bounce handling invalidates the frozen route. A fence whose route has
  // been invalidated or retired since preparation must not be sent to: the address
  // is known bad, and the hold on the step already says so.
  if (fence.recipientRouteId !== null) {
    const route = await context.db.query<{ eligibility: string; version: number }>(
      'SELECT eligibility, version FROM email_addresses WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, fence.recipientRouteId],
    );
    const eligibility = route.rows[0]?.eligibility;
    if (eligibility === undefined || eligibility === 'invalid' || eligibility === 'retired') {
      return refuseSend('route_invalid', eligibility ?? 'missing');
    }
  }

  // 4.2 and 12.6: every automated step kind is held while a mailbox's grant is
  // revoked or its coverage unproved, and the hold is on the owner.
  const holds = await listApplicableHolds(context, {
    actionKind: 'email_send',
    firmId: fence.firmId,
    ownerUserId: mailbox.owner_user_id,
    mailboxId: mailbox.id,
    ...(fence.opportunityId === null ? {} : { opportunityId: fence.opportunityId }),
    ...(fence.enrollmentId === null ? {} : { enrollmentId: fence.enrollmentId }),
  });
  if (holds.length > 0) {
    const first = holds[0];
    const reason = first?.reasonCode ?? 'coverage_incomplete';
    return refuseSend(
      reason === 'mailbox_disconnected'
        ? 'grant_revoked'
        : reason === 'coverage_incomplete'
          ? 'coverage_incomplete'
          : 'provider_refusal',
      reason,
    );
  }
  if (mailbox.sync_state !== 'ready') return refuseSend('coverage_incomplete', mailbox.sync_state);

  // ------------------------------------------------------------- not yet, then
  // 16.2: "Production sending remains disabled until all mandatory scenarios for the
  // affected release class pass, the deployed commit/image digests match the rehearsal
  // artifacts, and an authenticated admin enables sending."
  //
  // Two facts, ANDed by `effectiveSendingEnabled`, and this is the only place in FSS
  // that reads them before an irreversible action. The stored half is the admin's
  // attestation carrying the `releaseGateReference` of the rehearsal whose digests
  // match; the argument is the deployment's own. It is checked before the sending
  // domain because it is the broader statement: a workspace nobody has enabled must
  // report that, not the state of its DNS records.
  const attestation = await readSetting(context, 'sending_enabled');
  if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {
    return refuseSend(
      'workspace_sending_not_attested',
      // Which half said no, and never the reference itself: it names a rehearsal run,
      // which is operational detail an operator reads from the settings page.
      deps.deploymentSendingEnabled === true ? 'workspace' : 'deployment',
    );
  }

  const domain = await readPrimarySendingDomain(context);
  if (domain === null) return refuseSend('sending_domain_unknown');
  if (!authenticationPasses(domain) || !domain.automatedSendingEnabled) {
    return refuseSend('automated_sending_disabled');
  }

  // 11.2, re-derived rather than trusted. The fence's `send_at` is the schedule; the
  // window is the licence, and a fence that sat in the queue overnight because of a
  // hold must not go out at 03:00 because its placement said so yesterday.
  const local = localParts(now.toISOString(), fence.sourceZone);
  const insideWindow =
    local.weekday >= 1 &&
    local.weekday <= 5 &&
    local.minuteOfDay >= EMAIL_WINDOW.openMinute &&
    local.minuteOfDay < EMAIL_WINDOW.closeMinute;
  if (!insideWindow) return refuseSend('outside_email_window', `${fence.sourceZone} ${local.date}`);

  const ramp = await ensureRamp(context, mailbox.id);
  const cap = effectiveDailyCap(ramp);
  const businessDate = fence.businessDate ?? local.date;
  const day = await openSendDay(context, { mailboxId: mailbox.id, businessDate, cap });
  if (day.automatedSent >= cap) return refuseSend('daily_cap', `${String(day.automatedSent)}/${String(cap)}`);

  const guard = await decideDomainGuard(context, { recipientAddress: fence.recipientAddress, domain });
  if (!guard.allowed) {
    return refuseSend('domain_guard', `${String(guard.used)}/${String(guard.guard)}`);
  }

  return acceptSend({
    fence,
    mailbox: { id: mailbox.id, address: mailbox.email_address, ownerUserId: mailbox.owner_user_id },
    domain,
    ramp,
    day,
    cap,
    guard,
  });
}

/**
 * Which hold reason a refusal opens on the step, or null when the refusal is not a
 * hold at all.
 *
 * `domain_guard` maps to `domain_cap`, which is deliberately *not* in
 * `RECOVERABLE_HOLD_REASON_CODES`: 12.6 says reaching the guard "requires a reviewed
 * product-policy change", so no control may clear it early. It lifts when the rolling
 * window moves, which is a fact about time rather than a decision anybody makes.
 */
export function holdReasonForRefusal(
  reason: string,
): 'daily_cap' | 'domain_cap' | 'outside_email_window' | 'coverage_incomplete' | 'mailbox_disconnected' | 'route_invalid' | 'firm_suppressed' | 'handle_suppressed' | 'template_unapproved' | 'provider_refusal' | null {
  switch (reason) {
    case 'daily_cap':
      return 'daily_cap';
    case 'domain_guard':
      return 'domain_cap';
    case 'outside_email_window':
      return 'outside_email_window';
    case 'coverage_incomplete':
      return 'coverage_incomplete';
    case 'grant_revoked':
    case 'mailbox_inactive':
      return 'mailbox_disconnected';
    case 'route_invalid':
      return 'route_invalid';
    case 'firm_suppressed':
      return 'firm_suppressed';
    case 'handle_suppressed':
      return 'handle_suppressed';
    case 'template_unapproved':
    case 'template_mismatch':
      return 'template_unapproved';
    case 'rate_limited':
    case 'provider_refusal':
    case 'recipient_rejected':
      return 'provider_refusal';
    default:
      return null;
  }
}
