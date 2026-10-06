import { applyManualMeetingSend } from '../meetings/followThroughManual.ts';
import { interruptMeetingPlansForFirm } from '../meetings/followThroughLifecycle.ts';
import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/holds.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { recordCrmAuditEvent } from '../crm/audit.ts';
import { recordSuppression } from '../suppression/events.ts';
import type { SuppressionJournal } from '../suppression/journal.ts';
import { originatingSend } from '../outbound/fence.ts';
import { recordBounceAgainstDay, recordDaySignal } from '../outbound/ramp.ts';
import { stopEnrollments } from '../sequences/enrollments.ts';
import { consumeFulfilledByDirectSend } from '../sequences/followUpPermissions.ts';
import { businessDateOf } from '../today/snapshots.ts';
import { classifyReply, type ReplyClassification } from '../src/rules/replyClassification.ts';
import { DIRECT_SEND_QUIET_HOURS } from './directSendRecency.ts';
import { discardMessageBody } from './messages.ts';
import type { MatchCandidate } from './matching.ts';
import { replyItemKey, type ReplyPromoter } from './replyLane.ts';
import {
  DETERMINISTIC_RULES_VERSION,
  type MailEffectKind,
  type MailMessageRow,
} from './types.ts';

/**
 * What a classified message does (specification 12.3, 12.4, Appendix A, Appendix G 6,
 * 14, 15 and 19).
 *
 * This is the deterministic layer only. `classifyReply` in `@fss/domain` decides the
 * class from headers and authored text; this file decides what the database does
 * about it. G7b adds the LLM layer beside it — a second
 * `mail_message_classifications` row with `layer = 'model'`, which the database
 * refuses to let say anything but `uncertain` — and no effect in this file reads it.
 * That is the seam, and it is a CHECK constraint rather than a convention.
 *
 * Every effect is an insert into `mail_message_effects` keyed by
 * `(message, kind, target)`, so a replayed history page applies each one once. The
 * insert happens *with* the effect, in the same transaction, and the uniqueness is
 * what Appendix C means by protecting `mail.sync` with business uniqueness.
 *
 * The effects, by class:
 *
 * | Class | Effect |
 * |---|---|
 * | `human`, `uncertain` | Hold every automated action for each candidate opportunity; promote the reply lane. Manual mode only on a person's confirmation (12.4). |
 * | `bounce` | Invalidate the recipient route the originating message froze; hold the step. Never the reporting daemon's address. |
 * | `opt_out` | Suppress the handle immediately through G4's command, and the firm when there is exactly one candidate. |
 * | `automated` | Nothing is released. The body is discarded when it is an out-of-office. |
 *
 * An outgoing message FSS did not send is the fifth case and it is not a class at all:
 * a direct Gmail send. Since send-path v2 (David, 30 September 2026) it is an update to
 * the conversation, not a takeover — `applyDirectSendEffects` below.
 */

/** Everything an automated step could do, held by a reply nobody has confirmed yet. */
const REPLY_HOLD_BLOCKS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'enrollment_advance',
]);

export interface AppliedEffect {
  readonly kind: MailEffectKind;
  readonly targetKey: string;
  readonly holdId?: string | null | undefined;
  readonly suppressionEventId?: string | null | undefined;
  /** False when the effect was already recorded: a replay, not a second effect. */
  readonly applied: boolean;
}

/**
 * Record one effect, and say whether this call was the one that did it.
 *
 * `ON CONFLICT DO NOTHING` is what makes `mail.sync` safe to run twice. The caller
 * checks the answer before doing the irreversible part, so a suppression is recorded
 * once and a hold is opened once even when the page is replayed.
 */
async function recordEffect(
  context: RepositoryContext,
  input: {
    readonly messageId: string;
    readonly kind: MailEffectKind;
    readonly targetKey: string;
    readonly holdId?: string | null | undefined;
    readonly suppressionEventId?: string | null | undefined;
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
  },
): Promise<boolean> {
  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO mail_message_effects (workspace_id, mail_message_id, effect_kind, target_key,
                                       hold_id, suppression_event_id, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT ON CONSTRAINT mail_message_effects_one_per_target DO NOTHING
     RETURNING id`,
    [
      context.scope.workspaceId,
      input.messageId,
      input.kind,
      input.targetKey,
      input.holdId ?? null,
      input.suppressionEventId ?? null,
      JSON.stringify(input.detail ?? {}),
    ],
  );
  return rows[0] !== undefined;
}

/** Whether an effect of this kind and target is already recorded for this message. */
async function effectRecorded(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly kind: MailEffectKind; readonly targetKey: string },
): Promise<boolean> {
  const { rows } = await context.db.query<{ present: boolean }>(
    `SELECT true AS present FROM mail_message_effects
      WHERE workspace_id = $1 AND mail_message_id = $2 AND effect_kind = $3 AND target_key = $4`,
    [context.scope.workspaceId, input.messageId, input.kind, input.targetKey],
  );
  return rows[0]?.present === true;
}

/** Write the deterministic classification row. One per message; a replay is a no-op. */
export async function recordDeterministicClassification(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly classification: ReplyClassification },
): Promise<void> {
  await context.db.query(
    `INSERT INTO mail_message_classifications (workspace_id, mail_message_id, layer, class,
                                               suggested_disposition, signals, requires_confirmation,
                                               rules_version)
     VALUES ($1, $2, 'deterministic', $3, $4, $5::jsonb, $6, $7)
     ON CONFLICT ON CONSTRAINT mail_message_classifications_one_per_layer DO NOTHING`,
    [
      context.scope.workspaceId,
      input.messageId,
      input.classification.class,
      input.classification.suggestedDisposition,
      JSON.stringify(input.classification.signals),
      input.classification.requiresConfirmation,
      DETERMINISTIC_RULES_VERSION,
    ],
  );
}

export interface ClassificationEffectsInput {
  readonly message: MailMessageRow;
  readonly classification: ReplyClassification;
  readonly candidates: readonly MatchCandidate[];
  /** G4's object-locked journal. Every suppression is written to it before its row. */
  readonly journal: SuppressionJournal;
  readonly replyPromoter: ReplyPromoter;
}

export interface ClassificationEffects {
  readonly effects: readonly AppliedEffect[];
  readonly holdIds: readonly string[];
  readonly suppressionEventIds: readonly string[];
  /** True when a body was written and then removed: an out-of-office (12.4). */
  readonly bodyDiscarded: boolean;
}

async function holdCandidate(
  context: RepositoryContext,
  input: {
    readonly messageId: string;
    readonly candidate: MatchCandidate;
    readonly reasonCode: HoldReasonCode;
    readonly recoveryAction: string;
    readonly blocks?: readonly BlockedActionKind[] | undefined;
  },
): Promise<AppliedEffect> {
  const targetKey = `${input.reasonCode}:${input.candidate.opportunityId??input.candidate.outreachPlanId}`;
  if (await effectRecorded(context, { messageId: input.messageId, kind: 'hold_opened', targetKey })) {
    return { kind: 'hold_opened', targetKey, applied: false };
  }
  const holdId = await openHold(context, {
    scopeKind: input.candidate.opportunityId===null?'firm':'opportunity',
    scopeKey: input.candidate.opportunityId??input.candidate.firmId,
    reasonCode: input.reasonCode,
    blockedActionKinds: input.blocks ?? REPLY_HOLD_BLOCKS,
    sourceEventKind: 'mail_message',
    sourceEventId: input.messageId,
    recoveryAction: input.recoveryAction,
  });
  await recordEffect(context, {
    messageId: input.messageId,
    kind: 'hold_opened',
    targetKey,
    holdId,
    detail: { firmId: input.candidate.firmId, rule: input.candidate.rule },
  });
  return { kind: 'hold_opened', targetKey, holdId, applied: true };
}

/**
 * Apply every deterministic consequence of one classified incoming message.
 *
 * The order is the order in which a mistake would be least recoverable, so the
 * irreversible thing happens after the reversible one: the hold is opened before the
 * suppression is written, because a hold that turns out to be unnecessary is released
 * and a suppression is forever.
 */
export async function applyClassificationEffects(
  context: RepositoryContext,
  input: ClassificationEffectsInput,
): Promise<ClassificationEffects> {
  const effects: AppliedEffect[] = [];
  const holdIds: string[] = [];
  const suppressionEventIds: string[] = [];
  const { message, classification, candidates } = input;

  // Lane g77: every effect below is a stop fact or rides with one, so the send gate is
  // taken once, first. The order matters as much as the lock: a bounce counts against
  // the day's send counter *before* it opens its hold, and a claim holding the gate
  // waits on that counter — taking the gate here, ahead of the counter, is what keeps
  // the two from deadlocking (`policy/sendGate.ts`).
  await lockSendGateForStopFact(context);

  // 12.4: "Every possibly relevant incoming message creates a hold before
  // classification can release anything." Human and uncertain both hold; the
  // difference between them is who may release it, not whether one exists.
  if (classification.class === 'human' || classification.class === 'uncertain') {
    for (const candidate of candidates) {
      if(candidate.outreachPlanId!=null){
        await context.db.query("UPDATE outreach_plans SET state='reply_pending',revision=revision+1,updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='active'",[context.scope.workspaceId,candidate.outreachPlanId]);
      }
      await interruptMeetingPlansForFirm(context, { firmId: candidate.firmId, reason: 'reply_received', messageId: message.id, at: message.internalDate });
      const effect = await holdCandidate(context, {
        messageId: message.id,
        candidate,
        reasonCode: 'uncertain_reply',
        recoveryAction: 'confirm_reply',
      });
      effects.push(effect);
      if (effect.holdId !== undefined && effect.holdId !== null) holdIds.push(effect.holdId);
    }
  }

  // 12.4: "Bounces invalidate the prospect route frozen on the originating fence,
  // never the reporting daemon's address." The daemon is whoever sent the report —
  // `header_from` — and it is exactly the address this must not touch.
  if (classification.class === 'bounce') {
    // 12.7's ramp reads the day's bounces, and this is where a bounce is learned
    // about. Counted once per message: the guard below is per candidate, and a bounce
    // matched to two firms is one bounce from Gmail's point of view (lane G15).
    let counted = false;
    for (const candidate of candidates) {
      const targetKey = `route:${candidate.opportunityId??candidate.outreachPlanId}`;
      if (!(await effectRecorded(context, { messageId: message.id, kind: 'route_invalidated', targetKey }))) {
        if (!counted) {
          await countRampSignal(context, message, 'bounce');
          counted = true;
        }
        const invalidated = await invalidateBouncedRoute(context, {
          firmId: candidate.firmId,
          contactId: candidate.contactId,
          reportingAddress: message.headerFrom,
        });
        await recordEffect(context, {
          messageId: message.id,
          kind: 'route_invalidated',
          targetKey,
          // G8 reads this to record the originating email step as `no_email` (12.4).
          detail: { firmId: candidate.firmId, stepResult: 'no_email', addresses: invalidated },
        });
        effects.push({ kind: 'route_invalidated', targetKey, applied: true });
      }
      const held = await holdCandidate(context, {
        messageId: message.id,
        candidate,
        reasonCode: 'route_invalid',
        recoveryAction: 'resume_after_review',
        blocks: ['email_send'],
      });
      effects.push(held);
      if (held.holdId !== undefined && held.holdId !== null) holdIds.push(held.holdId);
    }
  }

  // 12.4: "Explicit deterministic opt-out language suppresses immediately." The
  // handle always; the firm only when there is exactly one candidate, because
  // "unambiguous" is what 12.3's ambiguity protocol means by one plausible firm.
  //
  // The command id names the message as Gmail knows it — the mailbox and Gmail's own
  // message id — and never the `mail_messages` row id (lane g59). The row id is
  // generated on insert, so after a restore the same opt-out, recovered from the inbox
  // by Appendix E step 4, is a new row with a new id: keyed on it, the recovery minted
  // a second event id for a suppression step 2 had already replayed from the journal,
  // recorded the opt-out twice, and had to append a second journal object — which the
  // drill identity cannot write, so step 4 could not reapply the opt-out at all. Keyed
  // on the provider identity, step 4 reaches the replayed event and records it once.
  const optOutCommand = `mail-message:${message.mailboxId}:${message.providerMessageId}`;
  if (classification.class === 'opt_out') {
    const address = message.headerFrom;
    if (address !== null) {
      const targetKey = `handle:${address}`;
      if (!(await effectRecorded(context, { messageId: message.id, kind: 'handle_suppressed', targetKey }))) {
        const recorded = await recordSuppression(context, {
          scope: 'handle',
          value: address,
          source: 'prospect_opt_out',
          // David's P2 (2 October 2026): an e-mail opt-out stops e-mail only.
          channel: 'email',
          commandId: optOutCommand,
          journal: input.journal,
        });
        if (recorded.ok) {
          // 12.7's other ramp signal, counted once per message for the same reason
          // the bounce is: the effect's own uniqueness is the guard (lane G15).
          await countRampSignal(context, message, 'opt_out');
          await recordEffect(context, {
            messageId: message.id,
            kind: 'handle_suppressed',
            targetKey,
            suppressionEventId: recorded.value.eventId,
          });
          suppressionEventIds.push(recorded.value.eventId);
          effects.push({
            kind: 'handle_suppressed',
            targetKey,
            suppressionEventId: recorded.value.eventId,
            applied: true,
          });
        }
      }
    }

    const only = candidates.length === 1 ? candidates[0] : undefined;
    if (only !== undefined) {
      const targetKey = `firm:${only.firmId}`;
      if (!(await effectRecorded(context, { messageId: message.id, kind: 'firm_suppressed', targetKey }))) {
        const recorded = await recordSuppression(context, {
          scope: 'firm',
          firmId: only.firmId,
          source: 'prospect_opt_out',
          // P2: the firm stop an unambiguous e-mail opt-out writes stops e-mail at the
          // firm, not calls (DESIGN-S3X §0.3).
          channel: 'email',
          commandId: `${optOutCommand}:firm`,
          journal: input.journal,
        });
        if (recorded.ok) {
          await recordEffect(context, {
            messageId: message.id,
            kind: 'firm_suppressed',
            targetKey,
            suppressionEventId: recorded.value.eventId,
          });
          suppressionEventIds.push(recorded.value.eventId);
          effects.push({
            kind: 'firm_suppressed',
            targetKey,
            suppressionEventId: recorded.value.eventId,
            applied: true,
          });
        }
      }
    }
  }

  // 12.4: "Automated messages are evidence, not proof that can release a stronger
  // human signal." Nothing is released; the row says so out loud so a later reader
  // does not have to infer it from an absence.
  if (classification.class === 'automated') {
    const targetKey = `message:${message.id}`;
    const applied = await recordEffect(context, {
      messageId: message.id,
      kind: 'no_effect',
      targetKey,
      detail: { class: 'automated', signals: classification.signals.map(signal => signal.rule) },
    });
    effects.push({ kind: 'no_effect', targetKey, applied });
  }

  // 12.4: "Out-of-office bodies are not retained." The rule that fired is kept in the
  // classification row; the words go.
  let bodyDiscarded = false;
  if (classification.signals.some(signal => signal.rule === 'vacation_pattern')) {
    await discardMessageBody(context, message.id);
    bodyDiscarded = true;
  }

  // Appendix A: the Today reply entry commits with the message and its holds. Every
  // class except `automated` puts the message in front of a person — a bounce and an
  // opt-out are both things the salesperson has to know about today.
  if (classification.class !== 'automated') {
    for (const candidate of candidates) {
      const targetKey = replyItemKey(message.id);
      if (await effectRecorded(context, { messageId: message.id, kind: 'reply_lane_entry', targetKey })) {
        continue;
      }
      await input.replyPromoter.promoteReply(context, {
        firmId: candidate.firmId,
        ...(candidate.contactId === null ? {} : { contactId: candidate.contactId }),
        messageId: message.id,
        receivedAt: message.internalDate,
      });
      await recordEffect(context, {
        messageId: message.id,
        kind: 'reply_lane_entry',
        targetKey,
        detail: { firmId: candidate.firmId, class: classification.class },
      });
      effects.push({ kind: 'reply_lane_entry', targetKey, applied: true });
    }
  }

  return { effects, holdIds, suppressionEventIds, bodyDiscarded };
}

/**
 * Mark the bounced prospect route invalid, and never the reporting daemon's.
 *
 * The addresses considered are the firm's own routes; the daemon's address is removed
 * explicitly rather than merely not being in the list, because a delivery-status
 * notification from a domain that is also a prospect's is exactly the case where "not
 * in the list" stops being true.
 */
async function invalidateBouncedRoute(
  context: RepositoryContext,
  input: {
    readonly firmId: string;
    readonly contactId: string | null;
    readonly reportingAddress: string | null;
  },
): Promise<readonly string[]> {
  const { rows } = await context.db.query<{ address: string }>(
    `UPDATE email_addresses
        SET eligibility = 'invalid',
            technical_validation = 'failed',
            version = version + 1,
            updated_at = now()
      WHERE workspace_id = $1
        AND firm_id = $2
        AND (contact_id IS NOT DISTINCT FROM $3 OR $3 IS NULL)
        AND eligibility IN ('candidate', 'usable')
        AND address IS DISTINCT FROM $4
      RETURNING address`,
    [context.scope.workspaceId, input.firmId, input.contactId, input.reportingAddress],
  );
  return rows.map(row => row.address);
}

export interface DirectSendOutcome {
  /**
   * True when this call recorded the conversation update. False on a replay, on a
   * message a historical `direct_send_manual` marker already processed, and on a message
   * whose match is not resolved to one opportunity.
   */
  readonly recorded: boolean;
  /** The verified To/Cc recipients at the matched firm, as contact ids. */
  readonly recipientContactIds: readonly string[];
  /** The one-message permissions this send fulfilled (`fulfilled_by_direct_send`). */
  readonly consumedPermissionIds: readonly string[];
  /** The enrollments this send ended `direct_send`: live prospecting, and the fulfilled ones. */
  readonly endedEnrollmentIds: readonly string[];
  /**
   * The next pending e-mail of each live agreed-sequence enrollment to a recipient,
   * pushed to at least `deferredUntil` (S1 review P1-4). The enrollments keep running.
   */
  readonly deferredExecutionIds: readonly string[];
  /** The message's send instant plus `DIRECT_SEND_QUIET_HOURS`; null when nothing was recorded. */
  readonly deferredUntil: string | null;
}

const NOT_RECORDED: DirectSendOutcome = Object.freeze({
  recorded: false,
  recipientContactIds: [],
  consumedPermissionIds: [],
  endedEnrollmentIds: [],
  deferredExecutionIds: [],
  deferredUntil: null,
});

/**
 * A direct Gmail send by the salesperson is an update to the conversation, not a
 * takeover (send-path v2, slice S1).
 *
 * David, 30 September 2026: *"My email should update the conversation, complete any
 * fulfilled request, and prevent duplicate follow-ups. It should not automatically
 * impose permanent manual takeover. The explicit 'I will handle this myself' control
 * still pauses automation."* So, for one outgoing message with no FSS fence, resolved to
 * one opportunity:
 *
 *   * **Control mode is not touched.** No `setManualControlMode`, no
 *     `control_mode_origin`, no `opportunity.manual_mode` event. A stored takeover
 *     (`salesperson_command`) is left exactly as it is and keeps blocking.
 *   * **Cold outreach to the firm ends.** Every live `prospecting` enrollment at the
 *     firm ends `direct_send`: the salesperson is now in a conversation with this firm,
 *     and a cold step after it would be the duplicate David named.
 *   * **A fulfilled request is complete.** Every unspent `single_email` or
 *     `contextual_reply` permission whose recipient is a verified To/Cc recipient of this
 *     message is consumed `fulfilled_by_direct_send`, and the enrollment bound to it ends
 *     `direct_send`. The recipients come from the message's own addresses through
 *     `email_addresses` at the matched firm — a match candidate's `contact_id` is not a
 *     recipient: a thread match carries whoever the thread first matched, and matching
 *     keeps one contact per opportunity.
 *   * **An agreed sequence keeps running, a day later.** `agreed_sequence` permissions
 *     and their enrollments are not ended: one hand-written e-mail does not end a
 *     programme the prospect agreed to. But the next pending e-mail of each such
 *     enrollment to a recipient waits `DIRECT_SEND_QUIET_HOURS` after this send, and the
 *     claim re-asks (S1 review P1-4), so the agreed e-mail is not a duplicate minutes
 *     after the salesperson's own.
 *
 * Everything happens under the exclusive send gate, taken first (as `logCallOutcome`
 * does), so a dispatch claim racing this effect is serialized with it: whichever holds the
 * gate first wins, and the other sees the consumed permission or the ended enrollment. A
 * claim that **committed** before this message was imported is not undone — the import
 * cannot see a message Gmail has not reported yet, and a dispatched fence is irreversible
 * (Appendix B). `docs/greenfield/decisions/follow-up-eligibility-20260929.md` §5 records
 * the boundary.
 *
 * Idempotent: one `direct_send_conversation` marker per message (`message:<id>`),
 * checked under the gate. A message that already carries a historical
 * `direct_send_manual` marker — the takeover this replaced — was processed then and is
 * not processed again. One audit row, of ids only.
 *
 * The caller asks only for a resolved match: an ambiguous import holds every candidate
 * (`recordMatches`) and this runs when a person resolves it (`resolveAmbiguity`).
 */
export async function applyDirectSendEffects(
  context: RepositoryContext,
  input: { readonly message: MailMessageRow; readonly candidate: MatchCandidate },
): Promise<DirectSendOutcome> {
  const { message, candidate } = input;
  await lockSendGateForStopFact(context);

  const { rows: processed } = await context.db.query<{ present: boolean }>(
    `SELECT true AS present FROM mail_message_effects
      WHERE workspace_id = $1 AND mail_message_id = $2
        AND effect_kind IN ('direct_send_conversation', 'direct_send_manual')
      LIMIT 1`,
    [context.scope.workspaceId, message.id],
  );
  if (processed[0]?.present === true) return NOT_RECORDED;

  // Call-to-booking A2, boundary (a): after a mailbox switch, the new account's own Sent
  // items from before the switch are that account's history, not the salesperson writing
  // to this firm through Callie's mailbox. An outgoing message whose Gmail internal date
  // is before the current account's `active_from` is never a direct send. A mailbox never
  // switched has no `mailbox_accounts` row and no bound. Nothing is recorded, so nothing
  // about the message is frozen either; inbound processing is not bounded at all.
  const sentAt = await exactInternalDate(context, message);
  if (await sentBeforeCurrentAccount(context, message.mailboxId, sentAt)) return NOT_RECORDED;

  const recipientContactIds = await verifiedRecipientContacts(context, {
    firmId: candidate.firmId,
    addresses: [...message.headerTo, ...message.headerCc],
  });

  await applyManualMeetingSend(context, { firmId: candidate.firmId, contactIds: recipientContactIds, message, at: sentAt });
  const ended: string[] = [];
  const { rows: prospecting } = await context.db.query<{ id: string }>(
    `SELECT id FROM sequence_enrollments
      WHERE workspace_id = $1 AND firm_id = $2 AND ended_at IS NULL AND origin_kind = 'prospecting'
        -- A2 boundary (c): a message ends only an enrollment that existed when it was sent.
        AND created_at <= $3::timestamptz
      ORDER BY id`,
    [context.scope.workspaceId, candidate.firmId, sentAt],
  );
  for (const enrollment of prospecting) {
    const stopped = await stopEnrollments(context, {
      enrollmentId: enrollment.id,
      reason: 'direct_send',
      cancelReason: 'direct_send',
    });
    ended.push(...stopped.enrollmentIds);
  }

  const consumed = await consumeFulfilledByDirectSend(context, {
    firmId: candidate.firmId,
    contactIds: recipientContactIds,
    sentAt,
  });
  const consumedPermissionIds = consumed.map(permission => permission.permissionId);
  if (consumedPermissionIds.length > 0) {
    const { rows: bound } = await context.db.query<{ id: string }>(
      `SELECT id FROM sequence_enrollments
        WHERE workspace_id = $1 AND ended_at IS NULL
          AND (permission_id = ANY ($2::uuid[]) OR id = ANY ($3::uuid[]))
          -- A2 boundary (c), as above.
          AND created_at <= $4::timestamptz
        ORDER BY id`,
      [
        context.scope.workspaceId,
        consumedPermissionIds,
        consumed.flatMap(permission => (permission.enrollmentId === null ? [] : [permission.enrollmentId])),
        sentAt,
      ],
    );
    for (const enrollment of bound) {
      const stopped = await stopEnrollments(context, {
        enrollmentId: enrollment.id,
        reason: 'direct_send',
        cancelReason: 'direct_send',
      });
      ended.push(...stopped.enrollmentIds);
    }
  }

  const endedEnrollmentIds = [...new Set(ended)].sort();

  // An agreed sequence keeps running, but not straight after the salesperson's own
  // e-mail to the same person (S1 review P1-4): the next pending e-mail of each live
  // agreed-sequence enrollment to a recipient waits until a day after this send. Never
  // earlier than it already was (`greatest`), and no hold: the step simply is not due
  // yet. The dispatch claim asks the same question for a fence already prepared.
  const { rows: deferred } = await context.db.query<{ id: string }>(
    `WITH agreed AS (
       SELECT n.id
         FROM sequence_enrollments AS n
         JOIN follow_up_permissions AS p ON p.workspace_id = n.workspace_id AND p.id = n.permission_id
        WHERE n.workspace_id = $1 AND n.firm_id = $2 AND n.ended_at IS NULL
          AND n.origin_kind = 'follow_up' AND p.scope = 'agreed_sequence'
          AND n.contact_id = ANY ($3::uuid[])
     ),
     next_email AS (
       SELECT DISTINCT ON (e.enrollment_id) e.id
         FROM step_executions AS e
         JOIN agreed AS a ON a.id = e.enrollment_id
        WHERE e.workspace_id = $1 AND e.channel = 'email' AND e.state IN ('pending', 'held')
        ORDER BY e.enrollment_id, e.ordinal
     )
     UPDATE step_executions AS s
        SET not_before = greatest(s.not_before, $4::timestamptz + make_interval(hours => $5)),
            updated_at = now()
       FROM next_email
      WHERE s.workspace_id = $1 AND s.id = next_email.id
      RETURNING s.id`,
    [context.scope.workspaceId, candidate.firmId, [...recipientContactIds], message.internalDate, DIRECT_SEND_QUIET_HOURS],
  );
  const deferredExecutionIds = deferred.map(row => row.id).sort();
  const deferredUntil = new Date(Date.parse(message.internalDate) + DIRECT_SEND_QUIET_HOURS * 3_600_000).toISOString();
  await recordEffect(context, {
    messageId: message.id,
    kind: 'direct_send_conversation',
    targetKey: `message:${message.id}`,
    detail: {
      firmId: candidate.firmId,
      opportunityId: candidate.opportunityId,
      recipientContactIds,
      consumedPermissionIds,
      endedEnrollmentIds,
      deferredExecutionIds,
      deferredUntil,
    },
  });
  // Ids only (5.2): the subject is the stored message row, never Gmail's id or the
  // RFC Message-ID, and no address, subject or body is in the detail.
  await recordCrmAuditEvent(context, {
    action: 'mail.direct_send_conversation',
    subjectKind: 'mail_message',
    subjectId: message.id,
    detail: {
      firmId: candidate.firmId,
      opportunityId: candidate.opportunityId,
      recipientContactIds,
      consumedPermissionIds,
      endedEnrollmentIds,
      deferredExecutionIds,
      deferredUntil,
    },
  });
  return {
    recorded: true,
    recipientContactIds,
    consumedPermissionIds,
    endedEnrollmentIds,
    deferredExecutionIds,
    deferredUntil,
  };
}

/**
 * The message's Gmail internal date exactly as stored, as text PostgreSQL reads back to
 * the same microsecond. Every boundary below compares against it without flooring
 * either side (review of 5015abd8, finding 7): "sent at or after X" is
 * `internal_date >= X`, so a message dated 12:00:00.123 is before a permission created
 * at 12:00:00.123900.
 */
async function exactInternalDate(context: RepositoryContext, message: MailMessageRow): Promise<string> {
  const { rows } = await context.db.query<{ at: string }>(
    'SELECT internal_date::text AS at FROM mail_messages WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, message.id],
  );
  return rows[0]?.at ?? message.internalDate;
}

/**
 * Whether an outgoing message predates the mailbox's current account (call-to-booking
 * A2): its Gmail internal date is before the open `mailbox_accounts` interval's
 * `active_from`. False when the mailbox has never been switched (no open row).
 */
async function sentBeforeCurrentAccount(context: RepositoryContext, mailboxId: string, sentAt: string): Promise<boolean> {
  const { rows } = await context.db.query<{ before: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM mailbox_accounts
        WHERE workspace_id = $1 AND mailbox_id = $2 AND active_until IS NULL
          AND $3::timestamptz < active_from
     ) AS before`,
    [context.scope.workspaceId, mailboxId, sentAt],
  );
  return rows[0]?.before === true;
}

/**
 * The firms a message's direct-send effect was already applied to, from either marker —
 * `direct_send_conversation`, or the historical `direct_send_manual` (S1 review P1-D).
 * Empty while no effect has been applied. Once it is not empty the message's candidate
 * set is frozen: a replay records no new match, and a resolution to any other firm is
 * refused.
 */
export async function directSendAppliedFirms(
  context: RepositoryContext,
  messageId: string,
): Promise<readonly string[]> {
  const { rows } = await context.db.query<{ firm_id: string | null }>(
    `SELECT DISTINCT detail->>'firmId' AS firm_id FROM mail_message_effects
      WHERE workspace_id = $1 AND mail_message_id = $2
        AND effect_kind IN ('direct_send_conversation', 'direct_send_manual')`,
    [context.scope.workspaceId, messageId],
  );
  // A marker whose detail names no firm still says "applied": it is kept as the empty
  // string, which matches no firm, so nothing may be re-pointed on the strength of it.
  return rows.map(row => row.firm_id ?? '');
}

/**
 * The contacts at this firm a message was addressed to, To and Cc, by their stored
 * addresses. A retired address is no longer the contact's, and an address that is one of
 * this workspace's own mailboxes is never a prospect's (`byParticipant`'s rule).
 */
async function verifiedRecipientContacts(
  context: RepositoryContext,
  input: { readonly firmId: string; readonly addresses: readonly string[] },
): Promise<readonly string[]> {
  if (input.addresses.length === 0) return [];
  const { rows } = await context.db.query<{ contact_id: string }>(
    `SELECT DISTINCT e.contact_id
       FROM email_addresses AS e
       JOIN contacts AS c ON c.workspace_id = e.workspace_id AND c.id = e.contact_id AND c.firm_id = e.firm_id
      WHERE e.workspace_id = $1
        AND e.firm_id = $2
        AND e.contact_id IS NOT NULL
        AND e.address = ANY ($3::text[])
        AND e.eligibility <> 'retired'
        AND NOT EXISTS (
          SELECT 1 FROM mailboxes AS b
           WHERE b.workspace_id = e.workspace_id AND b.email_address = e.address
        )
      ORDER BY e.contact_id`,
    [context.scope.workspaceId, input.firmId, [...new Set(input.addresses)]],
  );
  return rows.map(row => row.contact_id);
}

/**
 * Count one ramp signal against the day it belongs to (12.7, lanes G15 and G22).
 *
 * An opt-out is a fact about the moment a person asked, so it counts on the day it
 * arrived: the business date is the message's own `internal_date` in the workspace's
 * zone, computed by `businessDateOf` in PostgreSQL so it cannot differ from the date
 * the send path wrote. `recordDaySignal` is a bare `UPDATE`, so an opt-out on a day
 * with no automated sends counts nothing, which is right — a day with no sends is not
 * a sending day and there is nothing to be a proportion of.
 *
 * A **bounce is a fact about the send that caused it** (lane G22), and 12.7's
 * threshold is a rate over *that* day's automated sends. The report names the send in
 * its `In-Reply-To` and `References`; the fence holds the deterministic Message-ID and
 * the business date the cap counted the send against, so the two join and the bounce
 * lands on the right day even when it arrives the next morning. A day that has already
 * closed is re-judged on the new count and can take the ramp back —
 * `recordBounceAgainstDay` does that and says so.
 *
 * When the report names no fence — a daemon that sets neither header, a bounce of a
 * direct Gmail send that never had one — the arrival date is the honest fallback and
 * the behaviour is what it was before this lane. Named here so it is a known limit and
 * not a surprise.
 */
async function countRampSignal(
  context: RepositoryContext,
  message: MailMessageRow,
  signal: 'bounce' | 'opt_out',
): Promise<void> {
  if (signal === 'bounce') {
    const origin = await originatingSend(context, [
      ...(message.inReplyTo === null ? [] : [message.inReplyTo]),
      ...message.referenceMessageIds,
    ]);
    await recordBounceAgainstDay(
      context,
      origin === null
        ? {
            mailboxId: message.mailboxId,
            businessDate: await businessDateOf(context, message.internalDate),
          }
        : { mailboxId: origin.mailboxId, businessDate: origin.businessDate },
    );
    return;
  }
  await recordDaySignal(context, {
    mailboxId: message.mailboxId,
    businessDate: await businessDateOf(context, message.internalDate),
    signal,
  });
}

/** Re-export so a caller needs one import for the deterministic layer. */
export { classifyReply };
export type { ReplyClassification };
