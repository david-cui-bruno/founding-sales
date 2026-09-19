import { withDailyAnswerPresentation } from './dailyAnswerPresentation';
import { readWorkflowMode } from '../workspace/legacyWorkflowTransition';
import type { AppDatabase } from '../../db/database';
import type { Clock } from '../support/clock';
import type { IdGenerator } from '../support/idGenerator';
import type { TodayService } from './todayService';
import { resolveAccountCallAllocation, type WorkspaceSettingsRepository } from '../workspace/workspaceSettingsRepository';
import { accountFingerprint } from '../accounts/accountEvidence';
import { AccountRepository } from '../accounts/accountRepository';
import { CampaignRepository } from '../campaign/campaignRepository';
import { DelegationRepository } from '../../delegation/delegationRepository';
import { LinkedInRepository } from '../../linkedin/linkedInRepository';
import { dailyAccountSchema, dailyAnswerSchema, dailyCampaignSchema, dailyOwnerStatusSchema, dailyTransportSchema, type DailySnapshot } from '../../../shared/contracts/dailyContract';
import { accountReplyDraftSchema, threadProjectionSchema } from '../../../shared/contracts/mailThreadContract';
import { requestedFollowupDraftSchema, requestedApprovalStatusSchema } from '../../../shared/contracts/requestedFollowupContract';
import { campaignVersionSchema } from '../../../shared/contracts/campaignContract';
import { accountIdSchema } from '../../../shared/contracts/accountContract';
import { heldTemplateEmailSchema, sentTemplateEmailSchema, type HeldTemplateEmail, type SentTemplateEmail } from '../../../shared/contracts/todayContract';
import { workerEventSchema } from '../../../shared/contracts/delegationContract';
import { templateSequenceEmailTemplateId } from '../../../shared/outreach/templateSequenceEmail';
import { buildDailySnapshot, type DailyProjectionInput } from './dailyProjection';
import { AccountCallbackRepository } from '../callbacks/accountCallbackRepository';
import { localDateIn } from '../../../shared/contracts/accountCallbackContract';
import { readRouteJurisdictionTimezones } from './routeJurisdiction';
import { readUsageSummary } from '../usage/usageReadService';

type Row = Record<string, unknown>;
/** One deferred local snapshot. Dependencies expose no transport or draft generation. */
export class DailyReadService {
  constructor(private readonly deps: { database: AppDatabase; clock: Clock; ids: IdGenerator; today: TodayService; settings: WorkspaceSettingsRepository; workspaceId?: string }) {}
  get(): DailySnapshot {
    const raw = this.deps.database.raw;
    if (raw.inTransaction) throw new Error('daily_read_transaction_scope');
    const generatedAt = this.deps.clock.now();
    return raw.transaction(() => this.read(generatedAt)).deferred();
  }
  private read(generatedAt: string): DailySnapshot {
    const { database, clock, ids, today, settings } = this.deps;
    const raw = database.raw;
    const workspaceId = accountIdSchema.safeParse(this.deps.workspaceId).success ? this.deps.workspaceId! : null;
    const input: DailyProjectionInput = { workspaceId, generatedAt, workflowMode: 'unknown', accounts: [], callbacks: [], calls: { accountIds: [], workloadConflict: false },
      callSettings: { newCallSlots: null, totalCallCapacity: null }, approvals: [], campaigns: [], ownerStatus: [], transport: [], issues: [] };
    const issue = (code: DailyProjectionInput['issues'][number]['code']) => input.issues.push({ code, count: 1 });
    // Failed top-level queries reject. Corrupt records or failed dependent reads produce incomplete snapshots with bounded issues.
    const rows = (sql: string, ...args: string[]) => raw.prepare(sql).all(...args) as Row[];
    const parse = <T>(read: () => T): T | null => { try { return read(); } catch { issue('invalid_local_record'); return null; } };
    input.workflowMode = parse(() => readWorkflowMode(database)) ?? 'unknown';
    // The stored record goes into the hashed snapshot unchanged. Unconfigured settings resolve to the default allocation
    // (30 new firms a morning) reported beside it as `allocation`; a chosen state, not an incomplete snapshot, so no issue.
    const stored = parse(() => settings.readMeetingFirstAccountCallSettings());
    if (stored) {
      input.callSettings = { newCallSlots: stored.newCallSlots, totalCallCapacity: stored.totalCallCapacity };
      const allocation = resolveAccountCallAllocation(stored);
      input.allocation = { newCallSlots: allocation.newCallSlots, source: allocation.source };
    }
    if (workspaceId === null) return buildDailySnapshot(input);
    const accounts = new AccountRepository({ database, clock, ids });
    // Accounts live in this encrypted workspace DB. Explicit foreign owner bindings are excluded.
    for (const row of rows('SELECT a.id FROM pm_accounts a LEFT JOIN delegated_authorities d ON d.account_id=a.id WHERE d.workspace_id IS NULL OR d.workspace_id=? ORDER BY a.id', workspaceId)) {
      const account = parse(() => dailyAccountSchema.parse(accounts.snapshot(String(row.id), generatedAt)));
      if (account) input.accounts.push(account);
    }
    const accountIds = new Set(input.accounts.map(a => a.account.id));
    const scoped = (accountId: unknown) => { if (typeof accountId === 'string' && accountIds.has(accountId)) return true; issue('scope_mismatch'); return false; };
    const delegation = new DelegationRepository({ database, workspaceId, clock });
    const campaign = new CampaignRepository({ database, workspaceId, clock });
    const due = new Set<string>();
    for (const row of rows('SELECT id,campaign_id,version,snapshot_json,snapshot_hash FROM campaign_versions WHERE workspace_id=? ORDER BY campaign_id,version,id', workspaceId)) {
      const value = parse(() => {
        const frozen = campaignVersionSchema.parse(JSON.parse(String(row.snapshot_json)));
        if (frozen.id !== row.id || frozen.campaignId !== row.campaign_id || frozen.version !== row.version
          || accountFingerprint(frozen) !== row.snapshot_hash) throw Error('campaign_frozen_identity_mismatch');
        // getVersion applies the separately persisted approval timestamp only after frozen-row validation.
        const version = campaign.getVersion(frozen.id);
        if (!version.cohortAccountIds.every(id => accountIds.has(id))) { issue('scope_mismatch'); return null; }
        const enrollments = rows('SELECT id FROM campaign_enrollments WHERE workspace_id=? AND campaign_version_id=? ORDER BY id', workspaceId, version.id).map(e => campaign.getEnrollment(String(e.id)));
        const caps = rows('SELECT campaign_version_id AS campaignVersionId,channel,revision,reserved,sent FROM campaign_caps WHERE workspace_id=? AND campaign_version_id=? ORDER BY channel', workspaceId, version.id);
        return dailyCampaignSchema.parse({ version, snapshotHash: row.snapshot_hash, caps, enrollments });
      });
      if (!value) continue;
      input.campaigns.push(value);
      for (const enrollment of value.enrollments) {
        const step = value.version.steps.find(s => s.id === enrollment.currentStepId);
        if (enrollment.state !== 'active' || step?.channel !== 'call') continue;
        // D13: the worker carries the current step's due instant on the enrollment. Without it the
        // initial step's persisted timing still decides; a later step with no carried timing stays unknown.
        const carried = enrollment.nextDueAt ?? null;
        if (carried === null && step.condition !== 'initial') { issue('call_due_unknown'); continue; }
        const dueAt = carried === null ? Date.parse(enrollment.startedAt) + step.delayHours * 3600000 : Date.parse(carried);
        if (!Number.isFinite(dueAt)) { issue('call_due_unknown'); continue; }
        if (dueAt <= Date.parse(generatedAt)) due.add(enrollment.accountId);
      }
    }
    // A promise David made leads the morning list on its own day, in the firm's own zone.
    const callbacks = parse(() => new AccountCallbackRepository({ database, clock }).listOpen([...accountIds])) ?? [];
    input.callbacks = callbacks;
    const zones = parse(() => readRouteJurisdictionTimezones(database, [...accountIds])) ?? new Map<string, string>();
    const workspaceZone = parse(() => settings.read().timezone) ?? 'UTC';
    const dueToday = new Set(callbacks.filter(callback => {
      try { return callback.dueOn <= localDateIn(generatedAt, zones.get(callback.accountId) ?? workspaceZone); }
      catch { issue('invalid_local_record'); return false; }
    }).map(callback => callback.accountId));
    for (const accountId of dueToday) due.delete(accountId);
    let pendingByAccount: Map<string, ReturnType<DelegationRepository['pendingCommands']>> | undefined;
    let pendingFailure: { error: unknown } | undefined;
    const pendingForAccount = (accountId: string) => {
      if (pendingFailure) throw pendingFailure.error;
      if (!pendingByAccount) {
        try {
          const index = new Map<string, ReturnType<DelegationRepository['pendingCommands']>>();
          // Validate the entire workspace history before indexing, including undisplayed accounts.
          for (const command of delegation.pendingCommands()) {
            const commands = index.get(command.accountId) ?? [];
            commands.push(command);
            index.set(command.accountId, commands);
          }
          pendingByAccount = index;
        } catch (error) {
          // Replay failure inside each owner's parse boundary to preserve its issue count.
          pendingFailure = { error };
          throw error;
        }
      }
      return pendingByAccount.get(accountId) ?? [];
    };
    for (const account of input.accounts) {
      const owner = parse(() => {
        const authority = delegation.authority(account.account.id);
        // Stay lazy until authority succeeds. Zero accounts or all failed authorities never scan.
        const pendingCommands = pendingForAccount(account.account.id).map(c => delegation.commandStatus(c.commandId)!);
        return dailyOwnerStatusSchema.parse({ accountId: account.account.id, authority, executionVersion: delegation.executionVersion(account.account.id), pendingCommands,
          status: pendingCommands.length ? 'pending' : authority?.owner === 'worker' ? 'owner_applied' : 'unknown' });
      });
      if (owner) input.ownerStatus.push(owner);
    }
    for (const row of rows('SELECT * FROM delegated_requested_followup_drafts WHERE workspace_id=? ORDER BY account_id,id', workspaceId)) {
      if (!scoped(row.account_id)) continue;
      const value = parse(() => {
        const draft = requestedFollowupDraftSchema.parse(JSON.parse(String(row.draft_json)));
        if (draft.id !== row.id || draft.accountId !== row.account_id || draft.revision !== row.revision || draft.contextRevision !== row.context_revision) throw Error('draft_identity_mismatch');
        const approval = row.approval_json === null ? null : parse(() => {
          const saved = requestedApprovalStatusSchema.parse(JSON.parse(String(row.approval_json)));
          const command = delegation.getCommand(saved.receipt.commandId);
          if (command?.kind !== 'approve-requested-followup' || command.workspaceId !== workspaceId || command.commandId !== saved.receipt.commandId || command.accountId !== draft.accountId || accountFingerprint(command.payload.draft) !== accountFingerprint(draft)) throw Error('approval_draft_mismatch');
          const status = delegation.requestedApprovalStatus(command.commandId);
          if (!status || status.receipt.commandId !== command.commandId) throw Error('approval_status_identity_mismatch');
          return status;
        });
        return dailyAnswerSchema.parse({ kind: 'requested_followup', accountId: row.account_id, draft,
          approval, capability: 'held', reason: 'requires_owner_preflight' });
      });
      if (value) input.approvals.push(withDailyAnswerPresentation(database, workspaceId, generatedAt, value));
    }
    for (const row of rows('SELECT * FROM delegated_threads WHERE workspace_id=? ORDER BY account_id,id', workspaceId)) {
      if (!scoped(row.account_id)) continue;
      const values = parse(() => {
        const thread = threadProjectionSchema.parse(JSON.parse(String(row.projection_json)));
        if (thread.thread.accountId !== row.account_id || thread.thread.providerThreadId !== row.id || thread.revision !== row.revision || thread.contextRevision !== row.context_revision) throw Error('thread_identity_mismatch');
        if (!thread.signals.length) return [];
        const drafts = rows('SELECT * FROM delegated_reply_drafts WHERE workspace_id=? AND account_id=? AND thread_id=? ORDER BY id', workspaceId, String(row.account_id), String(row.id));
        return (drafts.length ? drafts : [null]).map(saved => {
          const draft = saved ? accountReplyDraftSchema.parse(JSON.parse(String(saved.draft_json))) : null;
          if (draft && (draft.id !== saved!.id || draft.revision !== saved!.revision || draft.accountId !== row.account_id || draft.threadId !== row.id || draft.mailboxSubject !== thread.thread.mailboxSubject)) throw Error('reply_identity_mismatch');
          return dailyAnswerSchema.parse({ kind: 'reply', accountId: row.account_id, thread, draft, stale: draft !== null && (draft.threadRevision !== thread.revision || draft.contextRevision !== thread.contextRevision), capability: 'held', reason: 'reply_capability_unverified' });
        });
      });
      if (values) input.approvals.push(...values);
    }
    // The morning list is planned only after the stored reply threads are read, because a firm that
    // answered leads it. Lane 32 writes the first draft; the reply itself is the reason to call, so a
    // thread with signals leads whether or not a draft was saved for it yet. No new command, no send.
    const replied = new Set(input.approvals.filter(answer => answer.kind === 'reply').map(answer => answer.accountId));
    const plan = parse(() => today.planMeetingFirstAccountCalls({ replies: input.accounts.filter(a => replied.has(a.account.id)),
      callbacks: input.accounts.filter(a => dueToday.has(a.account.id)),
      due: input.accounts.filter(a => due.has(a.account.id)), ranked: input.accounts, generatedAt }));
    if (plan) input.calls = { accountIds: [...plan.accountIds], workloadConflict: plan.workloadConflict };
    // Sequence emails the provider accepted (D13, lane 40). The only record of one on this Mac is the
    // immutable outcome row the worker's own `action.outcome` event wrote, and the template is the one that
    // row's worker-minted action id names — never anything read out of the text that went out. A row whose
    // action id is not a template sequence action is not a template email and adds nothing to Today.
    const sentTemplateEmails: SentTemplateEmail[] = [];
    for (const row of rows("SELECT account_id,action_id,observed_at FROM delegated_action_outcomes WHERE workspace_id=? AND state='provider_accepted' ORDER BY observed_at,action_id", workspaceId)) {
      const templateId = templateSequenceEmailTemplateId(row.action_id);
      if (templateId === null) continue;
      if (!scoped(row.account_id)) continue;
      const value = parse(() => sentTemplateEmailSchema.parse({ accountId: row.account_id, templateId, actionId: row.action_id,
        sentOn: localDateIn(String(row.observed_at), workspaceZone) }));
      if (value) sentTemplateEmails.push(value);
    }
    if (sentTemplateEmails.length) input.calls = { ...input.calls, sentTemplateEmails };
    // Email steps of the sequence that have not gone out, and the reason each has not (D13, lane 41). The worker
    // publishes the whole held set of a firm whenever it changes, including the empty set when the last one clears,
    // so the newest `territory.steps_held` event of a firm is the whole truth about that firm and an older one is
    // never merged into it. Reading a held step sends nothing, clears nothing and writes nothing.
    const heldTemplateEmails: HeldTemplateEmail[] = [];
    const newestHeld = new Map<string, unknown>();
    for (const row of rows(`SELECT account_id,event_json FROM delegated_applied_events WHERE workspace_id=?
      AND json_extract(event_json,'$.kind')='territory.steps_held' ORDER BY account_id,aggregate_version`, workspaceId)) {
      if (!scoped(row.account_id)) continue;
      newestHeld.set(String(row.account_id), row.event_json);
    }
    for (const [accountId, json] of newestHeld) {
      const steps = parse(() => {
        const event = workerEventSchema.parse(JSON.parse(String(json)));
        if (event.kind !== 'territory.steps_held' || event.accountId !== accountId) throw Error('held_step_identity_mismatch');
        return event.payload.heldSteps;
      });
      for (const step of steps ?? []) {
        const value = parse(() => heldTemplateEmailSchema.parse({ accountId, templateId: step.templateId, stepId: step.stepId, reason: step.reason }));
        if (value) heldTemplateEmails.push(value);
      }
    }
    if (heldTemplateEmails.length) input.calls = { ...input.calls, heldTemplateEmails };
    for (const row of rows("SELECT id,enrollment_id,account_id,revision FROM manual_linkedin_drafts WHERE workspace_id=? AND state<>'closed' ORDER BY account_id,id", workspaceId)) {
      if (!scoped(row.account_id)) continue;
      const value = parse(() => {
        const repository = new LinkedInRepository({ database, workspaceId, clock, enrollmentId: String(row.enrollment_id) });
        const draft = repository.requireRevision(String(row.id), Number(row.revision));
        const record = repository.actionRecord(draft.id, draft.revision);
        const handoffId = repository.handoffId(record.identity);
        const handoff = handoffId ? delegation.getManualHandoff(handoffId) : null;
        return dailyAnswerSchema.parse({ kind: 'manual_linkedin', accountId: row.account_id, draft, capability: 'manual_only', recovery: {
          draftId: draft.id, revision: draft.revision, approvalCommandId: record.approvalCommandId,
          attempts: record.commandIds.map(commandId => ({ commandId, receipt: delegation.commandStatus(commandId) })), handoffId, started: handoff?.consumedAt != null } });
      });
      if (value) input.approvals.push(withDailyAnswerPresentation(database, workspaceId, generatedAt, value));
    }
    for (const row of rows('SELECT pairing_id AS pairingId,revision,state,started_at AS startedAt,completed_at AS completedAt FROM delegated_transport_state WHERE workspace_id=? ORDER BY pairing_id', workspaceId)) {
      const value = parse(() => dailyTransportSchema.parse(row));
      if (value) { input.transport.push(value); if (value.state !== 'complete') issue('transport_incomplete'); }
    }
    const research = raw.prepare("SELECT COUNT(*) AS count FROM pm_account_research_jobs j WHERE j.state='parked' AND EXISTS(SELECT 1 FROM pm_accounts a LEFT JOIN delegated_authorities d ON d.account_id=a.id WHERE a.id=j.account_id AND (d.workspace_id IS NULL OR d.workspace_id=?))").get(workspaceId) as { count: number };
    if (research.count > 0) input.issues.push({ code: 'research_failed', count: research.count });
    // Measured use, derived from the stored records. A summary that cannot be derived is absent rather
    // than zeroed, and its absence is not an incomplete snapshot: no morning work depends on it.
    try {
      input.usage = readUsageSummary(database, { workspaceId, accountIds: [...accountIds], generatedAt, timezone: workspaceZone });
    } catch { input.usage = undefined; }
    return buildDailySnapshot(input);
  }
}
