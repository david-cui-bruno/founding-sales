import type { HoldReasonCode } from '@fss/contracts';
import { isRecoverableHoldReason, knownBlockedActionKinds } from '@fss/contracts';
import { decideFirmRead } from '../crm/authorization.ts';
import { readContact } from '../crm/contacts.ts';
import { readFirm } from '../crm/firms.ts';
import { readOpportunity } from '../crm/pipeline.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { listMatches } from '../mail/matching.ts';
import { readMessage, readMessageBody } from '../mail/messages.ts';
import type { ReplyDisposition } from '../src/rules/replyClassification.ts';
import { listClassifications, proposedDispositionOf, type ClassificationRow } from './store.ts';
import { readConfirmation, type ReplyConfirmationRow } from './confirmations.ts';

/**
 * The reply card (specification 8.3, Appendix F).
 *
 * "A reply card contains the message, source contact, firm-wide impact,
 * deterministic signals, proposed LLM disposition, confidence, supporting excerpt,
 * and suggested next action."
 *
 * The card is a *read*. It performs nothing and it decides nothing; `nextAction` is
 * the name of a command a person may choose to run, and the list of commands it may
 * name is closed. That is 8.3's last paragraph made structural: the card cannot
 * offer to close an opportunity or record a suppression, because the shape it
 * returns has no way to say so.
 *
 * ## What the two layers contribute
 *
 * The deterministic row gives the class, the signals, and — when it proved something
 * — the disposition. The model row gives a disposition, a confidence and an excerpt,
 * and gives no class at all: `mail_message_classifications_model_cannot_decide` sees
 * to it that the column says `uncertain`, and the suggested class survives as the
 * `model_class` signal, which the card shows as a signal and never as the answer.
 *
 * `proposedDisposition` therefore reads: the deterministic layer's if it has one
 * (it only has one when it proved something), otherwise the model's, otherwise null.
 * `proposedBy` says which, and the confirmation records it, so 12.4's "a corrected
 * classification is audited" can distinguish a person correcting a rule from a
 * person correcting a model.
 *
 * ## Visibility
 *
 * Appendix F puts message bodies in the assigned-salesperson-or-admin row. A member
 * who is neither gets the envelope, the class and the firm-wide impact — enough to
 * know the firm is held and why — and no body, no excerpt and no subject. The
 * excerpt is a quotation from the body and is redacted with it; a card that redacted
 * the body and printed a sentence of it would be the same leak with more steps.
 */

export const REPLY_NEXT_ACTIONS = [
  'confirm_disposition',
  'resolve_ambiguity',
  'review_bounce',
  'nothing_to_do',
] as const;
export type ReplyNextAction = (typeof REPLY_NEXT_ACTIONS)[number];

export interface ReplyCardHoldDto {
  readonly holdId: string;
  readonly opportunityId: string;
  readonly reasonCode: HoldReasonCode;
  readonly blockedActionKinds: readonly string[];
  readonly recoveryAction: string | null;
  readonly recoverable: boolean;
  readonly startedAt: string;
}

export interface ReplyCardSignalDto {
  readonly rule: string;
  readonly evidence: string;
  readonly layer: 'deterministic' | 'model';
}

export interface ReplyCardCandidateDto {
  readonly opportunityId: string;
  readonly firmId: string;
  readonly firmName: string;
  readonly selected: boolean | null;
}

export interface ReplyCardDto {
  readonly messageId: string;
  readonly receivedAt: string;
  readonly from: string | null;
  readonly subject: string | null;
  /** Null for a member who may not read bodies, and for an out-of-office (12.4). */
  readonly body: { readonly text: string; readonly truncated: boolean } | null;
  readonly firmId: string;
  readonly firmName: string;
  readonly opportunityId: string;
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly contactTitle: string | null;
  /** 8.3's "firm-wide impact". */
  readonly impact: {
    readonly controlMode: 'automated' | 'manual';
    readonly holds: readonly ReplyCardHoldDto[];
    readonly ambiguous: boolean;
    readonly candidates: readonly ReplyCardCandidateDto[];
    readonly contactsAtFirm: number;
  };
  readonly deterministicClass: string;
  readonly signals: readonly ReplyCardSignalDto[];
  readonly proposedDisposition: ReplyDisposition | null;
  readonly proposedBy: 'deterministic' | 'model' | 'none';
  readonly confidence: number | null;
  readonly supportingExcerpt: string | null;
  readonly callbackProposal: { readonly localDateTime: string; readonly timeZone: string | null } | null;
  readonly modelName: string | null;
  readonly promptVersion: string | null;
  /** True until a person has answered. 12.4: every possibly relevant message holds. */
  readonly requiresConfirmation: boolean;
  readonly confirmation: ReplyConfirmationRow | null;
  readonly nextAction: ReplyNextAction;
  readonly visibility: 'assigned_or_admin' | 'any_active_member';
}

interface HoldDbRow {
  readonly id: string;
  readonly scope_key: string;
  readonly reason_code: HoldReasonCode;
  readonly blocked_action_kinds: string[];
  readonly recovery_action: string | null;
  readonly started_at: Date;
  readonly [column: string]: unknown;
}

/** The open holds this message opened, whichever opportunity they are on. */
async function holdsOfMessage(
  context: RepositoryContext,
  messageId: string,
): Promise<readonly ReplyCardHoldDto[]> {
  const { rows } = await context.db.query<HoldDbRow>(
    `SELECT id, scope_key, reason_code, blocked_action_kinds, recovery_action, started_at
       FROM active_holds
      WHERE workspace_id = $1
        AND released_at IS NULL
        AND source_event_id = $2
        AND source_event_kind IN ('mail_message', 'mail_message_resolution')
      ORDER BY started_at, id`,
    [context.scope.workspaceId, messageId],
  );
  return rows.map(row => ({
    holdId: row.id,
    opportunityId: row.scope_key,
    reasonCode: row.reason_code,
    blockedActionKinds: knownBlockedActionKinds(row.blocked_action_kinds),
    recoveryAction: row.recovery_action,
    recoverable: isRecoverableHoldReason(row.reason_code),
    startedAt: row.started_at.toISOString(),
  }));
}

async function contactsAtFirm(context: RepositoryContext, firmId: string): Promise<number> {
  const { rows } = await context.db.query<{ total: string }>(
    "SELECT count(*)::text AS total FROM contacts WHERE workspace_id = $1 AND firm_id = $2 AND status = 'active'",
    [context.scope.workspaceId, firmId],
  );
  return Number(rows[0]?.total ?? '0');
}

function signalsOf(rows: readonly ClassificationRow[]): readonly ReplyCardSignalDto[] {
  const seen = new Set<string>();
  const signals: ReplyCardSignalDto[] = [];
  for (const layer of ['deterministic', 'model'] as const) {
    for (const signal of rows.find(row => row.layer === layer)?.signals ?? []) {
      const key = `${layer}:${signal.rule}`;
      if (seen.has(key)) continue;
      seen.add(key);
      signals.push({ rule: signal.rule, evidence: signal.evidence, layer });
    }
  }
  return signals;
}

/**
 * Which command the card offers.
 *
 * Closed, and in this order. An unresolved ambiguity outranks everything: 12.3 says
 * resolution picks the conversation, and confirming a disposition against one of
 * several plausible opportunities would be confirming it against a guess. A bounce
 * is a review rather than a disposition — nobody wrote it. A message a person has
 * already answered has nothing left to offer.
 */
function nextActionFor(input: {
  readonly ambiguousUnresolved: boolean;
  readonly deterministicClass: string;
  readonly confirmed: boolean;
}): ReplyNextAction {
  if (input.ambiguousUnresolved) return 'resolve_ambiguity';
  if (input.confirmed) return 'nothing_to_do';
  if (input.deterministicClass === 'bounce') return 'review_bounce';
  if (input.deterministicClass === 'automated') return 'nothing_to_do';
  return 'confirm_disposition';
}

export async function readReplyCard(
  context: RepositoryContext,
  input: { readonly messageId: string },
): Promise<ReplyCardDto | null> {
  const message = await readMessage(context, input.messageId);
  if (message === null) return null;

  const matches = await listMatches(context, input.messageId);
  if (matches.length === 0) return null;
  const chosen = matches.find(match => match.selected === true) ?? matches[0];
  if (chosen === undefined) return null;

  const firm = await readFirm(context, chosen.firmId);
  if (firm === null) return null;
  const visibility = decideFirmRead(context, firm);
  const opportunity = await readOpportunity(context, chosen.opportunityId);
  const contact = chosen.contactId === null ? null : await readContact(context, chosen.contactId);

  const classifications = await listClassifications(context, input.messageId);
  const deterministic = classifications.find(row => row.layer === 'deterministic');
  const model = classifications.find(row => row.layer === 'model');
  const confirmation = await readConfirmation(context, input.messageId);

  const candidates: ReplyCardCandidateDto[] = [];
  for (const match of matches) {
    const candidateFirm = match.firmId === firm.id ? firm : await readFirm(context, match.firmId);
    candidates.push({
      opportunityId: match.opportunityId,
      firmId: match.firmId,
      firmName: candidateFirm?.name ?? '',
      selected: match.selected,
    });
  }
  const ambiguousUnresolved = matches.length > 1 && matches.every(match => match.selected === null);

  const proposal = proposedDispositionOf(deterministic, model);

  const readable = visibility === 'assigned_or_admin';
  const body = readable && !message.metadataOnly ? await readMessageBody(context, input.messageId) : null;

  return {
    messageId: message.id,
    receivedAt: message.internalDate,
    from: message.headerFrom,
    subject: readable ? message.subject : null,
    body,
    firmId: firm.id,
    firmName: firm.name,
    opportunityId: chosen.opportunityId,
    contactId: chosen.contactId,
    contactName: readable ? (contact?.full_name ?? null) : null,
    contactTitle: readable ? (contact?.title ?? null) : null,
    impact: {
      controlMode: opportunity?.control_mode ?? 'automated',
      holds: await holdsOfMessage(context, input.messageId),
      ambiguous: matches.length > 1,
      candidates,
      contactsAtFirm: await contactsAtFirm(context, firm.id),
    },
    deterministicClass: deterministic?.class ?? 'uncertain',
    signals: signalsOf(classifications),
    proposedDisposition: proposal.disposition,
    proposedBy: proposal.by,
    confidence: model?.confidence ?? null,
    // The excerpt is a quotation from the body and is redacted with it.
    supportingExcerpt: readable ? (model?.supportingExcerpt ?? null) : null,
    callbackProposal: readable ? (model?.callbackProposal ?? null) : null,
    modelName: model?.modelName ?? null,
    promptVersion: model?.promptVersion ?? null,
    requiresConfirmation: confirmation === null && (deterministic?.requiresConfirmation ?? true),
    confirmation,
    nextAction: nextActionFor({
      ambiguousUnresolved,
      deterministicClass: deterministic?.class ?? 'uncertain',
      confirmed: confirmation !== null,
    }),
    visibility,
  };
}

/**
 * Today's reply lane, as cards (8.2 lane 1, 8.3).
 *
 * Driven by `today_items`, not by the messages table, because the lane is what the
 * salesperson's day is: a message whose today item was completed is off the list
 * even though the row is still there, and a message that arrived before today is on
 * it if its item is. The item key is G6's `reply-message:<id>`, and
 * `replyItemKey` in the mail lane spells it, so the two cannot drift.
 */
export async function listReplyCards(
  context: RepositoryContext,
  input: { readonly businessDate: string; readonly limit?: number | undefined },
): Promise<readonly ReplyCardDto[]> {
  const actor = context.scope.actor;
  const assignee = actor.kind === 'user' && actor.role !== 'admin' ? actor.userId : null;
  const { rows } = await context.db.query<{ item_key: string }>(
    `SELECT i.item_key
       FROM today_items i
       JOIN today_snapshots s
         ON s.workspace_id = i.workspace_id AND s.snapshot_date = i.snapshot_date AND s.firm_id = i.firm_id
      WHERE i.workspace_id = $1
        AND i.snapshot_date = $2::date
        AND i.kind = 'reply'
        AND i.status IN ('open', 'snoozed')
        AND ($3::uuid IS NULL OR s.assigned_user_id = $3)
      ORDER BY i.due_at, i.item_key
      LIMIT $4`,
    [context.scope.workspaceId, input.businessDate, assignee, Math.max(1, Math.min(input.limit ?? 50, 200))],
  );

  const cards: ReplyCardDto[] = [];
  for (const row of rows) {
    const messageId = row.item_key.startsWith('reply-message:') ? row.item_key.slice('reply-message:'.length) : null;
    if (messageId === null) continue;
    const card = await readReplyCard(context, { messageId });
    if (card !== null) cards.push(card);
  }
  return cards;
}
