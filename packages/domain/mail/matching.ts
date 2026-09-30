import type { RepositoryContext } from '../db/workspaceScope.ts';
import { openHold, releaseHoldsOfEvent } from '../policy/holds.ts';
import { databaseNow } from '../policy/clock.ts';
import { setManualControlMode } from '../crm/pipeline.ts';
import { lockSendGateForStopFact } from '../policy/sendGate.ts';
import { fenceForOutgoingMessage } from '../outbound/fence.ts';
import { decideFirmMutation } from '../crm/authorization.ts';
import { loadFirmForUpdate } from '../crm/firms.ts';
import { applyDirectSendEffects, directSendAppliedFirms } from './effects.ts';
import { markMessageMatched, readMessage } from './messages.ts';
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

/**
 * An unfenced outgoing message's recipients, checked against the rule that matched it
 * (send-path v2, S1 review P1-1).
 *
 * Matching stops at the first rule that finds anything, so a message in a thread FSS
 * matched to firm A is firm A's even when its To/Cc names a known contact at firm B — or
 * an address associated with both firms. For a prospect's reply that is the point; for
 * the salesperson's own send it would update the wrong conversation: end A's
 * prospecting, and leave B's untouched. So for an unfenced outgoing message the To/Cc
 * participants are looked up too, and every firm they name that the match did not is
 * added as a candidate. More than one candidate is an ambiguity: `recordMatches` holds
 * each, and the direct-send effect waits for the person's resolution.
 *
 * A match that is already the participant rule has nothing to add (it read To/Cc), and
 * recipients that name no known firm add nothing.
 */
export async function withOutgoingRecipientConflicts(
  context: RepositoryContext,
  input: { readonly candidates: readonly MatchCandidate[]; readonly metadata: NormalizedMetadata },
): Promise<readonly MatchCandidate[]> {
  if (input.candidates.length === 0 || input.candidates.every(candidate => candidate.rule === 'participant')) {
    return input.candidates;
  }
  const recipients = [...new Set([...input.metadata.headerTo, ...input.metadata.headerCc])];
  const rows = await byParticipant(context, recipients);
  const named: MatchCandidate[] = [];
  for (const row of rows) {
    const candidate = await resolveToOpenOpportunity(context, row, 'participant');
    if (candidate !== null) named.push(candidate);
  }
  return distinct([...input.candidates, ...named]);
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
  // The stored, unresolved matches count too (S1 review P1-A): a replay that finds one
  // candidate for a message whose first import found two is still the same unresolved
  // ambiguity, and a candidate new on the replay joins it held rather than unheld.
  const { rows: unresolved } = await context.db.query<{ opportunity_id: string }>(
    `SELECT opportunity_id FROM mail_message_matches
      WHERE workspace_id = $1 AND mail_message_id = $2 AND selected IS NULL`,
    [context.scope.workspaceId, input.messageId],
  );
  const resolvedAlready = await context.db.query(
    `SELECT 1 FROM mail_message_matches
      WHERE workspace_id = $1 AND mail_message_id = $2 AND selected IS NOT NULL LIMIT 1`,
    [context.scope.workspaceId, input.messageId],
  );
  const ambiguous =
    (resolvedAlready.rowCount ?? 0) === 0 &&
    new Set([...unresolved.map(row => row.opportunity_id), ...input.candidates.map(candidate => candidate.opportunityId)])
      .size > 1;
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
        blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
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

/**
 * Record one imported message's matches, with the salesperson's own direct send frozen
 * once its effect is applied (S1 review P1-D, round 4 P1-H).
 *
 * For an unfenced outgoing message the order is the send gate, then the marker read,
 * then the match writes — one transaction, the import's. A resolution applies the
 * direct-send effect under the same exclusive gate, so a replay that reads "no marker"
 * cannot then write a newly known firm's match and hold after a resolution committed the
 * marker in between: it waits for the gate and reads the marker. An applied marker
 * (either kind) freezes the candidate set — no new match, no hold. Otherwise the To/Cc
 * recipients are checked against the rule that matched (P1-1) and the matches recorded.
 */
export async function recordMatchesForImport(
  context: RepositoryContext,
  input: {
    readonly messageId: string;
    readonly candidates: readonly MatchCandidate[];
    readonly metadata: NormalizedMetadata;
    /** True for an outgoing message no FSS fence names: the salesperson's direct send. */
    readonly directSend: boolean;
  },
): Promise<{ readonly frozen: true } | ({ readonly frozen: false } & RecordedMatches)> {
  let candidates = input.candidates;
  if (input.directSend) {
    await lockSendGateForStopFact(context);
    if ((await directSendAppliedFirms(context, input.messageId)).length > 0) return { frozen: true };
    candidates = await withOutgoingRecipientConflicts(context, { candidates, metadata: input.metadata });
  }
  return { frozen: false, ...(await recordMatches(context, { messageId: input.messageId, candidates })) };
}

/**
 * The one opportunity a direct send's effect may be applied to at import, from the
 * stored match set (S1 review P1-A), or undefined while a person still has to choose.
 *
 * A stored selection wins. Otherwise exactly one stored match, not marked ambiguous, is
 * the target. Two or more unresolved matches — or one left marked ambiguous — wait.
 */
export async function directSendTargetOf(
  context: RepositoryContext,
  messageId: string,
): Promise<RecordedMatch | undefined> {
  const stored = await listMatches(context, messageId);
  const chosen = stored.find(match => match.selected === true);
  if (chosen !== undefined) return chosen;
  if (stored.some(match => match.selected !== null)) return undefined;
  const only = stored.length === 1 ? stored[0] : undefined;
  return only !== undefined && !only.ambiguous ? only : undefined;
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

export interface HeldOutgoingMessageRow {
  readonly messageId: string;
  readonly internalDate: string;
  readonly candidates: readonly { readonly opportunityId: string; readonly firmId: string; readonly firmName: string }[];
}

/**
 * The outgoing messages with an unresolved ambiguous match at this firm, and every
 * candidate of each (send-path v2, S1 review P1-C). The caller decides who may read it;
 * this answers ids, the instant and the candidate firms' names.
 */
export async function listHeldOutgoingForFirm(
  context: RepositoryContext,
  firmId: string,
): Promise<readonly HeldOutgoingMessageRow[]> {
  const { rows } = await context.db.query<{
    message_id: string;
    internal_date: Date;
    opportunity_id: string;
    firm_id: string;
    firm_name: string;
  }>(
    `SELECT m.id AS message_id, m.internal_date, x.opportunity_id, x.firm_id, f.name AS firm_name
       FROM mail_messages AS m
       JOIN mail_message_matches AS x ON x.workspace_id = m.workspace_id AND x.mail_message_id = m.id
       JOIN firms AS f ON f.workspace_id = x.workspace_id AND f.id = x.firm_id
      WHERE m.workspace_id = $1
        AND m.direction = 'outgoing'
        AND EXISTS (SELECT 1 FROM mail_message_matches AS mine
                     WHERE mine.workspace_id = m.workspace_id AND mine.mail_message_id = m.id
                       AND mine.firm_id = $2 AND mine.ambiguous AND mine.selected IS NULL)
      ORDER BY m.internal_date DESC, m.id, f.name, x.opportunity_id`,
    [context.scope.workspaceId, firmId],
  );
  const byMessage = new Map<string, { internalDate: string; candidates: HeldOutgoingMessageRow['candidates'][number][] }>();
  for (const row of rows) {
    const entry = byMessage.get(row.message_id) ?? { internalDate: row.internal_date.toISOString(), candidates: [] };
    entry.candidates.push({ opportunityId: row.opportunity_id, firmId: row.firm_id, firmName: row.firm_name });
    byMessage.set(row.message_id, entry);
  }
  return [...byMessage].map(([messageId, entry]) => ({ messageId, ...entry }));
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
  // The send gate before the first row this command reads or writes (decision document
  // 6a): a human resolution sets manual mode below, whose event records the enrollments
  // it owes (migration 0026), and the hold opened first is a stop fact of its own. Taken
  // before the read as well (S1 review, P1-2): two resolutions of one message serialize
  // here, and the second reads the first's selection and is refused, instead of both
  // reading "unresolved" and the second re-pointing the selection after the first's
  // once-per-message direct-send effect.
  await lockSendGateForStopFact(context);
  await context.db.query(
    `SELECT id FROM mail_message_matches
      WHERE workspace_id = $1 AND mail_message_id = $2
      ORDER BY id
      FOR UPDATE`,
    [context.scope.workspaceId, input.messageId],
  );
  const candidates = await listMatches(context, input.messageId);
  if (candidates.length === 0) return refuseMail('match_unknown');
  if (candidates.some(candidate => candidate.selected !== null)) return refuseMail('already_resolved');
  const selected = candidates.find(candidate => candidate.opportunityId === input.selectedOpportunityId);
  if (selected === undefined) return refuseMail('match_unknown');

  // Who may resolve, decided here, before any selection is written or any hold released
  // (S1 review P1-E for outgoing; round 4 for incoming, human and not). The mailbox's
  // owner — or an administrator — and only for a firm the PR 332 assignment rule lets
  // them change: resolving releases the other candidates' holds, and for an outgoing
  // message applies the direct send to the chosen firm. Refused `not_assigned` with
  // nothing written. The `human` path's later `setManualControlMode` asks the same rule
  // of the same firm again, which now always agrees.
  const message = await readMessage(context, input.messageId);
  if (message === null) return refuseMail('message_unknown');
  if (actor.kind === 'user' && actor.role !== 'admin') {
    const { rows: owner } = await context.db.query<{ owner_user_id: string }>(
      'SELECT owner_user_id FROM mailboxes WHERE workspace_id = $1 AND id = $2',
      [context.scope.workspaceId, message.mailboxId],
    );
    const ownerUserId = owner[0]?.owner_user_id;
    if (ownerUserId !== undefined && ownerUserId !== actor.userId) return refuseMail('not_assigned');
  }
  const firm = await loadFirmForUpdate(context, selected.firmId);
  if (firm === null) return refuseMail('match_unknown');
  const permitted = decideFirmMutation(context, firm);
  if (!permitted.permitted) return refuseMail(permitted.reason === 'not_assigned' ? 'not_assigned' : 'invalid_input');
  if (message.direction === 'outgoing') {
    // A direct-send effect already applied fixes the firm (P1-D): the marker is once per
    // message, so a resolution to another firm would select it and change nothing.
    const applied = await directSendAppliedFirms(context, input.messageId);
    if (applied.length > 0 && !applied.includes(selected.firmId)) return refuseMail('already_applied');
  }

  const now = await databaseNow(context);
  const resolvedBy = actor.kind === 'user' ? actor.userId : null;
  // Unresolved → resolved only: a row somebody else resolved is not re-pointed, and the
  // count says whether every candidate was still unresolved.
  const resolution = await context.db.query(
    `UPDATE mail_message_matches
        SET selected = (opportunity_id = $3), resolved_at = $4, resolved_by_user_id = $5
      WHERE workspace_id = $1 AND mail_message_id = $2 AND selected IS NULL`,
    [context.scope.workspaceId, input.messageId, input.selectedOpportunityId, now, resolvedBy],
  );
  if ((resolution.rowCount ?? 0) !== candidates.length) return refuseMail('already_resolved');

  // Send-path v2 (slice S1; the coordinator's decision of 30 September 2026): an
  // OUTGOING message is not a prospect's reply. It gets no `uncertain_reply` keeper and
  // no `human_reply` manual mode, whatever `human` says; resolving it releases this
  // message's ambiguity holds and applies the direct-send effect to the one opportunity
  // the person named — once, by the effect's own marker. An FSS send is recognised by its
  // fence and has no direct-send effect either.
  if (message.direction === 'outgoing') {
    const releasedOutgoing = await releaseHoldsOfEvent(context, {
      sourceEventId: input.messageId,
      reasonCode: 'ambiguous_match',
    });
    const fenceId = await fenceForOutgoingMessage(context, {
      mailboxId: message.mailboxId,
      rfcMessageId: message.rfcMessageId,
      providerMessageId: message.providerMessageId,
    });
    if (fenceId === null) await applyDirectSendEffects(context, { message, candidate: selected });
    return acceptMail({
      selectedOpportunityId: input.selectedOpportunityId,
      releasedHoldIds: releasedOutgoing.map(hold => hold.id),
      manualOpportunityId: null,
    });
  }

  // The selected candidate keeps a hold of its own until the message's own
  // classification is dealt with, so it is opened *before* the release: at no instant
  // inside this transaction is the selected opportunity unheld, which is what Appendix
  // G 14's "only ambiguity holds release after resolution" is protecting.
  const keeper = await openHold(context, {
    scopeKind: 'opportunity',
    scopeKey: input.selectedOpportunityId,
    reasonCode: 'uncertain_reply',
    blockedActionKinds: ['email_send', 'call_task', 'enrollment_advance'],
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
