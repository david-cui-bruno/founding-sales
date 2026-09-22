import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { databaseNow } from '../policy/clock.ts';
import { setManualControlMode } from '../crm/pipeline.ts';
import { markMessageMatched } from './messages.ts';
import type { NormalizedMetadata } from './messages.ts';
import { acceptMail, refuseMail, type MailMatchRule, type MailResult } from './types.ts';

/**
 * Matching an observed message to an opportunity (specification 12.3, Appendix G 14
 * and 15).
 *
 * "Matching order is Gmail thread ID; RFC Message-ID references against FSS fences;
 * then known normalized participants with aliases enumerated from headers."
 *
 * Order means order: the first rule that produces any candidate wins outright, and
 * the later rules are not consulted. That matters because the rules disagree by
 * design — a reply in a thread FSS started is that thread's opportunity even when the
 * person replying has an address shared with three other firms, and asking the
 * participant rule anyway would turn a certain match into an ambiguous one.
 *
 * Two things the specification says that are easy to lose:
 *
 * **A match on a closed opportunity holds the firm's open one** (Appendix G 15). The
 * closed opportunity is still the right conversation, but the thing automation is
 * running on is the open one, and that is what must stop. So a closed candidate is
 * carried forward as its firm's current open opportunity, and the rule that found it
 * is preserved.
 *
 * **Several plausible firms is a set, not a best guess** (Appendix G 14). Every
 * candidate gets a row and an `ambiguous_match` hold, and resolution releases only the
 * ambiguity holds on the candidates that lost.
 *
 * The Message-ID rule matches against outgoing messages this mailbox has already
 * recorded. G7-2 adds `outbound_messages` and this is where its lookup joins: the
 * fence's deterministic Message-ID is the same unbracketed string these columns hold,
 * so the rule gains a second source and keeps its position in the order.
 */

export interface MatchCandidate {
  readonly firmId: string;
  readonly opportunityId: string;
  readonly contactId: string | null;
  readonly rule: MailMatchRule;
  /** True when the rule found a closed opportunity and this is the firm's open one. */
  readonly viaClosedOpportunity: boolean;
}

interface CandidateRow {
  readonly firm_id: string;
  readonly opportunity_id: string;
  readonly contact_id: string | null;
  readonly status: string;
  readonly [column: string]: unknown;
}

/** The candidate a row describes, mapped on to the firm's open opportunity if needed. */
async function resolveToOpenOpportunity(
  context: RepositoryContext,
  row: CandidateRow,
  rule: MailMatchRule,
): Promise<MatchCandidate | null> {
  if (row.status === 'open') {
    return {
      firmId: row.firm_id,
      opportunityId: row.opportunity_id,
      contactId: row.contact_id,
      rule,
      viaClosedOpportunity: false,
    };
  }
  // Appendix G 15: a reply to a closed opportunity holds the firm's current open one.
  const { rows } = await context.db.query<{ id: string }>(
    "SELECT id FROM opportunities WHERE workspace_id = $1 AND firm_id = $2 AND status = 'open'",
    [context.scope.workspaceId, row.firm_id],
  );
  const open = rows[0]?.id;
  if (open === undefined) return null;
  return {
    firmId: row.firm_id,
    opportunityId: open,
    contactId: row.contact_id,
    rule,
    viaClosedOpportunity: true,
  };
}

async function byThread(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly threadId: string; readonly excludeMessageId: string },
): Promise<readonly CandidateRow[]> {
  const { rows } = await context.db.query<CandidateRow>(
    `SELECT DISTINCT x.firm_id, x.opportunity_id, x.contact_id, o.status
       FROM mail_message_matches AS x
       JOIN mail_messages AS m ON m.workspace_id = x.workspace_id AND m.id = x.mail_message_id
       JOIN opportunities AS o ON o.workspace_id = x.workspace_id AND o.id = x.opportunity_id
      WHERE x.workspace_id = $1
        AND m.mailbox_id = $2
        AND m.provider_thread_id = $3
        AND m.id <> $4
        AND (x.selected IS NULL OR x.selected)`,
    [context.scope.workspaceId, input.mailboxId, input.threadId, input.excludeMessageId],
  );
  return rows;
}

async function byMessageIdReference(
  context: RepositoryContext,
  input: { readonly mailboxId: string; readonly references: readonly string[] },
): Promise<readonly CandidateRow[]> {
  if (input.references.length === 0) return [];
  const { rows } = await context.db.query<CandidateRow>(
    `SELECT DISTINCT x.firm_id, x.opportunity_id, x.contact_id, o.status
       FROM mail_messages AS sent
       JOIN mail_message_matches AS x ON x.workspace_id = sent.workspace_id AND x.mail_message_id = sent.id
       JOIN opportunities AS o ON o.workspace_id = x.workspace_id AND o.id = x.opportunity_id
      WHERE sent.workspace_id = $1
        AND sent.mailbox_id = $2
        AND sent.direction = 'outgoing'
        AND sent.rfc_message_id = ANY ($3::text[])`,
    [context.scope.workspaceId, input.mailboxId, [...input.references]],
  );
  return rows;
}

/**
 * The participants, minus this workspace's own mailboxes.
 *
 * A message from the salesperson to a prospect has the salesperson on `From`; a
 * message from the prospect has them on `To`. Neither says anything about which firm
 * is meant, and a Callie address that happened to be a CRM route would match every
 * firm at once.
 */
async function byParticipant(
  context: RepositoryContext,
  addresses: readonly string[],
): Promise<readonly CandidateRow[]> {
  if (addresses.length === 0) return [];
  const { rows } = await context.db.query<CandidateRow>(
    `SELECT DISTINCT e.firm_id, o.id AS opportunity_id, e.contact_id, o.status
       FROM email_addresses AS e
       JOIN opportunities AS o ON o.workspace_id = e.workspace_id AND o.firm_id = e.firm_id
      WHERE e.workspace_id = $1
        AND e.address = ANY ($2::text[])
        AND e.eligibility <> 'retired'
        AND o.status = 'open'
        AND NOT EXISTS (
          SELECT 1 FROM mailboxes AS b
           WHERE b.workspace_id = e.workspace_id AND b.email_address = e.address
        )`,
    [context.scope.workspaceId, [...addresses]],
  );
  return rows;
}

function distinct(candidates: readonly MatchCandidate[]): readonly MatchCandidate[] {
  const byOpportunity = new Map<string, MatchCandidate>();
  for (const candidate of candidates) {
    if (!byOpportunity.has(candidate.opportunityId)) byOpportunity.set(candidate.opportunityId, candidate);
  }
  return [...byOpportunity.values()];
}

/**
 * Every plausible open opportunity for one message, by the first rule that finds any.
 *
 * The mailbox's own address is removed from the participant set before the lookup,
 * and so is every other mailbox in the workspace — see `byParticipant`.
 */
export async function findMatchCandidates(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly messageId: string;
    readonly metadata: NormalizedMetadata;
  },
): Promise<readonly MatchCandidate[]> {
  const resolveAll = async (
    rows: readonly CandidateRow[],
    rule: MailMatchRule,
  ): Promise<readonly MatchCandidate[]> => {
    const resolved: MatchCandidate[] = [];
    for (const row of rows) {
      const candidate = await resolveToOpenOpportunity(context, row, rule);
      if (candidate !== null) resolved.push(candidate);
    }
    return distinct(resolved);
  };

  const thread = await resolveAll(
    await byThread(context, {
      mailboxId: input.mailboxId,
      threadId: input.metadata.providerThreadId,
      excludeMessageId: input.messageId,
    }),
    'thread',
  );
  if (thread.length > 0) return thread;

  const references = await resolveAll(
    await byMessageIdReference(context, {
      mailboxId: input.mailboxId,
      references: input.metadata.referenceMessageIds,
    }),
    'message_id_reference',
  );
  if (references.length > 0) return references;

  const participants = [
    ...new Set([
      ...(input.metadata.headerFrom === null ? [] : [input.metadata.headerFrom]),
      ...input.metadata.headerTo,
      ...input.metadata.headerCc,
    ]),
  ];
  return await resolveAll(await byParticipant(context, participants), 'participant');
}

export interface RecordedMatches {
  readonly candidates: readonly MatchCandidate[];
  readonly ambiguous: boolean;
  /** The ambiguity holds opened, one per candidate, empty when the match is certain. */
  readonly holdIds: readonly string[];
}

/**
 * Write the candidates, and the ambiguity holds if there is more than one.
 *
 * The hold's source event is the message, so `resolveAmbiguity` releases exactly the
 * holds this message opened and no other hold on the same opportunity — section 4.3's
 * "clearing one hold never clears another".
 *
 * Idempotent: `mail_message_matches_one_per_opportunity` absorbs a replayed page, and
 * a candidate that is already there does not open a second hold.
 */
export async function recordMatches(
  context: RepositoryContext,
  input: { readonly messageId: string; readonly candidates: readonly MatchCandidate[] },
): Promise<RecordedMatches> {
  const ambiguous = input.candidates.length > 1;
  const holdIds: string[] = [];

  for (const candidate of input.candidates) {
    const existing = await context.db.query<{ id: string; hold_id: string | null }>(
      `SELECT id, hold_id FROM mail_message_matches
        WHERE workspace_id = $1 AND mail_message_id = $2 AND opportunity_id = $3`,
      [context.scope.workspaceId, input.messageId, candidate.opportunityId],
    );
    const found = existing.rows[0];
    if (found !== undefined) {
      if (found.hold_id !== null) holdIds.push(found.hold_id);
      continue;
    }

    let holdId: string | null = null;
    if (ambiguous) {
      holdId = await openHold(context, {
        scopeKind: 'opportunity',
        scopeKey: candidate.opportunityId,
        reasonCode: 'ambiguous_match',
        blockedActionKinds: ['email_send', 'call_task', 'linkedin_task', 'enrollment_advance'],
        sourceEventKind: 'mail_message',
        sourceEventId: input.messageId,
        recoveryAction: 'resolve_ambiguity',
      });
      holdIds.push(holdId);
    }

    await context.db.query(
      `INSERT INTO mail_message_matches (workspace_id, mail_message_id, firm_id, opportunity_id, contact_id,
                                         match_rule, ambiguous, hold_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        context.scope.workspaceId,
        input.messageId,
        candidate.firmId,
        candidate.opportunityId,
        candidate.contactId,
        candidate.rule,
        ambiguous,
        holdId,
      ],
    );
  }

  if (input.candidates.length > 0) await markMessageMatched(context, input.messageId);
  return { candidates: input.candidates, ambiguous, holdIds };
}

export interface RecordedMatch extends MatchCandidate {
  readonly id: string;
  readonly ambiguous: boolean;
  readonly holdId: string | null;
  readonly selected: boolean | null;
}

export async function listMatches(
  context: RepositoryContext,
  messageId: string,
): Promise<readonly RecordedMatch[]> {
  const { rows } = await context.db.query<{
    id: string;
    firm_id: string;
    opportunity_id: string;
    contact_id: string | null;
    match_rule: MailMatchRule;
    ambiguous: boolean;
    hold_id: string | null;
    selected: boolean | null;
  }>(
    `SELECT id, firm_id, opportunity_id, contact_id, match_rule, ambiguous, hold_id, selected
       FROM mail_message_matches
      WHERE workspace_id = $1 AND mail_message_id = $2
      ORDER BY created_at, id`,
    [context.scope.workspaceId, messageId],
  );
  return rows.map(row => ({
    id: row.id,
    firmId: row.firm_id,
    opportunityId: row.opportunity_id,
    contactId: row.contact_id,
    rule: row.match_rule,
    ambiguous: row.ambiguous,
    holdId: row.hold_id,
    selected: row.selected,
    viaClosedOpportunity: false,
  }));
}

export interface AmbiguityResolution {
  readonly selectedOpportunityId: string;
  readonly releasedHoldIds: readonly string[];
  readonly manualOpportunityId: string | null;
}

/**
 * Resolve an ambiguous message on to one opportunity (12.3, Appendix A "Resolve
 * ambiguity", Appendix G 14).
 *
 * "Resolution makes the selected opportunity manual when human and releases only the
 * ambiguity holds on other candidates after a fresh check."
 *
 * Three things follow from that sentence and are all here.
 *
 * The selected candidate's hold is *not* released. It is the one conversation that
 * did match, and if the message was human the opportunity is now manual anyway; if it
 * was uncertain, the uncertainty is still uncertain. Only the losers are released.
 *
 * "After a fresh check" is why the release goes through the policy lane's
 * `releaseHoldsOfEvent` with this message's id: a candidate that has acquired another
 * hold since — a pause, a suppression review — keeps it.
 *
 * `human` is the caller's word, and it is the salesperson's confirmation: 12.4 says a
 * human classification sets manual only through deterministic proof or confirmation,
 * and resolving an ambiguity is a person looking at the message.
 */
export async function resolveAmbiguity(
  context: RepositoryContext,
  input: {
    readonly messageId: string;
    readonly selectedOpportunityId: string;
    readonly human: boolean;
  },
): Promise<MailResult<AmbiguityResolution>> {
  const actor = context.scope.actor;
  const candidates = await listMatches(context, input.messageId);
  if (candidates.length === 0) return refuseMail('match_unknown');
  if (candidates.some(candidate => candidate.selected !== null)) return refuseMail('already_resolved');
  const selected = candidates.find(candidate => candidate.opportunityId === input.selectedOpportunityId);
  if (selected === undefined) return refuseMail('match_unknown');

  const now = await databaseNow(context);
  const resolvedBy = actor.kind === 'user' ? actor.userId : null;
  await context.db.query(
    `UPDATE mail_message_matches
        SET selected = (opportunity_id = $3), resolved_at = $4, resolved_by_user_id = $5
      WHERE workspace_id = $1 AND mail_message_id = $2`,
    [context.scope.workspaceId, input.messageId, input.selectedOpportunityId, now, resolvedBy],
  );

  // The selected candidate keeps a hold of its own until the message's own
  // classification is dealt with, so it is opened *before* the release: at no instant
  // inside this transaction is the selected opportunity unheld, which is what Appendix
  // G 14's "only ambiguity holds release after resolution" is protecting.
  const keeper = await openHold(context, {
    scopeKind: 'opportunity',
    scopeKey: input.selectedOpportunityId,
    reasonCode: 'uncertain_reply',
    blockedActionKinds: ['email_send', 'call_task', 'linkedin_task', 'enrollment_advance'],
    sourceEventKind: 'mail_message_resolution',
    sourceEventId: input.messageId,
    recoveryAction: 'confirm_reply',
  });

  // Release only the ambiguity holds, and only the ones this message opened. A
  // candidate that has acquired another hold since — a pause, a suppression review —
  // keeps it, which is the "after a fresh check" half of the sentence.
  const released = await releaseHoldsOfEvent(context, {
    sourceEventId: input.messageId,
    reasonCode: 'ambiguous_match',
  });

  await context.db.query(
    'UPDATE mail_message_matches SET hold_id = $3 WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, selected.id, keeper],
  );

  const releasedIds = released.map(hold => hold.id).filter(id => id !== selected.holdId);

  let manualOpportunityId: string | null = null;
  if (input.human) {
    const outcome = await setManualControlMode(context, {
      opportunityId: input.selectedOpportunityId,
      reason: 'confirmed human reply',
      origin: 'human_reply',
    });
    if (!outcome.ok) return refuseMail(outcome.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
    manualOpportunityId = input.selectedOpportunityId;
  }

  return acceptMail({
    selectedOpportunityId: input.selectedOpportunityId,
    releasedHoldIds: releasedIds,
    manualOpportunityId,
  });
}
