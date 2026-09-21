import { createHash } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import {
  PLACEMENT_RULE_VERSION,
  deterministicMessageId,
  refuseSend,
  acceptSend,
  type OutboundOutcomeState,
  type OutboundState,
  type SendResult,
} from './types.ts';

/**
 * The outbound fence (specification 12.5, Appendix B).
 *
 * This file is the only place in the system that moves a fence. Every function here
 * is one transition, every transition writes the ledger, and the database refuses
 * anything the state machine does not allow — so a bug in this file produces an
 * exception rather than a second email.
 *
 * ## Why `prepare` is an upsert and not an insert
 *
 * Appendix B's first failure row: "Before fence creation | Retry; uniqueness creates
 * or reuses one fence." A step execution that was retried after its transaction
 * rolled back, or after the worker died between the fence and the completion, must
 * find the fence it already made. `ON CONFLICT ... DO NOTHING` plus a re-read is how
 * that is said: the insert either wins or loses, and the loser reads the winner's
 * row. `created` tells the caller which happened, and G8 uses it for nothing except
 * a log line, because the answer is the same either way.
 *
 * ## Why the token is returned exactly once
 *
 * `claimForDispatch` is the atomic `prepared → dispatching`. It is a single UPDATE
 * with `WHERE state = 'prepared'`, so exactly one caller can win it however many are
 * racing, and the token it generates is returned only to the winner. Every function
 * that can turn a fence into `sent` demands that token. A worker whose lease expired
 * and whose replacement already claimed the fence cannot produce one, so its only
 * remaining move is `beginReconciling`, which is Appendix B's
 * "a replacement worker may reconcile but never send a dispatching fence again".
 *
 * ## Why nothing here calls Gmail
 *
 * The fence is a database object. `send.ts` is what talks to Gmail, and it does so
 * strictly between `claimForDispatch` and one of the terminal moves. Keeping the two
 * apart is what makes it possible to test every transition — including the ones that
 * only happen when a process dies — without a network at all.
 */

export interface OutboundFenceRow {
  readonly id: string;
  readonly mailboxId: string;
  readonly state: OutboundState;
  readonly originKind: 'step_execution' | 'draft';
  readonly enrollmentId: string | null;
  readonly stepExecutionId: string | null;
  readonly draftId: string | null;
  readonly firmId: string;
  readonly contactId: string | null;
  readonly opportunityId: string | null;
  readonly recipientAddress: string;
  readonly recipientRouteId: string | null;
  readonly recipientRouteVersion: number | null;
  readonly subject: string;
  readonly body: string;
  readonly templateVersionId: string | null;
  readonly renderedHash: string;
  readonly providerMessageIdHeader: string;
  readonly sendAt: string;
  readonly sourceZone: string;
  readonly attemptToken: string | null;
  readonly dispatchStartedAt: string | null;
  readonly sentAt: string | null;
  readonly providerMessageId: string | null;
  readonly providerThreadId: string | null;
  readonly reconcileDeadlineAt: string | null;
  readonly reconcileAttempts: number;
  readonly heldReason: string | null;
  readonly unknownTerminalAt: string | null;
  readonly adminResolution: 'delivered' | 'skipped' | null;
  readonly businessDate: string | null;
}

type FenceDbRow = {
  id: string;
  mailbox_id: string;
  state: OutboundState;
  origin_kind: 'step_execution' | 'draft';
  enrollment_id: string | null;
  step_execution_id: string | null;
  draft_id: string | null;
  firm_id: string;
  contact_id: string | null;
  opportunity_id: string | null;
  recipient_address: string;
  recipient_route_id: string | null;
  recipient_route_version: number | null;
  subject: string;
  body: string;
  template_version_id: string | null;
  rendered_hash: string;
  provider_message_id_header: string;
  send_at: Date;
  source_zone: string;
  attempt_token: string | null;
  dispatch_started_at: Date | null;
  sent_at: Date | null;
  provider_message_id: string | null;
  provider_thread_id: string | null;
  reconcile_deadline_at: Date | null;
  reconcile_attempts: number;
  held_reason: string | null;
  unknown_terminal_at: Date | null;
  admin_resolution: 'delivered' | 'skipped' | null;
  business_date: Date | string | null;
};

const FENCE_COLUMNS = `id, mailbox_id, state, origin_kind, enrollment_id, step_execution_id, draft_id,
  firm_id, contact_id, opportunity_id, recipient_address, recipient_route_id, recipient_route_version,
  subject, body, template_version_id, rendered_hash, provider_message_id_header, send_at, source_zone,
  attempt_token, dispatch_started_at, sent_at, provider_message_id, provider_thread_id,
  reconcile_deadline_at, reconcile_attempts, held_reason, unknown_terminal_at, admin_resolution,
  business_date`;

function toFence(row: FenceDbRow): OutboundFenceRow {
  return {
    id: row.id,
    mailboxId: row.mailbox_id,
    state: row.state,
    originKind: row.origin_kind,
    enrollmentId: row.enrollment_id,
    stepExecutionId: row.step_execution_id,
    draftId: row.draft_id,
    firmId: row.firm_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    recipientAddress: row.recipient_address,
    recipientRouteId: row.recipient_route_id,
    recipientRouteVersion: row.recipient_route_version,
    subject: row.subject,
    body: row.body,
    templateVersionId: row.template_version_id,
    renderedHash: row.rendered_hash,
    providerMessageIdHeader: row.provider_message_id_header,
    sendAt: row.send_at.toISOString(),
    sourceZone: row.source_zone,
    attemptToken: row.attempt_token,
    dispatchStartedAt: row.dispatch_started_at?.toISOString() ?? null,
    sentAt: row.sent_at?.toISOString() ?? null,
    providerMessageId: row.provider_message_id,
    providerThreadId: row.provider_thread_id,
    reconcileDeadlineAt: row.reconcile_deadline_at?.toISOString() ?? null,
    reconcileAttempts: row.reconcile_attempts,
    heldReason: row.held_reason,
    unknownTerminalAt: row.unknown_terminal_at?.toISOString() ?? null,
    adminResolution: row.admin_resolution,
    businessDate:
      row.business_date === null
        ? null
        : row.business_date instanceof Date
          ? row.business_date.toISOString().slice(0, 10)
          : row.business_date,
  };
}

/**
 * The ledger write every transition makes.
 *
 * The sequence number is `max + 1` inside the same transaction as the transition, so
 * the ordering is the transaction's ordering and `outbound_message_events_ordered`
 * refuses a duplicate rather than silently interleaving two writers.
 */
async function appendEvent(
  context: RepositoryContext,
  input: {
    readonly outboundMessageId: string;
    readonly fromState: OutboundState | null;
    readonly toState: OutboundState;
    readonly attemptToken?: string | null | undefined;
    readonly actor: string;
    readonly detail?: Readonly<Record<string, unknown>> | undefined;
  },
): Promise<void> {
  await context.db.query(
    `INSERT INTO outbound_message_events
       (workspace_id, outbound_message_id, sequence_number, from_state, to_state, attempt_token, actor, detail)
     SELECT $1, $2, coalesce(max(sequence_number), 0) + 1, $3, $4, $5, $6, $7::jsonb
       FROM outbound_message_events
      WHERE workspace_id = $1 AND outbound_message_id = $2`,
    [
      context.scope.workspaceId,
      input.outboundMessageId,
      input.fromState,
      input.toState,
      input.attemptToken ?? null,
      input.actor,
      JSON.stringify(input.detail ?? {}),
    ],
  );
}

/**
 * Everything G8 hands over for one email.
 *
 * The bytes are already rendered: G8 substitutes the variables and refuses the step
 * if any required one is missing, because "hold the step" is a sequence decision and
 * a fence should never exist for an email that was never renderable. What arrives
 * here is final text and the hash of the template version it came from, which is
 * checked against `template_versions` before anything is written.
 */
export interface OutboundEmailRequest {
  readonly enrollmentId?: string | null | undefined;
  readonly stepExecutionId: string;
  readonly opportunityId?: string | null | undefined;
  readonly firmId: string;
  readonly contactId?: string | null | undefined;
  /** Whose mailbox sends it. Resolved to the mailbox here, not by the caller. */
  readonly ownerUserId: string;
  readonly templateVersionId: string;
  readonly templateContentHash: string;
  /** The frozen route: `email_addresses.id`. */
  readonly emailAddressId?: string | null | undefined;
  readonly toAddress: string;
  readonly subject: string;
  readonly body: string;
  /** The UTC placement the caller computed from the firm's zone (11.2, Appendix D). */
  readonly sendAt: string;
  readonly sourceZone: string;
  readonly ruleVersion?: string | undefined;
  /** The workspace business date the send counts against (12.7, Appendix D). */
  readonly businessDate: string;
}

export interface PreparedFence {
  readonly outboundMessageId: string;
  /** False when an existing fence was reused. Appendix B's "creates or reuses one". */
  readonly created: boolean;
}

/**
 * Create the fence for one step execution, or return the one that already exists.
 *
 * The refusals are all *before* any row is written, and each is a reason a fence
 * should never have existed rather than a reason a send should be held:
 *
 *   * `template_unapproved` — the named version is not approved, so its bytes were
 *     never cleared to leave;
 *   * `template_mismatch` — the caller's content hash disagrees with the stored one,
 *     which means the two sides are looking at different text and nobody should
 *     guess which;
 *   * `mailbox_unknown` / `mailbox_inactive` — the owner has no connected mailbox.
 *
 * A hold is a different thing and comes later, from `gate.ts`.
 */
export async function prepareOutboundMessage(
  context: RepositoryContext,
  request: OutboundEmailRequest,
): Promise<SendResult<PreparedFence>> {
  const existing = await readFenceByStepExecution(context, request.stepExecutionId);
  if (existing !== null) return acceptSend({ outboundMessageId: existing.id, created: false });

  const template = await context.db.query<{ content_hash: string; approved_at: Date | null }>(
    'SELECT content_hash, approved_at FROM template_versions WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, request.templateVersionId],
  );
  const templateRow = template.rows[0];
  if (templateRow === undefined || templateRow.approved_at === null) {
    return refuseSend('template_unapproved');
  }
  if (templateRow.content_hash !== request.templateContentHash) return refuseSend('template_mismatch');

  const mailbox = await context.db.query<{ id: string; status: string; email_address: string }>(
    'SELECT id, status, email_address FROM mailboxes WHERE workspace_id = $1 AND owner_user_id = $2',
    [context.scope.workspaceId, request.ownerUserId],
  );
  const mailboxRow = mailbox.rows[0];
  if (mailboxRow === undefined) return refuseSend('mailbox_unknown');
  if (mailboxRow.status !== 'connected') return refuseSend('mailbox_inactive');

  const sendingDomain = mailboxRow.email_address.slice(mailboxRow.email_address.lastIndexOf('@') + 1);
  const routeVersion =
    request.emailAddressId === undefined || request.emailAddressId === null
      ? null
      : await readRouteVersion(context, request.emailAddressId);

  // The fence's id is generated here rather than by the default, because the
  // deterministic Message-ID is derived from it and has to be written in the same
  // INSERT. A header computed after the row existed would need a second UPDATE, and
  // a fence that briefly had no header is a fence a crash could leave unsearchable.
  const generated = await context.db.query<{ id: string }>('SELECT gen_random_uuid() AS id');
  const id = generated.rows[0]?.id ?? '';

  const { rows } = await context.db.query<{ id: string }>(
    `INSERT INTO outbound_messages
       (id, workspace_id, mailbox_id, origin_kind, enrollment_id, step_execution_id, firm_id, contact_id,
        opportunity_id, recipient_address, recipient_route_id, recipient_route_version, subject, body,
        template_version_id, rendered_hash, provider_message_id_header, send_at, source_zone,
        placement_rule_version, business_date)
     VALUES ($1, $2, $3, 'step_execution', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             $17::timestamptz, $18, $19, $20::date)
     ON CONFLICT (workspace_id, step_execution_id) WHERE step_execution_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [
      id,
      context.scope.workspaceId,
      mailboxRow.id,
      request.enrollmentId ?? null,
      request.stepExecutionId,
      request.firmId,
      request.contactId ?? null,
      request.opportunityId ?? null,
      request.toAddress.toLowerCase(),
      request.emailAddressId ?? null,
      routeVersion,
      request.subject,
      request.body,
      request.templateVersionId,
      renderedHash(request.subject, request.body),
      deterministicMessageId(id, sendingDomain),
      request.sendAt,
      request.sourceZone,
      request.ruleVersion ?? PLACEMENT_RULE_VERSION,
      request.businessDate,
    ],
  );

  const inserted = rows[0];
  if (inserted === undefined) {
    // Another transaction created it between the read and the insert. Its row is the
    // one fence for this origin, which is exactly what the partial unique is for.
    const raced = await readFenceByStepExecution(context, request.stepExecutionId);
    if (raced === null) throw new Error('the outbound fence upsert neither inserted nor found a row');
    return acceptSend({ outboundMessageId: raced.id, created: false });
  }

  await appendEvent(context, {
    outboundMessageId: inserted.id,
    fromState: null,
    toState: 'prepared',
    actor: describeActor(context),
  });
  return acceptSend({ outboundMessageId: inserted.id, created: true });
}

/**
 * The hash of the bytes that will actually leave — subject and body together.
 *
 * Distinct from `templateContentHash`, which covers the template's *unsubstituted*
 * text. This one covers the rendered result, so a reader looking at a fence six
 * months later can prove what that prospect received without the template, the
 * variables and the contact all still agreeing.
 */
export function renderedHash(subject: string, body: string): string {
  return createHash('sha256').update(`${subject}\n\n${body}`, 'utf8').digest('hex');
}

function describeActor(context: RepositoryContext): string {
  const actor = context.scope.actor;
  return actor.kind === 'system' ? `system:${actor.component}` : `user:${actor.kind}`;
}

async function readRouteVersion(context: RepositoryContext, routeId: string): Promise<number | null> {
  const { rows } = await context.db.query<{ version: number }>(
    'SELECT version FROM email_addresses WHERE workspace_id = $1 AND id = $2',
    [context.scope.workspaceId, routeId],
  );
  return rows[0]?.version ?? null;
}

export async function readFence(
  context: RepositoryContext,
  outboundMessageId: string,
): Promise<OutboundFenceRow | null> {
  const { rows } = await context.db.query<FenceDbRow>(
    `SELECT ${FENCE_COLUMNS} FROM outbound_messages WHERE workspace_id = $1 AND id = $2`,
    [context.scope.workspaceId, outboundMessageId],
  );
  const row = rows[0];
  return row === undefined ? null : toFence(row);
}

export async function readFenceByStepExecution(
  context: RepositoryContext,
  stepExecutionId: string,
): Promise<OutboundFenceRow | null> {
  const { rows } = await context.db.query<FenceDbRow>(
    `SELECT ${FENCE_COLUMNS} FROM outbound_messages
      WHERE workspace_id = $1 AND step_execution_id = $2`,
    [context.scope.workspaceId, stepExecutionId],
  );
  const row = rows[0];
  return row === undefined ? null : toFence(row);
}

/**
 * The fence of an outgoing message the sync imported, or null if FSS did not send it
 * (12.2, 12.7, Appendix G 19; lane G15).
 *
 * The mail pipeline learns of *every* outgoing message in the mailbox, including the
 * ones FSS sent itself, and until this function existed it could not tell them apart.
 * `packages/domain/mail/pipeline.ts` said so out loud — "until G7-2's fence exists,
 * every outgoing message that matches is a direct send, which is exactly right while
 * FSS has sent nothing: the fence lookup goes here". The fence exists now, and what it
 * costs to keep believing otherwise is two wrong things at once: FSS's own step-one
 * email would switch its opportunity to manual (7.3 reserves that for a *direct* send),
 * and 12.7's `direct_sent` counter would double-count a message already counted as
 * `automated_sent`.
 *
 * Two joins, because either can be missing: the deterministic `Message-ID` FSS wrote
 * before it sent (`<fss.{fence}@{domain}>`, unique per mailbox by
 * `outbound_messages_one_header_per_mailbox`) and the provider id Gmail returned,
 * which a fence only carries once it is `sent` or reconciled. `mail_messages.
 * rfc_message_id` is stored unbracketed and the fence's header bracketed, so the
 * brackets go back on for the comparison.
 */
export async function fenceForOutgoingMessage(
  context: RepositoryContext,
  input: {
    readonly mailboxId: string;
    readonly rfcMessageId: string | null;
    readonly providerMessageId: string | null;
  },
): Promise<string | null> {
  const header = input.rfcMessageId === null ? null : `<${input.rfcMessageId}>`;
  const { rows } = await context.db.query<{ id: string }>(
    `SELECT id FROM outbound_messages
      WHERE workspace_id = $1 AND mailbox_id = $2
        AND ((($3::text IS NOT NULL) AND provider_message_id_header = $3)
             OR (($4::text IS NOT NULL) AND provider_message_id = $4))
      LIMIT 1`,
    [context.scope.workspaceId, input.mailboxId, header, input.providerMessageId],
  );
  return rows[0]?.id ?? null;
}

export interface OutboundOutcome {
  readonly state: OutboundOutcomeState;
  readonly outboundMessageId: string | null;
  readonly dispatchedAt: string | null;
  readonly heldReason: string | null;
  /** Present once the fence is `unknown_terminal` and an admin has answered. */
  readonly adminResolution: 'delivered' | 'skipped' | null;
}

/**
 * What happened to one step execution's email, in the closed vocabulary G8 reads.
 *
 * `absent` is a real answer and not an error: a step whose fence was never prepared
 * has not been sent, has not been held, and is not in doubt.
 *
 * `dispatchedAt` is the *original* dispatch instant, not the instant of the last
 * transition. 12.5: "Delivered continues the sequence with the next delay calculated
 * from the original dispatch time." A reconciliation that ran twenty hours later
 * must not move the successor twenty hours.
 */
export async function readOutboundOutcome(
  context: RepositoryContext,
  stepExecutionId: string,
): Promise<OutboundOutcome> {
  const fence = await readFenceByStepExecution(context, stepExecutionId);
  if (fence === null) {
    return { state: 'absent', outboundMessageId: null, dispatchedAt: null, heldReason: null, adminResolution: null };
  }
  return {
    state: fence.state,
    outboundMessageId: fence.id,
    dispatchedAt: fence.dispatchStartedAt,
    heldReason: fence.heldReason,
    adminResolution: fence.adminResolution,
  };
}

export interface DispatchClaim {
  readonly fence: OutboundFenceRow;
  /** Present it to `recordSent`. Nothing else can produce it. */
  readonly attemptToken: string;
}

/**
 * The atomic `prepared → dispatching` of Appendix B.
 *
 * One UPDATE, `WHERE state = 'prepared'`. Whoever wins gets the token; everybody else
 * gets `fence_not_ready` and must not call Gmail. There is no lease here and no
 * retry: Appendix B says "Dispatch ownership is irreversible and not lease-based",
 * and the absence of a way to un-claim is the feature.
 */
export async function claimForDispatch(
  context: RepositoryContext,
  input: { readonly outboundMessageId: string; readonly actor?: string | undefined },
): Promise<SendResult<DispatchClaim>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'dispatching',
            attempt_token = gen_random_uuid(),
            dispatch_started_at = now(),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'prepared'
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId],
  );
  const row = rows[0];
  if (row === undefined) {
    const current = await readFence(context, input.outboundMessageId);
    return refuseSend(current === null ? 'fence_unknown' : 'fence_not_ready', current?.state);
  }
  const fence = toFence(row);
  const token = fence.attemptToken;
  if (token === null) throw new Error('the dispatch claim produced no attempt token');
  await appendEvent(context, {
    outboundMessageId: fence.id,
    fromState: 'prepared',
    toState: 'dispatching',
    attemptToken: token,
    actor: input.actor ?? describeActor(context),
  });
  return acceptSend({ fence, attemptToken: token });
}

/**
 * `dispatching → sent`, by the one process holding the token.
 *
 * `AND attempt_token = $3` is the whole of "a replacement worker may reconcile but
 * never send a dispatching fence again": a worker that lost its lease and woke up
 * after its replacement re-claimed nothing — the token cannot be re-issued, so the
 * only other holder is the one that has it — finds zero rows and stops.
 */
export async function recordSent(
  context: RepositoryContext,
  input: {
    readonly outboundMessageId: string;
    readonly attemptToken: string;
    readonly providerMessageId: string;
    readonly providerThreadId: string;
    readonly actor?: string | undefined;
  },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'sent', sent_at = now(), provider_message_id = $4, provider_thread_id = $5,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND attempt_token = $3 AND state = 'dispatching'
      RETURNING ${FENCE_COLUMNS}`,
    [
      context.scope.workspaceId,
      input.outboundMessageId,
      input.attemptToken,
      input.providerMessageId,
      input.providerThreadId,
    ],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'dispatching',
    toState: 'sent',
    attemptToken: input.attemptToken,
    actor: input.actor ?? describeActor(context),
    detail: { providerMessageId: input.providerMessageId },
  });
  return acceptSend(toFence(row));
}

/**
 * `dispatching → reconciling`: the request may have left, so nobody may send again.
 *
 * No token is required and that is deliberate. The process that most needs to move a
 * fence here is the one that just lost its lease, or a sweep finding a fence that has
 * been `dispatching` since a worker died — neither has the token, and requiring one
 * would strand the fence in `dispatching` forever, which is the one state with no
 * observation scheduled.
 */
export async function beginReconciling(
  context: RepositoryContext,
  input: {
    readonly outboundMessageId: string;
    readonly detail: string;
    readonly windowHours: number;
    readonly actor?: string | undefined;
  },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'reconciling',
            reconcile_started_at = now(),
            reconcile_deadline_at = now() + make_interval(hours => $3::integer),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'dispatching'
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId, input.windowHours],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'dispatching',
    toState: 'reconciling',
    actor: input.actor ?? describeActor(context),
    detail: { why: input.detail },
  });
  return acceptSend(toFence(row));
}

/**
 * `reconciling → sent`, from the Sent-folder search.
 *
 * Appendix B: "Sent search finds deterministic Message-ID | Record provider IDs and
 * sent." No token: the fence's own Message-ID in the mailbox's Sent folder is better
 * evidence than a token, because it is evidence from Gmail rather than from us.
 */
export async function recordReconciledSent(
  context: RepositoryContext,
  input: {
    readonly outboundMessageId: string;
    readonly providerMessageId: string;
    readonly providerThreadId: string;
    readonly actor?: string | undefined;
  },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'sent',
            -- The send happened when dispatch began, not when we noticed. 12.5's
            -- successor delay is "calculated from the original dispatch time".
            sent_at = coalesce(dispatch_started_at, now()),
            provider_message_id = $3, provider_thread_id = $4,
            reconcile_attempts = reconcile_attempts + 1,
            reconcile_last_attempt_at = now(),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'reconciling'
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId, input.providerMessageId, input.providerThreadId],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'reconciling',
    toState: 'sent',
    actor: input.actor ?? describeActor(context),
    detail: { via: 'sent_folder_search', providerMessageId: input.providerMessageId },
  });
  return acceptSend(toFence(row));
}

/** One observation that found nothing. The window, not the attempt count, decides. */
export async function recordReconcileMiss(
  context: RepositoryContext,
  outboundMessageId: string,
): Promise<number> {
  const { rows } = await context.db.query<{ reconcile_attempts: number }>(
    `UPDATE outbound_messages
        SET reconcile_attempts = reconcile_attempts + 1,
            reconcile_last_attempt_at = now(),
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'reconciling'
      RETURNING reconcile_attempts`,
    [context.scope.workspaceId, outboundMessageId],
  );
  return rows[0]?.reconcile_attempts ?? 0;
}

/**
 * `reconciling → unknown_terminal`: the observation window expired.
 *
 * Appendix B: "Observation expires | `unknown_terminal`; admin marks delivered or
 * skipped; never resend." The `WHERE reconcile_deadline_at <= now()` is what makes
 * the window real rather than advisory — a caller that decided early cannot persuade
 * the database to agree.
 */
export async function markUnknownTerminal(
  context: RepositoryContext,
  input: { readonly outboundMessageId: string; readonly actor?: string | undefined },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'unknown_terminal', unknown_terminal_at = now(), updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'reconciling'
        AND reconcile_deadline_at IS NOT NULL AND reconcile_deadline_at <= now()
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'reconciling',
    toState: 'unknown_terminal',
    actor: input.actor ?? describeActor(context),
  });
  return acceptSend(toFence(row));
}

/**
 * `prepared → held`: a local decision, made before anything left.
 *
 * Appendix B's third failure row, and the reason the state exists at all: it is the
 * only way to record "this email was not sent, and nothing was attempted" so that a
 * later attempt is provably safe.
 */
export async function holdFence(
  context: RepositoryContext,
  input: { readonly outboundMessageId: string; readonly reason: string; readonly actor?: string | undefined },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'held', held_at = now(), held_reason = $3, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'prepared'
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId, input.reason],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'prepared',
    toState: 'held',
    actor: input.actor ?? describeActor(context),
    detail: { reason: input.reason },
  });
  return acceptSend(toFence(row));
}

/**
 * `held → prepared`: the one reverse edge in the machine.
 *
 * Safe precisely because `held` is defined as "never entered dispatching". Without it
 * a fence held by yesterday's daily cap could never send, because its origin cannot
 * have a second fence.
 */
export async function releaseFence(
  context: RepositoryContext,
  input: { readonly outboundMessageId: string; readonly actor?: string | undefined },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET state = 'prepared', held_at = NULL, held_reason = NULL, updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'held'
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'held',
    toState: 'prepared',
    actor: input.actor ?? describeActor(context),
  });
  return acceptSend(toFence(row));
}

/**
 * The admin's answer to an `unknown_terminal` fence (12.5, Appendix G 36).
 *
 * It changes no state, and that is the point. "Neither choice ever releases the same
 * step for resend": whichever the admin picks, this fence is finished with Gmail
 * forever. What the choice decides is what the *sequence* does next, and that is
 * G8's to act on from the outcome this records — `delivered` continues the successor
 * from `dispatchedAt`, `skipped` stops the enrollment.
 */
export async function resolveUnknownTerminal(
  context: RepositoryContext,
  input: {
    readonly outboundMessageId: string;
    readonly resolution: 'delivered' | 'skipped';
    readonly adminUserId: string;
  },
): Promise<SendResult<OutboundFenceRow>> {
  const { rows } = await context.db.query<FenceDbRow>(
    `UPDATE outbound_messages
        SET admin_resolution = $3, admin_resolved_at = now(), admin_resolved_by_user_id = $4,
            updated_at = now()
      WHERE workspace_id = $1 AND id = $2 AND state = 'unknown_terminal' AND admin_resolution IS NULL
      RETURNING ${FENCE_COLUMNS}`,
    [context.scope.workspaceId, input.outboundMessageId, input.resolution, input.adminUserId],
  );
  const row = rows[0];
  if (row === undefined) return refuseSend('fence_not_ready');
  await appendEvent(context, {
    outboundMessageId: input.outboundMessageId,
    fromState: 'unknown_terminal',
    toState: 'unknown_terminal',
    actor: `user:${input.adminUserId}`,
    detail: { resolution: input.resolution },
  });
  return acceptSend(toFence(row));
}

/** The ledger, oldest first. What an incident reads. */
export async function readFenceEvents(
  context: RepositoryContext,
  outboundMessageId: string,
): Promise<
  readonly {
    readonly sequenceNumber: number;
    readonly fromState: OutboundState | null;
    readonly toState: OutboundState;
    readonly actor: string;
    readonly occurredAt: string;
  }[]
> {
  const { rows } = await context.db.query<{
    sequence_number: number;
    from_state: OutboundState | null;
    to_state: OutboundState;
    actor: string;
    occurred_at: Date;
  }>(
    `SELECT sequence_number, from_state, to_state, actor, occurred_at
       FROM outbound_message_events
      WHERE workspace_id = $1 AND outbound_message_id = $2
      ORDER BY sequence_number`,
    [context.scope.workspaceId, outboundMessageId],
  );
  return rows.map(row => ({
    sequenceNumber: row.sequence_number,
    fromState: row.from_state,
    toState: row.to_state,
    actor: row.actor,
    occurredAt: row.occurred_at.toISOString(),
  }));
}
