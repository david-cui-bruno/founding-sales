import type { RepositoryContext } from '../db/workspaceScope.ts';
import { attestedReleaseBinding } from '../release/records.ts';
import { effectiveSendingEnabled } from '../settings/effective.ts';
import { readSetting } from '../settings/store.ts';
import { firstSuppressed } from '../suppression/effective.ts';
import { localParts } from '../src/index.ts';
import { businessDateOf } from '../today/snapshots.ts';
import {
  dailyCapInForce,
  ensureRamp,
  openSendDay,
  readAccountHeadroom,
  type AccountHeadroom,
  type RampRow,
  type SendDayRow,
} from './ramp.ts';
import { decideStepPermission, dispatchHolidayCalendar, insideSendingWindow } from './stepPermission.ts';
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
 * window is re-derived from the firm's zone and the holiday calendars, the cap from the
 * ramp on the business date of the decision itself, and the step's whole permission —
 * suppression, control mode, the enrollment, every applicable hold, assignment, the
 * frozen route and its version, proven mailbox coverage, the frozen template's approval
 * — from `composeEligibility`, the one implementation the sequence engine also asks
 * (`stepPermission.ts`). All at the instant of the decision. Appendix G 3 and 6 are
 * precisely the case where something committed between the eligibility read and the
 * dispatch, and a gate that trusted an earlier answer would send after the reply
 * linearized.
 *
 * **It runs in the claiming transaction, under the send gate.** `send.ts` calls it
 * twice: once before the token refresh, to refuse early what can be refused early, and
 * once inside the transaction that claims the fence — after taking the send gate
 * shared and the fence and enrollment `FOR UPDATE` (lane g77). Every writer of a stop
 * fact takes that gate exclusive (`policy/sendGate.ts`), so a reply, a suppression or a
 * hold either committed before these reads — refusal — or cannot commit until the claim
 * has, which is the one ordering Appendix B accepts.
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
  /**
   * The digest of the worker image this process is running, as its bootstrap
   * discovered it (`discoverImageDigest`), or `unknown` (lane g71).
   *
   * 16.2's middle clause — "the deployed commit/image digests match the rehearsal
   * artifacts" — as a comparison: the release record the attestation names must pass
   * and must name *this* worker. An argument for the reason the deployment flag is one:
   * the process knows which image it is, and the domain does not go looking.
   *
   * Absent means **unknown**, and an unknown identity is a refusal
   * (`release_record_identity_unknown`), never a pass.
   */
  readonly workerImageDigest?: string | undefined;
}

export interface SendPlan {
  readonly fence: OutboundFenceRow;
  readonly mailbox: { readonly id: string; readonly address: string; readonly ownerUserId: string };
  readonly domain: SendingDomainRow;
  readonly ramp: RampRow;
  readonly day: SendDayRow;
  readonly cap: number;
  /** 12.7's operational headroom on the claim's business date (lane g87). */
  readonly account: AccountHeadroom;
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
  // The decision instant. Injected by tests and the drill, which pin the sending
  // window to a weekday morning; otherwise the database's clock at this statement,
  // which inside the claiming transaction is the claim itself (Appendix D: "fence
  // times ... Database UTC").
  const now = deps.now?.() ?? (await decisionInstant(context));

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

  // 11.2's re-read, whole (lane g77). The sequences lane's own eligibility — the
  // function that prepared this fence — asked again about the fence: suppression of
  // the contact, control mode, the enrollment, every applicable hold (4.2 and 12.6's
  // owner holds among them), assignment, the route this fence froze and its version
  // (12.3's bounce invalidates it), proven mailbox coverage rather than a `ready`
  // flag, and the approval of the template the bytes came from.
  const permission = await decideStepPermission(
    context,
    fence,
    { id: mailbox.id, ownerUserId: mailbox.owner_user_id },
    now,
  );
  if (!permission.ok) return permission;

  // ------------------------------------------------------------- not yet, then
  // 16.2: "Production sending remains disabled until all mandatory scenarios for the
  // affected release class pass, the deployed commit/image digests match the rehearsal
  // artifacts, and an authenticated admin enables sending."
  //
  // Two facts, ANDed by `effectiveSendingEnabled`, and this is the only place in FSS
  // that reads them before an irreversible action. A third follows them (lane g71):
  // the release record the attestation names binds to this worker's own digest. The
  // stored half is the admin's attestation carrying the `releaseGateReference` of the
  // rehearsal whose digests match; the argument is the deployment's own. It is
  // checked before the sending domain because it is the broader statement: a
  // workspace nobody has enabled must report that, not the state of its DNS records.
  const attestation = await readSetting(context, 'sending_enabled');
  if (!effectiveSendingEnabled(deps.deploymentSendingEnabled ?? false, attestation.value)) {
    return refuseSend(
      'workspace_sending_not_attested',
      // Which half said no, and never the reference itself: it names a rehearsal run,
      // which is operational detail an operator reads from the settings page.
      deps.deploymentSendingEnabled === true ? 'workspace' : 'deployment',
    );
  }
  // Lane g71: and the attestation binds to *this* worker. The record it names must be
  // stored, must have passed, and must name the image that is about to send. So a
  // worker deployed after the enable, from digests nobody rehearsed, holds every send
  // until somebody rehearses it and attests again — without anybody having to
  // remember to withdraw the old attestation. The detail is the binding's refusal
  // code, which says what to fix and still never names the reference.
  const binding = await attestedReleaseBinding(context, attestation.value, 'worker', deps.workerImageDigest);
  if (binding === null || !binding.ok) {
    return refuseSend('workspace_sending_not_attested', binding === null ? 'workspace' : binding.reason);
  }

  const domain = await readPrimarySendingDomain(context);
  if (domain === null) return refuseSend('sending_domain_unknown');
  if (!authenticationPasses(domain) || !domain.automatedSendingEnabled) {
    return refuseSend('automated_sending_disabled');
  }

  // 11.2, re-derived rather than trusted. The fence's `send_at` is the schedule; the
  // window is the licence, and a fence that sat in the queue overnight because of a
  // hold must not go out at 03:00 because its placement said so yesterday — nor on a
  // holiday because it was prepared the evening before one (lane g77: the placement
  // rule itself, holidays included, asked about this instant).
  const calendar = await dispatchHolidayCalendar(context, permission.value.enrollment);
  if (!insideSendingWindow(now, fence.sourceZone, calendar)) {
    return refuseSend('outside_email_window', `${fence.sourceZone} ${localParts(now.toISOString(), fence.sourceZone).date}`);
  }

  // 12.7 and Appendix D: the cap counts per workspace business date — the date of
  // *this* decision, which inside the claiming transaction is the date of the claim
  // (lane g77). The fence's `business_date` is the date its placement planned; a fence
  // held by yesterday's cap and sent today is today's send, and charging it to
  // yesterday would both spend a closed day and leave today's allowance untouched.
  //
  // The cap is the one in force *now* (lane g87, S06): a stored admin raise lifts it
  // only while the mailbox has finished the schedule and kept its last ten sending
  // days healthy, and otherwise the schedule governs today.
  const ramp = await ensureRamp(context, mailbox.id);
  const cap = await dailyCapInForce(context, ramp);
  const businessDate = await businessDateOf(context, now.toISOString());
  const day = await openSendDay(context, { mailboxId: mailbox.id, businessDate, cap });
  if (day.automatedSent >= cap) {
    return refuseSend('daily_cap', `automated ${String(day.automatedSent)}/${String(cap)}`);
  }

  // 12.7's operational headroom (lane g87, S07): every outgoing message of this
  // account, the person's own included, on today's business date and yesterday's,
  // against Google's per-account limit less the sync-lag reserve. The same refusal as
  // the cap, because it is the same kind of fact — this mailbox has sent enough for
  // now, and time lifts it — and the detail says which ceiling it was. `openSendDay`
  // above locked today's row inside the claim, so two claims read it in turn.
  const account = await readAccountHeadroom(context, { mailboxId: mailbox.id, businessDate, today: day });
  if (!account.allowed) {
    return refuseSend('daily_cap', `account ${String(account.used)}/${String(account.ceiling)}`);
  }

  // 12.6 (lane g87, S08): serialized across the workspace for a personal-Gmail
  // recipient, so a claim counts every send claimed before it — in doubt included —
  // and the next claim counts this one.
  const guard = await decideDomainGuard(context, {
    recipientAddress: fence.recipientAddress,
    domain,
    serialize: true,
  });
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
    account,
    guard,
  });
}

/**
 * The database's clock, now — `clock_timestamp()` rather than `now()`, because inside
 * the claiming transaction `now()` is the instant the transaction began, and the claim
 * may have waited on the send gate since.
 */
async function decisionInstant(context: RepositoryContext): Promise<Date> {
  const { rows } = await context.db.query<{ now: Date }>('SELECT clock_timestamp() AS now');
  const now = rows[0]?.now;
  if (now === undefined) throw new Error('the database did not answer with its clock');
  return now;
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
    // Lane g77: the step's own eligibility refused, so the blocker is already a hold
    // or a state somebody else owns. A second row here would be a hold nobody's
    // release matches.
    case 'step_ineligible':
      return null;
    default:
      return null;
  }
}
