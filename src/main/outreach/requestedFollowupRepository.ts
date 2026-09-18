import { z } from 'zod';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { mailCursorEnvelopeSchema, type MailCursorEnvelope } from '../../shared/contracts/mailThreadContract';
import type { AppDatabase } from '../db/database';
import { exportSelectedAccountRecord } from '../delegation/selectedAccountSnapshot';
import { DelegationRepository } from '../delegation/delegationRepository';
import { SqlThreadIntakeRepository } from './threadIntakeRepository';
import { requestedMailContextSchema, type RequestedMailContext, requestedFollowupDraftSchema, requestedApprovalStatusSchema, prepareRequestedFollowupSchema, type PrepareRequestedFollowup, type RequestedFollowupDraft, type SavedRequestedFollowup } from '../../shared/contracts/requestedFollowupContract';
import { requestedMailContext, validateRequestedOriginalCall, validateRequestedRecipient, validateRequestedDraftContext, validateRequestedDraftRevision, REQUESTED_CONNECTED_ONLY, type RequestedFollowupContext } from './requestedFollowupService';
import { SqlReplyTemplateRepository } from './templates/replyTemplateRepository';
import { FOLLOWUP_TEMPLATE_OUTCOMES } from './templates/followupTemplateChoice';
import type { ReplyTemplate, ReplyTemplateId } from '../../shared/contracts/replyTemplateContract';
export type RequestedOwnerContext = { workspaceId: string; accountId: string; mailbox: { subject: string; sender: string }; mailContext: RequestedMailContext;
  accountVersion: number; researchRevision: number; authorityGeneration: number; aggregateVersion: number;
  cursor: { data: MailCursorEnvelope; rev: number } | null; expiresAt: string };
type LocalRequestedContext = RequestedFollowupContext & { cursor: { data: MailCursorEnvelope; rev: number } | null };
/** Source SQL only. The caller supplies actual authenticated selected mailbox
 * identity, not a UI sender field. No source, route or consent is manufactured. */
export class SqlRequestedFollowupRepository {
  readonly intake: SqlThreadIntakeRepository;
  constructor(readonly deps: { database: AppDatabase; workspaceId: string; clock: { now(): string }; mailbox(): { subject: string; sender: string }; ownerContext?(input: PrepareRequestedFollowup): RequestedOwnerContext }) { this.intake = new SqlThreadIntakeRepository(deps); }
  readContext(rawInput: PrepareRequestedFollowup): LocalRequestedContext {
    const raw = this.deps.database.raw;
    const read = (): LocalRequestedContext => {
      const input = prepareRequestedFollowupSchema.parse(rawInput), accountId = input.accountId;
      const owner = raw.prepare('SELECT owner,state,generation,aggregate_version FROM delegated_authorities WHERE workspace_id=? AND account_id=?').get(this.deps.workspaceId, accountId) as { owner: string; state: string; generation: number; aggregate_version: number } | undefined;
      if (!owner || !(owner.owner === 'local' && owner.state === 'local' || owner.owner === 'worker' && ['active', 'paused'].includes(owner.state))) throw new Error('requested_wrong_authority');
      const research = raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream='research'").get(this.deps.workspaceId, accountId) as { aggregate_version: number } | undefined;
      // Same bootstrap revision convention as selected-account export. This is not mail readiness.
      const account = exportSelectedAccountRecord({ database: this.deps.database, workspaceId: this.deps.workspaceId, accountId, asOf: this.deps.clock.now(), researchRevision: research?.aggregate_version ?? 1 });
      if (account.account.version !== input.expectedAccountVersion) throw new Error('requested_account_stale');
      validateRequestedRecipient(account, input.recipientBinding, input.originalCall);
      const command = raw.prepare('SELECT command_json,fingerprint FROM delegated_commands WHERE workspace_id=? AND account_id=? AND command_id=?').get(this.deps.workspaceId, accountId, input.originalCall.commandId) as { command_json: string; fingerprint: string } | undefined;
      const event = raw.prepare('SELECT event_json FROM delegated_applied_events WHERE workspace_id=? AND account_id=? AND id=?').get(this.deps.workspaceId, accountId, input.originalCall.outcomeEventId) as { event_json: string } | undefined;
      const handoff = new DelegationRepository(this.deps).getManualHandoff(input.originalCall.handoffId);
      if (!command || !event || !handoff || !handoff.consumedAt) throw new Error('requested_call_missing');
      const { accountId: handoffAccountId, authorityGeneration: handoffGeneration, consumedAt: _consumed, ...originalHandoff } = handoff;
      void _consumed;
      // Manual and model mode keep the single `connected` origin they always had. Template mode names the wider
      // set the template choice covers, because David decided a follow-up drafts after every call outcome.
      const allowedOutcomes = input.mode === 'template' ? FOLLOWUP_TEMPLATE_OUTCOMES : REQUESTED_CONNECTED_ONLY;
      const originalCall = validateRequestedOriginalCall({ workspaceId: this.deps.workspaceId, accountId, reference: input.originalCall, command: JSON.parse(command.command_json), commandFingerprint: command.fingerprint,
        event: JSON.parse(event.event_json), handoff: originalHandoff, handoffAccountId, handoffGeneration, allowedOutcomes });
      // Immutable original receipt plus current enrollment/conflict evidence share
      // this SQL snapshot (and the immediate save transaction), not mutable lastOutcome.
      const receipt = raw.prepare(`SELECT r.*,e.campaign_version_id,e.state AS enrollment_state FROM campaign_step_receipts r
        JOIN campaign_enrollments e ON e.workspace_id=r.workspace_id AND e.account_id=r.account_id AND e.id=r.enrollment_id
        WHERE r.workspace_id=? AND r.account_id=? AND r.command_id=?`).get(this.deps.workspaceId, accountId, input.originalCall.commandId) as {
          enrollment_id: string; step_id: string; route_id: string; route_version: number; execution_context_id: string; context_revision: number;
          action_id: string; channel: string; state: string; outcome: string; source: string; campaign_version_id: string; enrollment_state: string;
        } | undefined;
      const evidence = originalCall.event.campaign?.evidence, h = originalCall.handoff;
      if (!receipt || !evidence || receipt.enrollment_id !== h.campaign.enrollmentId || receipt.step_id !== h.campaign.stepId
        || receipt.action_id !== h.actionId || receipt.route_id !== h.routeId || receipt.route_version !== h.routeVersion || receipt.execution_context_id !== h.contextRevision
        || receipt.channel !== 'call' || receipt.state !== 'human_reported_sent' || receipt.outcome !== originalCall.command.payload.outcome.outcome || receipt.source !== 'human'
        || receipt.campaign_version_id !== evidence.campaignVersionId || receipt.context_revision !== evidence.contextRevision
        || !['active', 'conversation', 'completed'].includes(receipt.enrollment_state)) throw new Error('requested_call_origin_invalid');
      if (raw.prepare(`SELECT 1 FROM campaign_step_receipts WHERE workspace_id=? AND account_id=? AND enrollment_id=?
        AND (outcome LIKE 'conflict:%' OR outcome='opt_out') LIMIT 1`).get(this.deps.workspaceId, accountId, receipt.enrollment_id)
        || raw.prepare(`SELECT 1 FROM delegated_applied_events WHERE workspace_id=? AND account_id=?
          AND json_extract(event_json,'$.campaign.evidence.enrollmentId')=?
          AND (json_extract(event_json,'$.campaign.evidence.conflict') IS NOT NULL OR json_extract(event_json,'$.campaign.evidence.outcome')='opt_out') LIMIT 1`)
          .get(this.deps.workspaceId, accountId, receipt.enrollment_id)) throw new Error('requested_call_conflict');
      if (originalCall.event.authorityGeneration > owner.generation || originalCall.event.aggregateVersion > owner.aggregate_version) throw new Error('requested_call_future');
      if (this.intake.isSuppressed(accountId) || raw.prepare("SELECT 1 FROM pm_handle_suppression_tombstones WHERE kind='email' AND normalized_value=? LIMIT 1").get(input.recipientBinding.email.toLowerCase())) throw new Error('requested_suppressed');
      const mailbox = this.deps.mailbox();
      const actualDigest = this.intake.inboundContext(accountId, mailbox.subject);
      let cursor = this.intake.cursorState(accountId, mailbox.subject);
      if (owner.owner === 'worker') {
        if (!this.deps.ownerContext) throw new Error('requested_owner_context_required');
        // The main-process closure rechecks its lease, transport and abort state on every consumption.
        const proof = this.deps.ownerContext(input);
        const expiry = Date.parse(proof.expiresAt), now = Date.parse(this.deps.clock.now());
        if (!Number.isFinite(expiry) || expiry <= now || expiry > now + 60000) throw new Error('requested_owner_context_expired');
        if (proof.workspaceId !== this.deps.workspaceId || proof.accountId !== accountId || proof.authorityGeneration !== owner.generation || proof.aggregateVersion !== owner.aggregate_version
          || proof.accountVersion !== account.account.version || proof.researchRevision !== account.researchRevision || proof.mailbox.subject !== mailbox.subject || proof.mailbox.sender !== mailbox.sender) throw new Error('requested_owner_context_mismatch');
        cursor = proof.cursor ? { rev: z.number().int().positive().safe().parse(proof.cursor.rev), data: mailCursorEnvelopeSchema.parse(proof.cursor.data) } : null;
        for (const identity of [cursor?.data.scope, cursor?.data.checkpoint, cursor?.data.poll]) if (identity && (identity.accountId !== accountId || identity.mailboxSubject !== mailbox.subject)) throw new Error('requested_owner_context_mismatch');
        const claimed = requestedMailContextSchema.parse(proof.mailContext);
        if (accountFingerprint(claimed) !== accountFingerprint(requestedMailContext(cursor?.data ?? null, actualDigest))) throw new Error('requested_owner_context_mismatch');
      }
      const mailContext = requestedMailContext(cursor?.data ?? null, actualDigest);
      return { account, originalCall, mailbox, mailContext, cursor };
    };
    return raw.inTransaction ? read() : raw.transaction(read).deferred();
  }
  /** The template as this Mac holds it. Template mode renders from this text, never from a caller's text. */
  template(templateId: ReplyTemplateId): ReplyTemplate {
    return new SqlReplyTemplateRepository(this.deps).get(templateId);
  }
  get(accountId: string, draftId: string): SavedRequestedFollowup | null {
    const row = this.deps.database.raw.prepare('SELECT draft_json,approval_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND account_id=? AND id=?').get(this.deps.workspaceId, accountId, draftId) as { draft_json: string; approval_json: string | null } | undefined;
    if (!row) return null;
    const draft = requestedFollowupDraftSchema.parse(JSON.parse(row.draft_json));
    if (draft.accountId !== accountId || draft.id !== draftId) throw new Error('requested_draft_identity_conflict');
    let stale = true;
    try { const context = this.readContext({ accountId, originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, expectedAccountVersion: draft.accountVersion, mode: 'manual' });
      validateRequestedDraftContext(draft, context); stale = context.mailContext.inboundContextRevision === null || context.cursor?.data.poll?.status !== 'complete';
    } catch { /* Retain editable text while denying readiness. */ }
    return { draft, stale, approval: row.approval_json ? requestedApprovalStatusSchema.parse(JSON.parse(row.approval_json)) : null };
  }
  save(input: RequestedFollowupDraft, expectedRevision: number | null): RequestedFollowupDraft {
    const draft = requestedFollowupDraftSchema.parse(input), raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('requested_draft_requires_own_transaction');
    return raw.transaction(() => {
      const previous = this.get(draft.accountId, draft.id)?.draft ?? null;
      validateRequestedDraftRevision(draft, previous, expectedRevision);
      const context = this.readContext({ accountId: draft.accountId, originalCall: draft.originalCall, recipientBinding: draft.recipientBinding, expectedAccountVersion: draft.accountVersion, mode: 'manual' });
      validateRequestedDraftContext(draft, context);
      raw.prepare(`INSERT INTO delegated_requested_followup_drafts(workspace_id,account_id,id,revision,context_revision,draft_json,approval_json,updated_at) VALUES(?,?,?,?,?,?,NULL,?)
        ON CONFLICT(workspace_id,account_id,id) DO UPDATE SET revision=excluded.revision,context_revision=excluded.context_revision,draft_json=excluded.draft_json,approval_json=NULL,updated_at=excluded.updated_at`)
        .run(this.deps.workspaceId, draft.accountId, draft.id, draft.revision, draft.contextRevision, JSON.stringify(draft), draft.updatedAt);
      return draft;
    }).immediate();
  }
}
