import type { BlockedActionKind, HoldReasonCode } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold } from '../policy/holds.ts';
import { setManualControlMode } from '../crm/pipeline.ts';
import { recordSuppression, type SuppressionJournal } from '../suppression/index.ts';
import { recordDaySignal } from '../outbound/ramp.ts';
import { businessDateOf } from '../today/snapshots.ts';
import { classifyReply, type ReplyClassification } from '../src/rules/replyClassification.ts';
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
 * 12.2's "a direct Gmail send to a firm with an automated opportunity switches the
 * opportunity to manual ... in the import transaction" (Appendix G 19).
 */

/** Everything an automated step could do, held by a reply nobody has confirmed yet. */
const REPLY_HOLD_BLOCKS: readonly BlockedActionKind[] = Object.freeze([
  'email_send',
  'call_task',
  'linkedin_task',
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
  const targetKey = `${input.reasonCode}:${input.candidate.opportunityId}`;
  if (await effectRecorded(context, { messageId: input.messageId, kind: 'hold_opened', targetKey })) {
    return { kind: 'hold_opened', targetKey, applied: false };
  }
  const holdId = await openHold(context, {
    scopeKind: 'opportunity',
    scopeKey: input.candidate.opportunityId,
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

  // 12.4: "Every possibly relevant incoming message creates a hold before
  // classification can release anything." Human and uncertain both hold; the
  // difference between them is who may release it, not whether one exists.
  if (classification.class === 'human' || classification.class === 'uncertain') {
    for (const candidate of candidates) {
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
      const targetKey = `route:${candidate.opportunityId}`;
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
  if (classification.class === 'opt_out') {
    const address = message.headerFrom;
    if (address !== null) {
      const targetKey = `handle:${address}`;
      if (!(await effectRecorded(context, { messageId: message.id, kind: 'handle_suppressed', targetKey }))) {
        const recorded = await recordSuppression(context, {
          scope: 'handle',
          value: address,
          source: 'prospect_opt_out',
          commandId: `mail-message:${message.id}`,
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
          commandId: `mail-message:${message.id}:firm`,
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
  /** The opportunities switched to manual by this send. Empty when none was automated. */
  readonly switchedToManual: readonly string[];
}

/**
 * 12.2 and Appendix G 19: "A direct Gmail send to a firm with an automated
 * opportunity switches the opportunity to manual and stops current enrollments in the
 * import transaction."
 *
 * "Once" is the part the scenario names, and it is `mail_message_effects`'
 * uniqueness: the same outgoing message imported twice — a duplicate push, a
 * reconciliation pass — records one effect and calls `setManualControlMode` once.
 * `setManualControlMode` is itself idempotent, so even a lost race is harmless; the
 * effect row is what makes the count of *transitions* one.
 *
 * G7-2 calls this only for outgoing messages with no `outbound_messages` fence. Until
 * the fence exists, every outgoing message that matches is a direct send, which is
 * correct for G7-1 because FSS has not sent anything yet.
 */
export async function applyDirectSendEffects(
  context: RepositoryContext,
  input: { readonly message: MailMessageRow; readonly candidates: readonly MatchCandidate[] },
): Promise<DirectSendOutcome> {
  const switched: string[] = [];
  for (const candidate of input.candidates) {
    const targetKey = `opportunity:${candidate.opportunityId}`;
    if (await effectRecorded(context, { messageId: input.message.id, kind: 'direct_send_manual', targetKey })) {
      continue;
    }
    const outcome = await setManualControlMode(context, {
      opportunityId: candidate.opportunityId,
      reason: 'direct Gmail send by the salesperson',
      origin: 'direct_send',
    });
    if (!outcome.ok) continue;
    await recordEffect(context, {
      messageId: input.message.id,
      kind: 'direct_send_manual',
      targetKey,
      detail: { firmId: candidate.firmId },
    });
    switched.push(candidate.opportunityId);
  }
  return { switchedToManual: switched };
}

/**
 * Count one ramp signal against the mailbox's day (12.7, lane G15).
 *
 * The business date is the message's own `internal_date` in the workspace's zone,
 * because `mailbox_send_days.business_date` is a workspace-zone calendar and
 * `businessDateOf` is the one function that computes it — in PostgreSQL, so the answer
 * cannot differ from the one the send path wrote.
 *
 * `recordDaySignal` is a bare `UPDATE`, so a signal for a day the mailbox has no row
 * for counts nothing, and that is the right behaviour rather than a gap: a day with no
 * automated sends is not a sending day (`rampHealthFailure` returns `no_sends` for
 * one), so there is nothing for a bounce to be a proportion of. The cost is that a
 * bounce arriving after its day has been closed is not counted against it; the
 * decision record names it.
 */
async function countRampSignal(
  context: RepositoryContext,
  message: MailMessageRow,
  signal: 'bounce' | 'opt_out',
): Promise<void> {
  await recordDaySignal(context, {
    mailboxId: message.mailboxId,
    businessDate: await businessDateOf(context, message.internalDate),
    signal,
  });
}

/** Re-export so a caller needs one import for the deterministic layer. */
export { classifyReply };
export type { ReplyClassification };
