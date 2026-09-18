import {requestedApprovalStatusSchema,requestedFollowupDraftSchema,type RequestedApprovalStatus} from '../../shared/contracts/requestedFollowupContract';
import { createHash, randomUUID } from 'node:crypto';
import type { AppDatabase } from '../db/database';
import type { Clock } from '../domain/support/clock';
import { accountFingerprint } from '../domain/accounts/accountEvidence';
import { AccountRepository } from '../domain/accounts/accountRepository';
import { legacyRouteSuppression } from '../domain/accounts/accountOutreach';
import { CampaignRepository } from '../domain/campaign/campaignRepository';
import { manualHandoffSchema, type ManualHandoff } from '../../shared/contracts/ownerCommandContract';
import type { AccountSourcePolicy } from '../domain/accounts/accountRepository';
import { accountIdSchema, accountInstantSchema } from '../../shared/contracts/accountContract';
import { approvalSnapshotSchema, authorityStateSchema, commandReceiptSchema, delegationCommandSchema, workerEventSchema,
  type ApprovalSnapshot, type AuthorityState, type CommandReceipt, type DelegationCommand, type WorkerEvent } from '../../shared/contracts/delegationContract';

import { meetingOutcomePayloadSchema } from '../../shared/contracts/meetingContract';
import { threadProjectionSchema, type ThreadProjection } from '../../shared/contracts/mailThreadContract';

type AuthorityRow = { account_id: string; workspace_id: string; owner: 'local' | 'worker'; generation: number;
  state: AuthorityState['state']; aggregate_version: number };
/** Local outbox and authenticated-worker projection. This class never dispatches. */
export class DelegationRepository {
  constructor(private readonly deps: { database: AppDatabase; workspaceId: string; clock: Clock; sourcePolicy?: AccountSourcePolicy }) {
    accountIdSchema.parse(deps.workspaceId);
  }
  private get raw() { return this.deps.database.raw; }
  private now() { return accountInstantSchema.parse(this.deps.clock.now()); }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('Delegation requires its own scoped transaction');
    return this.raw.transaction(run).immediate();
  }
  private owner(accountId: string): AuthorityRow | undefined {
    const row = this.raw.prepare('SELECT * FROM delegated_authorities WHERE account_id=?').get(accountId) as AuthorityRow | undefined;
    if (row && row.workspace_id !== this.deps.workspaceId) throw new Error('Workspace authority mismatch');
    return row;
  }
  authority(accountId: string): AuthorityState | null {
    const row = this.owner(accountIdSchema.parse(accountId));
    return row ? authorityStateSchema.parse({ accountId: row.account_id, owner: row.owner, generation: row.generation, state: row.state }) : null;
  }
  /** Explicit composition/operator operation, never called by account creation or research. No takeover. */
  initializeLocalAuthority(accountId: string): AuthorityState {
    accountIdSchema.parse(accountId);
    return this.atomic(() => {
      const old = this.owner(accountId);
      if (old) {
        if (old.owner !== 'local' || old.state !== 'local' || old.generation !== 0) throw new Error('Authority already assigned');
      } else this.raw.prepare("INSERT INTO delegated_authorities VALUES(?,?,'local',0,'local',0,?)").run(accountId, this.deps.workspaceId, this.now());
      return this.authority(accountId)!;
    });
  }
  queueCommand(input: DelegationCommand, assertCurrent?: () => void): CommandReceipt {
    const command = delegationCommandSchema.parse(input);
    if (command.workspaceId !== this.deps.workspaceId) throw new Error('Workspace command mismatch');
    // The account outbox is keyed by a researched company; the workspace-level policy travels the runtime's own path.
    if (command.kind === 'territory-policy') throw new Error('territory_policy_requires_policy_path');
    const fingerprint = accountFingerprint(command);
    return this.atomic(() => {
      assertCurrent?.();
      const prior = this.raw.prepare('SELECT fingerprint,receipt_json FROM delegated_commands WHERE command_id=?').get(command.commandId) as { fingerprint: string; receipt_json: string } | undefined;
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new Error('Command fingerprint conflict');
        return commandReceiptSchema.parse(JSON.parse(prior.receipt_json));
      }
      const owner = this.owner(command.accountId);
      if(command.kind==='complete-manual'){
        const handoff=this.getManualHandoff(command.payload.handoffId);const outcome=command.payload.outcome;
        if(!handoff||handoff.consumedAt===null||handoff.accountId!==command.accountId||handoff.actionId!==outcome.actionId||handoff.channel!==outcome.channel||handoff.targetHash!==command.payload.targetHash||outcome.observedAt<handoff.consumedAt||outcome.observedAt>this.now())throw Error('manual_started_identity_required');
        if(outcome.outcome==='opt_out')this.raw.prepare('INSERT OR IGNORE INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)').run(`manual-${command.commandId}`,command.accountId,outcome.observedAt,'manual_owner_report',outcome.evidenceRef,this.now());
      }
      const valid = owner !== undefined && owner.generation === command.expectedAuthorityGeneration && owner.aggregate_version === command.expectedVersion;
      const receipt: CommandReceipt = { commandId: command.commandId, status: valid ? 'pending' : 'rejected',
        authorityGeneration: owner?.generation ?? 0, aggregateVersion: owner?.aggregate_version ?? 0, reason: valid ? null : 'Missing or stale authority' };
      this.raw.prepare('INSERT INTO delegated_commands VALUES(?,?,?,?,?,?,?)')
        .run(command.commandId, command.workspaceId, command.accountId, fingerprint, JSON.stringify(command), JSON.stringify(receipt), this.now());
      if(command.kind==='approve-requested-followup'){
        const row=this.raw.prepare('SELECT draft_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND account_id=? AND id=?').get(command.workspaceId,command.accountId,command.payload.draft.id) as {draft_json:string}|undefined;
        if(!row||accountFingerprint(requestedFollowupDraftSchema.parse(JSON.parse(row.draft_json)))!==accountFingerprint(command.payload.draft))throw Error('requested_saved_content_mismatch');
        const status=requestedApprovalStatusSchema.parse({receipt,state:receipt.status==='rejected'?'needs_review':'pending_preflight',intentCommandId:null,reason:receipt.reason});
        this.raw.prepare('UPDATE delegated_requested_followup_drafts SET approval_json=? WHERE workspace_id=? AND account_id=? AND id=?').run(JSON.stringify(status),command.workspaceId,command.accountId,command.payload.draft.id);
      }
      if (valid && command.kind === 'delegate') {
        if (owner.owner !== 'local' || owner.state !== 'local') throw new Error('Invalid delegation owner');
        this.raw.prepare("UPDATE delegated_authorities SET state='delegating',updated_at=? WHERE account_id=?").run(this.now(), command.accountId);
      }
      return receipt;
    });
  }
  executionVersion(accountId: string): number | null { return this.owner(accountIdSchema.parse(accountId))?.aggregate_version ?? null; }
  getCommand(commandId: string): DelegationCommand | null {
    const row = this.raw.prepare('SELECT command_json FROM delegated_commands WHERE workspace_id=? AND command_id=?').get(this.deps.workspaceId, commandId) as { command_json: string } | undefined;
    return row ? delegationCommandSchema.parse(JSON.parse(row.command_json)) : null;
  }
  pendingCommands(): DelegationCommand[] {
    const rows = this.raw.prepare('SELECT command_json FROM delegated_commands WHERE workspace_id=? ORDER BY created_at,command_id').all(this.deps.workspaceId) as { command_json: string }[];
    return rows.map(row => delegationCommandSchema.parse(JSON.parse(row.command_json))).filter(command => this.commandStatus(command.commandId)?.status === 'pending');
  }
  hasPendingStop(accountId: string): boolean {
    if(this.pendingCommands().some(command => command.accountId === accountId && ['pause','revoke','complete-manual'].includes(command.kind)))return true;
    const stops=(this.raw.prepare("SELECT command_json FROM delegated_commands WHERE workspace_id=? AND account_id=? AND json_extract(command_json,'$.kind') IN('pause','revoke')").all(this.deps.workspaceId,accountId) as {command_json:string}[]).map(row=>delegationCommandSchema.parse(JSON.parse(row.command_json))).map(command=>this.commandStatus(command.commandId));
    const applied=Math.max(-1,...stops.filter(receipt=>receipt?.status==='applied').map(receipt=>receipt!.aggregateVersion));
    return stops.some(receipt=>receipt?.status==='rejected'&&receipt.aggregateVersion>applied);
  }
  /** queueCommand already atomically set delegating. All local dispatch fences
   * read that row, so no new local intent can appear after this scoped check. */
  canSubmitCommand(commandId: string): boolean {
    return this.atomic(() => {
      const command = this.pendingCommands().find(value => value.commandId === commandId);
      if (!command) return false;
      const owner = this.owner(command.accountId);
      if(command.kind==='complete-manual'){const handoff=this.getManualHandoff(command.payload.handoffId);return !!owner&&owner.owner==='worker'&&['active','paused','revoked'].includes(owner.state)&&command.expectedAuthorityGeneration<=owner.generation&&command.expectedVersion<=owner.aggregate_version&&!!handoff&&handoff.consumedAt!==null&&handoff.accountId===command.accountId&&handoff.authorityGeneration<=command.expectedAuthorityGeneration;}
      if (!owner || owner.generation !== command.expectedAuthorityGeneration || owner.aggregate_version !== command.expectedVersion) return false;
      if(command.kind==='bootstrap-selected-account')return owner.owner==='local'&&owner.state==='local'&&owner.generation===0&&owner.aggregate_version===0;
      if (command.kind !== 'delegate') return owner.owner === 'worker' && (command.kind === 'pause' || command.kind === 'revoke'
        ? ['active','paused'].includes(owner.state) : owner.state === 'active' && !this.hasPendingStop(command.accountId));
      if (owner.owner !== 'local' || owner.state !== 'delegating') return false;
      const accountPending = this.raw.prepare(`SELECT 1 FROM pm_account_outbound_intents i WHERE i.account_id=? AND i.channel='email'
        AND NOT EXISTS(SELECT 1 FROM pm_account_outbound_results r WHERE r.command_id=i.command_id AND r.outcome IN('accepted','provider_accepted','not_sent','cancelled')) LIMIT 1`).get(command.accountId);
      const legacyPending = this.raw.prepare(`SELECT 1 FROM email_send_intents i JOIN email_drafts d ON d.id=i.draft_id
        LEFT JOIN email_send_results r ON r.command_id=i.command_id WHERE (r.status IS NULL OR r.status='unknown') AND
        (EXISTS(SELECT 1 FROM pm_account_links l WHERE l.account_id=? AND l.person_id=d.person_id)
        OR EXISTS(SELECT 1 FROM pm_account_routes ar WHERE ar.account_id=? AND (ar.person_id=d.person_id OR (ar.channel='email' AND lower(ar.value)=lower(d.recipient))))) LIMIT 1`)
        .get(command.accountId, command.accountId);
      return !accountPending && !legacyPending;
    });
  }
  /** A queued receipt is immutable. Owner-applied receipts are read separately. */
  commandStatus(commandId: string): CommandReceipt | null {
    const applied = this.raw.prepare(`SELECT event_json FROM delegated_applied_events WHERE workspace_id=?
      AND ((json_extract(event_json,'$.kind')='requested_followup.status' AND json_extract(event_json,'$.payload.commandId')=?)
        OR (json_extract(event_json,'$.kind')='authority.changed' AND json_extract(event_json,'$.payload.receipt.commandId')=?)
        OR (json_extract(event_json,'$.kind') IN('account.bootstrap','account.refreshed','manual.outcome','manual.handoff','campaign.changed','acquisition.milestone_reported') AND json_extract(event_json,'$.receipt.commandId')=?)) ORDER BY aggregate_version DESC LIMIT 1`)
      .get(this.deps.workspaceId, commandId, commandId, commandId) as { event_json: string } | undefined;
    if (applied) {
      const event = workerEventSchema.parse(JSON.parse(applied.event_json));
      if (event.kind === 'requested_followup.status') return event.payload.status.receipt;
      if (event.kind === 'authority.changed') return event.payload.receipt;
      if ('receipt' in event) return event.receipt;
    }
    const queued = this.raw.prepare('SELECT receipt_json FROM delegated_commands WHERE workspace_id=? AND command_id=?').get(this.deps.workspaceId, commandId) as { receipt_json: string } | undefined;
    return queued ? commandReceiptSchema.parse(JSON.parse(queued.receipt_json)) : null;
  }
  /** The saved thread projection as last applied from the owner. No provider read. */
  getThread(accountId: string, threadId: string): ThreadProjection | null {
    const row = this.raw.prepare('SELECT projection_json FROM delegated_threads WHERE workspace_id=? AND account_id=? AND id=?')
      .get(this.deps.workspaceId, accountIdSchema.parse(accountId), accountIdSchema.parse(threadId)) as { projection_json: string } | undefined;
    return row ? threadProjectionSchema.parse(JSON.parse(row.projection_json)) : null;
  }
  /** Every saved-record command (bootstrap or refresh) ever queued for one company, oldest first. Receipts are read separately. */
  selectedAccountRecordCommands(accountId: string): Extract<DelegationCommand, { kind: 'bootstrap-selected-account' | 'refresh-selected-account-record' }>[] {
    const rows = this.raw.prepare(`SELECT command_json FROM delegated_commands WHERE workspace_id=? AND account_id=? AND json_extract(command_json,'$.kind') IN('bootstrap-selected-account','refresh-selected-account-record')
      ORDER BY created_at,command_id`).all(this.deps.workspaceId, accountIdSchema.parse(accountId)) as { command_json: string }[];
    return rows.map(row => delegationCommandSchema.parse(JSON.parse(row.command_json))).filter((command): command is Extract<DelegationCommand, { kind: 'bootstrap-selected-account' | 'refresh-selected-account-record' }> =>
      command.kind === 'bootstrap-selected-account' || command.kind === 'refresh-selected-account-record');
  }
  /** Every configure-owner command ever queued for one company, oldest first. Receipts are read separately. */
  intakeConfigureCommands(accountId: string): Extract<DelegationCommand, { kind: 'configure-owner' }>[] {
    const rows = this.raw.prepare(`SELECT command_json FROM delegated_commands WHERE workspace_id=? AND account_id=? AND json_extract(command_json,'$.kind')='configure-owner'
      ORDER BY created_at,command_id`).all(this.deps.workspaceId, accountIdSchema.parse(accountId)) as { command_json: string }[];
    return rows.map(row => delegationCommandSchema.parse(JSON.parse(row.command_json))).filter((command): command is Extract<DelegationCommand, { kind: 'configure-owner' }> => command.kind === 'configure-owner');
  }
  requestedApprovalStatus(commandId:string):RequestedApprovalStatus|null {
    const command=this.getCommand(commandId);if(command?.kind!=='approve-requested-followup')return null;
    const row=this.raw.prepare("SELECT event_json FROM delegated_applied_events WHERE workspace_id=? AND account_id=? AND json_extract(event_json,'$.kind')='requested_followup.status' AND json_extract(event_json,'$.payload.commandId')=? ORDER BY aggregate_version DESC LIMIT 1").get(command.workspaceId,command.accountId,commandId) as {event_json:string}|undefined;
    if(row){const event=workerEventSchema.parse(JSON.parse(row.event_json));if(event.kind==='requested_followup.status')return event.payload.status;}
    const receipt=this.commandStatus(commandId);return receipt?requestedApprovalStatusSchema.parse({receipt,state:receipt.status==='rejected'?'needs_review':'pending_preflight',intentCommandId:null,reason:receipt.reason}):null;
  }
  getManualHandoff(handoffId: string): (ManualHandoff & { accountId: string; authorityGeneration: number; consumedAt: string | null }) | null {
    const row = this.raw.prepare(`SELECT e.event_json,h.consumed_at FROM delegated_manual_handoffs h JOIN delegated_applied_events e ON e.id=h.event_id
      WHERE h.workspace_id=? AND h.handoff_id=?`).get(this.deps.workspaceId, accountIdSchema.parse(handoffId)) as { event_json: string; consumed_at: string | null } | undefined;
    if (!row) return null;
    const event = workerEventSchema.parse(JSON.parse(row.event_json));
    if (event.kind !== 'manual.handoff') throw new Error('Invalid handoff event');
    return { ...event.payload, accountId: event.accountId, authorityGeneration: event.authorityGeneration, consumedAt: row.consumed_at };
  }
  consumeManualHandoff(input: ManualHandoff & { accountId: string; authorityGeneration: number }, assertCurrent: () => void): { status: 'started' | 'already_started'; handoffId: string } {
    const { accountId, authorityGeneration, ...raw } = input;
    const payload = manualHandoffSchema.parse(raw); accountIdSchema.parse(accountId);
    return this.atomic(() => {
      const handoff = this.getManualHandoff(payload.handoffId);
      if (!handoff) throw new Error('Manual owner acknowledgment missing');
      const { consumedAt, ...identity } = handoff;
      if (accountFingerprint(identity) !== accountFingerprint({ ...payload, accountId, authorityGeneration })) throw new Error('Manual immutable handoff mismatch');
      if (consumedAt !== null) return { status: 'already_started', handoffId: payload.handoffId };
      const owner = this.owner(accountId); const at = this.now();
      if (!owner || owner.owner !== 'worker' || owner.state !== 'active' || owner.generation !== authorityGeneration || this.hasPendingStop(accountId)
        || payload.expiresAt <= at) throw new Error('Manual authority unavailable');
      const snapshot = new AccountRepository({ database: this.deps.database, clock: this.deps.clock, ids: { next: randomUUID } }).snapshot(accountId, at);
      const route = snapshot.routes.find(route => route.id === payload.routeId && route.version === payload.routeVersion);
      if (!route || route.channel !== (payload.channel === 'call' ? 'phone' : 'linkedin') || createHash('sha256').update(route.value).digest('hex') !== payload.targetHash) throw new Error('Manual route changed');
      const legacy = legacyRouteSuppression(this.deps.database, route, at);
      if (legacy.person || legacy.handle || this.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=?').get(accountId)
        || this.raw.prepare('SELECT 1 FROM pm_handle_suppression_tombstones WHERE kind=? AND normalized_value=?').get(route.channel, route.value.toLowerCase())) throw new Error('Manual target suppressed');
      assertCurrent();
      const result = this.raw.prepare('UPDATE delegated_manual_handoffs SET consumed_at=? WHERE workspace_id=? AND handoff_id=? AND consumed_at IS NULL').run(at, this.deps.workspaceId, payload.handoffId);
      if (result.changes !== 1) throw new Error('Manual handoff already consumed');
      return { status: 'started', handoffId: payload.handoffId };
    });
  }
  saveApproval(input: ApprovalSnapshot): ApprovalSnapshot {
    const snapshot = approvalSnapshotSchema.parse(input); const fingerprint = accountFingerprint(snapshot);
    return this.atomic(() => {
      const old = this.raw.prepare('SELECT fingerprint,workspace_id FROM delegated_approvals WHERE id=?').get(snapshot.id) as { fingerprint: string; workspace_id: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint || old.workspace_id !== this.deps.workspaceId) throw new Error('Approval conflict'); return snapshot; }
      const route = this.raw.prepare('SELECT channel,value FROM pm_account_routes WHERE account_id=? AND id=? AND version=?').get(snapshot.accountId, snapshot.routeId, snapshot.routeVersion) as { channel: string; value: string } | undefined;
      if (!route || route.channel !== 'email' || route.value !== snapshot.recipient) throw new Error('Approval recipient mismatch');
      if (snapshot.approvedAt > this.now()) throw new Error('Future approval');
      this.raw.prepare('INSERT INTO delegated_approvals VALUES(?,?,?,?,?,?,?,?,?)').run(snapshot.id, this.deps.workspaceId, snapshot.accountId,
        snapshot.routeId, snapshot.routeVersion, snapshot.permissionEvidenceId, fingerprint, JSON.stringify(snapshot), snapshot.approvedAt);
      return snapshot;
    });
  }
  applyWorkerEvent(input: WorkerEvent): 'applied' | 'duplicate' | 'gap' {
    const event = workerEventSchema.parse(input);
    if (event.workspaceId !== this.deps.workspaceId) throw new Error('Workspace event mismatch');
    const fingerprint = accountFingerprint(event); const stream = event.kind.startsWith('research.') ? 'research' : 'execution';
    return this.atomic(() => {
      const old = this.raw.prepare('SELECT fingerprint FROM delegated_applied_events WHERE id=?').get(event.id) as { fingerprint: string } | undefined;
      if (old) { if (old.fingerprint !== fingerprint) throw new Error('Event fingerprint conflict'); return 'duplicate'; }
      const cursor = this.raw.prepare('SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream=?')
        .get(event.workspaceId, event.accountId, stream) as { aggregate_version: number } | undefined;
      if (event.aggregateVersion !== (cursor?.aggregate_version ?? 0) + 1) return 'gap';
      const at = this.now();
      if (stream === 'research') this.applyResearch(event, at);
      else this.validateExecution(event);
      this.raw.prepare('INSERT INTO delegated_applied_events VALUES(?,?,?,?,?,?,?,?,?)').run(event.id, event.workspaceId, event.accountId,
        stream, event.aggregateVersion, event.authorityGeneration, fingerprint, JSON.stringify(event), at);
      if (event.kind === 'authority.granted') {
        // Worker-origin authority under the approved territory policy: the row is created here, never by research itself.
        const state = event.payload.authority;
        this.raw.prepare('INSERT INTO delegated_authorities VALUES(?,?,?,?,?,?,?)').run(event.accountId, event.workspaceId, state.owner, state.generation, state.state, event.aggregateVersion, at);
      } else if (event.kind === 'authority.changed') {
        const state = event.payload.authority;
        const result = this.raw.prepare('UPDATE delegated_authorities SET owner=?,generation=?,state=?,aggregate_version=?,updated_at=? WHERE account_id=? AND workspace_id=?')
          .run(state.owner, state.generation, state.state, event.aggregateVersion, at, event.accountId, event.workspaceId);
        if (result.changes !== 1) throw new Error('Missing authority');
      } else if (stream === 'execution') {
        this.raw.prepare('UPDATE delegated_authorities SET aggregate_version=?,updated_at=? WHERE account_id=? AND workspace_id=?')
          .run(event.aggregateVersion, at, event.accountId, event.workspaceId);
      }
      if(event.kind==='account.bootstrap') {
        const command=this.getCommand(event.receipt.commandId);
        if(!command||command.kind!=='bootstrap-selected-account')throw Error('bootstrap_command_missing');
        const prior=this.raw.prepare("SELECT aggregate_version FROM delegated_event_cursors WHERE workspace_id=? AND account_id=? AND stream='research'").get(event.workspaceId,event.accountId) as {aggregate_version:number}|undefined;
        if((prior?.aggregate_version??null)!==command.payload.expectedResearchRevision)throw Error('bootstrap_cursor_conflict');
        if(!prior)this.raw.prepare('INSERT INTO delegated_event_cursors VALUES(?,?,?,?,?)').run(event.workspaceId,event.accountId,'research',event.payload.researchRevision,event.id);
      }
      // account.refreshed rewrites nothing locally: the saved record already is the source the worker now holds, and
      // the research cursor the refresh was bound to stays exactly where the worker's own research left it. Only the
      // execution version above and the execution cursor below advance, like every other applied owner receipt.
      if(event.kind==='authority.changed'&&event.payload.receipt.status==='rejected'){
        const command=this.getCommand(event.payload.receipt.commandId);
        if(command?.kind==='approve-requested-followup'){
          const row=this.raw.prepare('SELECT draft_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND account_id=? AND id=?').get(event.workspaceId,event.accountId,command.payload.draft.id) as {draft_json:string}|undefined;
          if(row&&accountFingerprint(JSON.parse(row.draft_json))===accountFingerprint(command.payload.draft)){
            const status=requestedApprovalStatusSchema.parse({receipt:event.payload.receipt,state:'needs_review',intentCommandId:null,reason:event.payload.receipt.reason});
            this.raw.prepare('UPDATE delegated_requested_followup_drafts SET approval_json=? WHERE workspace_id=? AND account_id=? AND id=?').run(JSON.stringify(status),event.workspaceId,event.accountId,command.payload.draft.id);
          }
        }
      }
      if(event.kind==='requested_followup.status'){
        const command=this.getCommand(event.payload.commandId);
        if(command?.kind!=='approve-requested-followup')throw Error('requested_command_missing');
        const row=this.raw.prepare('SELECT draft_json FROM delegated_requested_followup_drafts WHERE workspace_id=? AND account_id=? AND id=?').get(event.workspaceId,event.accountId,event.payload.draftId) as {draft_json:string}|undefined;
        // Preserve newer local edits. Immutable command/event status remains queryable separately.
        if(row&&accountFingerprint(JSON.parse(row.draft_json))===accountFingerprint(command.payload.draft))this.raw.prepare('UPDATE delegated_requested_followup_drafts SET approval_json=? WHERE workspace_id=? AND account_id=? AND id=?').run(JSON.stringify(event.payload.status),event.workspaceId,event.accountId,event.payload.draftId);
      }
      if (event.kind === 'meeting.outcome') this.applyMeeting(event, at);
      if (event.kind === 'manual.handoff') {
        const p = event.payload;
        this.raw.prepare('INSERT INTO delegated_manual_handoffs VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,NULL)')
          .run(event.workspaceId, event.accountId, p.handoffId, p.actionId, event.authorityGeneration, p.targetHash, p.contentHash,
            p.contextRevision, p.channel, p.routeId, p.routeVersion, p.expiresAt, event.id);
      }
      const campaign = event.kind === 'campaign.changed' ? event.payload : 'campaign' in event ? event.campaign : undefined;
      if (campaign) new CampaignRepository(this.deps).applyProjection(event.accountId, campaign);
      if (event.kind === 'thread.observed') this.applyThread(event, at);
      if (event.kind === 'action.outcome') {
        const p = event.payload;
        const previous = this.raw.prepare('SELECT content_hash,target_hash FROM delegated_action_outcomes WHERE workspace_id=? AND account_id=? AND action_id=? LIMIT 1')
          .get(event.workspaceId, event.accountId, p.actionId) as { content_hash: string; target_hash: string } | undefined;
        if (previous && (previous.content_hash !== p.contentHash || previous.target_hash !== p.targetHash)) throw new Error('Action immutable target conflict');
        this.raw.prepare('INSERT INTO delegated_action_outcomes VALUES(?,?,?,?,?,?,?,?,?,?)').run(event.id, event.workspaceId, event.accountId,
          p.actionId, event.authorityGeneration, p.state, p.contentHash, p.targetHash, p.observedAt, p.evidenceRef);
        this.raw.prepare('INSERT INTO delegated_reconciliation VALUES(?,?,?,?,?,?,?)').run(event.id, event.workspaceId, event.accountId, p.actionId, event.id, p.evidenceRef, p.observedAt);
      }
      if (event.kind === 'manual.outcome') this.raw.prepare('INSERT INTO delegated_manual_outcomes VALUES(?,?,?,?,?,?,?)')
        .run(event.id, event.workspaceId, event.accountId, event.payload.actionId, event.payload.channel, JSON.stringify(event.payload), event.payload.observedAt);
      this.raw.prepare(`INSERT INTO delegated_event_cursors VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,account_id,stream)
        DO UPDATE SET aggregate_version=excluded.aggregate_version,event_id=excluded.event_id`).run(event.workspaceId, event.accountId, stream, event.aggregateVersion, event.id);
      return 'applied';
    });
  }
  private applyMeeting(event: Extract<WorkerEvent, { kind: 'meeting.outcome' }>, at: string) {
    const payload = meetingOutcomePayloadSchema.parse(event.payload); const { outcome, observedAt } = payload;
    if (accountInstantSchema.parse(observedAt) > at) throw new Error('Future meeting observation');
    const row = this.raw.prepare('SELECT provider_event_id,revision,projection_json FROM delegated_meetings WHERE workspace_id=? AND account_id=? AND id=?')
      .get(event.workspaceId, event.accountId, outcome.meetingId) as { provider_event_id: string; revision: number; projection_json: string } | undefined;
    const previous = row ? meetingOutcomePayloadSchema.parse(JSON.parse(row.projection_json)) : null;
    if (row && (row.provider_event_id !== outcome.providerEventId || previous!.outcome.calendarId !== outcome.calendarId)) throw new Error('Meeting immutable provider identity conflict');
    // The immutable event ledger still records late messages, but a cancelled
    // provider identity can never turn back into a booked projection.
    if (previous?.outcome.status === 'cancelled' && outcome.status !== 'cancelled') return;
    const state = outcome.status === 'booked' ? 'created' : outcome.status;
    this.raw.prepare(`INSERT INTO delegated_meetings VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,account_id,id)
      DO UPDATE SET revision=excluded.revision,state=excluded.state,projection_json=excluded.projection_json,updated_at=excluded.updated_at`)
      .run(event.workspaceId, event.accountId, outcome.meetingId, 'google_calendar', outcome.providerEventId, (row?.revision ?? 0) + 1, state, JSON.stringify(payload), at);
  }
  private applyThread(event: Extract<WorkerEvent, { kind: 'thread.observed' }>, at: string) {
    const { projection, approvalInvalidation, observedAt } = event.payload;
    const thread = projection.thread;
    if (accountInstantSchema.parse(observedAt) > at || thread.messages.some(message => accountInstantSchema.parse(message.date) > at)) throw new Error('Future thread observation');
    const row = this.raw.prepare('SELECT projection_json FROM delegated_threads WHERE workspace_id=? AND account_id=? AND id=?')
      .get(event.workspaceId, event.accountId, thread.providerThreadId) as { projection_json: string } | undefined;
    const previous = row ? threadProjectionSchema.parse(JSON.parse(row.projection_json)) : null;
    if ((previous?.revision ?? 0) !== approvalInvalidation.previousRevision) throw new Error('Thread revision conflict');
    if (previous && (previous.thread.mailboxSubject !== thread.mailboxSubject || previous.thread.providerThreadId !== thread.providerThreadId
      || previous.thread.messages.some(message => !thread.messages.some(next => next.id === message.id && accountFingerprint(next) === accountFingerprint(message))))) {
      throw new Error('Thread immutable history conflict');
    }
    this.raw.prepare(`INSERT INTO delegated_threads VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,account_id,id)
      DO UPDATE SET revision=excluded.revision,context_revision=excluded.context_revision,projection_json=excluded.projection_json,updated_at=excluded.updated_at`)
      .run(event.workspaceId, event.accountId, thread.providerThreadId, 'gmail', thread.providerThreadId, projection.revision, projection.contextRevision, JSON.stringify(projection), at);
    // Snapshots/drafts are never rewritten. Their stored thread/context revisions become stale.
    for (const signal of projection.signals.filter(signal => signal.kind === 'opt_out')) for (const evidence of signal.evidence) {
      const evidenceRef = `${thread.providerThreadId}:${evidence.messageId}`;
      const key = createHash('sha256').update(JSON.stringify([event.workspaceId, event.accountId, thread.mailboxSubject, evidenceRef])).digest('hex');
      this.raw.prepare('INSERT OR IGNORE INTO pm_account_suppression_tombstones VALUES(?,?,?,?,?,?)')
        .run(key, event.accountId, observedAt, 'gmail_reply', evidenceRef, at);
      const message = thread.messages.find(message => message.id === evidence.messageId)!;
      for (const address of message.from) this.raw.prepare('INSERT OR IGNORE INTO pm_handle_suppression_tombstones VALUES(?,?,?,?,?,?,?)')
        .run(`${key}:${address}`, 'email', address.toLowerCase(), observedAt, 'gmail_reply', evidenceRef, at);
    }
  }
  private validateExecution(event: WorkerEvent) {
    const owner = this.owner(event.accountId);
    if (event.kind === 'authority.granted') {
      // Only a firm the worker researched and nobody has claimed can receive a policy grant, and only as its first step.
      if (owner) throw new Error('Authority already assigned');
      if (!this.raw.prepare('SELECT 1 FROM pm_accounts WHERE id=?').get(event.accountId)) throw new Error('Granted authority requires the researched account');
      const { authority, receipt } = event.payload;
      if (authority.owner !== 'worker' || authority.state !== 'active' || authority.generation !== 1 || event.aggregateVersion !== 1 || receipt.status !== 'applied') throw new Error('Unproven granted authority');
      return;
    }
    if (!owner) throw new Error('Execution event requires explicit authority');
    if(event.kind==='requested_followup.status'){
      const command=this.getCommand(event.payload.commandId),status=event.payload.status;
      if(command?.kind!=='approve-requested-followup'||command.workspaceId!==event.workspaceId||command.accountId!==event.accountId||command.payload.draft.id!==event.payload.draftId||status.receipt.authorityGeneration!==command.expectedAuthorityGeneration||status.receipt.aggregateVersion!==command.expectedVersion+1||status.intentCommandId!==null&&status.intentCommandId!==command.payload.intentCommandId)throw Error('requested_status_identity');
      const previous=this.requestedApprovalStatus(command.commandId);
      if(!previous||previous.receipt.status==='rejected')throw Error('requested_status_conflict');
      if(previous.receipt.status==='pending'){
        if(status.state!=='pending_preflight'||event.aggregateVersion!==status.receipt.aggregateVersion||event.authorityGeneration!==status.receipt.authorityGeneration)throw Error('requested_capture_missing');
      }else if(accountFingerprint(previous.receipt)!==accountFingerprint(status.receipt)||previous.state!=='pending_preflight'&&previous.state!==status.state)throw Error('requested_receipt_changed');
    }
    if ('receipt' in event || event.kind === 'authority.changed') {
      const receipt = 'receipt' in event ? event.receipt : event.payload.receipt;
      const previous = this.commandStatus(receipt.commandId);
      if (previous && previous.status !== 'pending') throw new Error('Command acknowledgment conflict');
    }
    if(event.kind==='account.bootstrap') {
      const command=this.getCommand(event.receipt.commandId);
      if(!command||command.kind!=='bootstrap-selected-account'||command.accountId!==event.accountId||command.workspaceId!==event.workspaceId||event.payload.commandId!==command.commandId||command.expectedVersion!==0||command.expectedAuthorityGeneration!==0||owner.owner!=='local'||owner.state!=='local'||owner.generation!==0||owner.aggregate_version!==0||event.authorityGeneration!==0||event.aggregateVersion!==1||event.payload.recordFingerprint!==accountFingerprint(command.payload.record)||event.payload.researchRevision!==command.payload.record.researchRevision)throw Error('bootstrap_acknowledgment_conflict');
      return;
    }
    if (event.kind === 'account.refreshed') {
      // The worker acknowledges exactly the record this desktop queued, at the real generation/version it expected.
      const command = this.getCommand(event.receipt.commandId);
      if (!command || command.kind !== 'refresh-selected-account-record' || command.accountId !== event.accountId || command.workspaceId !== event.workspaceId
        || event.payload.commandId !== command.commandId || command.expectedAuthorityGeneration !== event.authorityGeneration || command.expectedVersion !== owner.aggregate_version
        || command.expectedVersion + 1 !== event.aggregateVersion || owner.owner !== 'worker' || owner.generation !== event.authorityGeneration
        || event.payload.recordFingerprint !== accountFingerprint(command.payload.record) || event.payload.researchRevision !== command.payload.record.researchRevision) throw Error('refresh_acknowledgment_conflict');
    }
    if (event.kind === 'manual.handoff' || event.kind === 'campaign.changed' || event.kind === 'acquisition.milestone_reported') {
      const command = this.getCommand(event.receipt.commandId);
      if (!command || command.accountId !== event.accountId || command.workspaceId !== event.workspaceId
        || command.expectedAuthorityGeneration !== event.authorityGeneration || command.expectedVersion !== owner.aggregate_version
        || command.expectedVersion + 1 !== event.aggregateVersion) throw new Error('Owner acknowledgment command mismatch');
      if (event.kind === 'manual.handoff') {
        if (command.kind !== 'prepare-manual' || accountFingerprint({ ...command.payload, handoffId: event.payload.handoffId, expiresAt: event.payload.expiresAt }) !== accountFingerprint(event.payload)) throw new Error('Manual handoff command mismatch');
      } else if (event.kind === 'campaign.changed' ? command.kind !== 'campaign-command' : command.kind !== 'report-acquisition-milestone' || accountFingerprint(command.payload) !== accountFingerprint(event.payload.report)) throw new Error('Owner command mismatch');
    }
    if (event.kind === 'manual.outcome') {
      const queued = this.raw.prepare('SELECT command_json FROM delegated_commands WHERE command_id=?')
        .get(event.receipt.commandId) as { command_json: string } | undefined;
      if (queued) {
        const command = delegationCommandSchema.parse(JSON.parse(queued.command_json));
        if (!['manual-outcome','complete-manual'].includes(command.kind) || command.workspaceId !== event.workspaceId || command.accountId !== event.accountId
          || (command.kind==='complete-manual'?command.expectedAuthorityGeneration>owner.generation||command.expectedVersion>owner.aggregate_version||event.aggregateVersion!==owner.aggregate_version+1:command.expectedAuthorityGeneration!==event.authorityGeneration||command.expectedVersion+1!==event.aggregateVersion||command.expectedVersion!==owner.aggregate_version) || accountFingerprint(command.kind === 'complete-manual' ? command.payload.outcome : command.payload) !== accountFingerprint(event.payload)) {
          throw new Error('Manual acknowledgment command correspondence conflict');
        }
      }
    }
    if (event.kind !== 'authority.changed') {
      if (owner.owner !== 'worker') throw new Error('Stale execution generation');
      if(event.kind==='manual.outcome'){
        const command=this.getCommand(event.receipt.commandId);
        if(command?.kind==='complete-manual'){
          const handoff=this.getManualHandoff(command.payload.handoffId);
          if(!handoff||handoff.consumedAt===null||handoff.authorityGeneration!==event.authorityGeneration||handoff.authorityGeneration>owner.generation||handoff.actionId!==event.payload.actionId||handoff.targetHash!==command.payload.targetHash||handoff.channel!==event.payload.channel)throw Error('manual_original_handoff_required');
          return;
        }
      }
      if (event.authorityGeneration !== owner.generation) {
        const prior = event.kind === 'action.outcome' ? this.raw.prepare('SELECT 1 FROM delegated_action_outcomes WHERE workspace_id=? AND account_id=? AND action_id=? AND authority_generation=? AND content_hash=? AND target_hash=?')
          .get(event.workspaceId, event.accountId, event.payload.actionId, event.authorityGeneration, event.payload.contentHash, event.payload.targetHash)
          : event.kind === 'meeting.outcome' ? this.raw.prepare(`SELECT 1 FROM delegated_applied_events WHERE workspace_id=? AND account_id=? AND authority_generation=?
            AND json_extract(event_json,'$.kind')='meeting.outcome' AND json_extract(event_json,'$.payload.outcome.meetingId')=?
            AND json_extract(event_json,'$.payload.outcome.providerEventId')=? AND json_extract(event_json,'$.payload.outcome.calendarId')=? LIMIT 1`)
            .get(event.workspaceId, event.accountId, event.authorityGeneration, event.payload.outcome.meetingId, event.payload.outcome.providerEventId, event.payload.outcome.calendarId) : undefined;
        if (!prior || event.authorityGeneration > owner.generation) throw new Error('Stale execution generation');
      }
      return;
    }
    const { authority, receipt } = event.payload;
    const queued = this.raw.prepare('SELECT command_json,receipt_json FROM delegated_commands WHERE command_id=? AND workspace_id=? AND account_id=?')
      .get(receipt.commandId, event.workspaceId, event.accountId) as { command_json: string; receipt_json: string } | undefined;
    if (!queued) {
      // Authenticated C6 transport may deliver emergency commands submitted directly to the worker.
      // Such events can only reduce already-delegated authority, never grant or restore local rights.
      const paused = (owner.state === 'active' || owner.state === 'paused') && authority.state === 'paused' && authority.generation === owner.generation;
      const revoked = owner.state !== 'revoked' && authority.state === 'revoked' && authority.generation === owner.generation + 1;
      if (receipt.status !== 'applied' || owner.owner !== 'worker' || authority.owner !== 'worker' || (!paused && !revoked)) throw new Error('Unproven remote authority transition');
      return;
    }
    const command = delegationCommandSchema.parse(JSON.parse(queued.command_json));
    if (commandReceiptSchema.parse(JSON.parse(queued.receipt_json)).status !== 'pending') throw new Error('Command was refused locally');
    if (receipt.status === 'rejected') {
      if (authority.generation !== owner.generation || authority.owner !== owner.owner || authority.state !== owner.state) throw new Error('Rejected command changed authority');
      return;
    }
    if (command.expectedAuthorityGeneration !== owner.generation || command.expectedVersion !== owner.aggregate_version) throw new Error('Command CAS conflict');
    const generation = owner.generation + (command.kind === 'delegate' || command.kind === 'revoke' ? 1 : 0);
    const state = command.kind === 'delegate' ? 'active' : command.kind === 'pause' ? 'paused' : command.kind === 'revoke' ? 'revoked' : owner.state;
    if (authority.generation !== generation || authority.state !== state || authority.owner !== 'worker') throw new Error('Invalid authority transition');
    if (command.kind === 'delegate' ? owner.owner !== 'local' || owner.state !== 'delegating' : owner.owner !== 'worker') throw new Error('Invalid authority owner');
  }
  private applyResearch(event: WorkerEvent, at: string) {
    if (event.kind === 'research.created') {
      const a = event.payload.account;
      if (event.payload.createdAt > at) throw new Error('Future research timestamp');
      this.raw.prepare('INSERT INTO pm_accounts VALUES(?,?,?,?,?,?)').run(a.id, a.name, a.domain, a.version, event.payload.createdAt, at);
      this.raw.prepare('INSERT INTO pm_account_commands VALUES(?,?,?,?,?,?)').run(event.id, a.id, accountFingerprint(event), JSON.stringify(a), 1, at);
      return;
    }
    if (event.kind === 'research.receipt') {
      if (event.payload.observedAt > at) throw new Error('Future research timestamp');
      if (event.payload.receiptCommandId !== null && !this.raw.prepare('SELECT 1 FROM pm_account_commands WHERE account_id=? AND command_id=?').get(event.accountId, event.payload.receiptCommandId)) throw new Error('Research receipt provenance mismatch');
      return;
    }
    if (event.kind !== 'research.evidence') throw new Error('Invalid research event');
    const { batch, admittedAt } = event.payload;
    if (admittedAt > at) throw new Error('Future evidence admission');
    const account = this.raw.prepare('SELECT version FROM pm_accounts WHERE id=?').get(event.accountId) as { version: number } | undefined;
    if (account?.version !== batch.expectedVersion) throw new Error('Research account CAS conflict');
    for (const source of batch.sources) {
      if (!source.permitted || source.fetchedAt > admittedAt || this.deps.sourcePolicy?.attest(Object.freeze({ ...source }), batch.accountId) !== true) throw new Error('Source policy attestation required');
      const sourceKey = accountFingerprint({ url: source.url, sha256: source.sha256, fetchedAt: source.fetchedAt });
      const existing = this.raw.prepare('SELECT account_id,source_key,excerpt FROM pm_account_sources WHERE id=?').get(source.id) as { account_id: string; source_key: string; excerpt: string } | undefined;
      if (existing) {
        if (existing.account_id !== batch.accountId || existing.source_key !== sourceKey || existing.excerpt !== source.excerpt) throw new Error('Source identity conflict');
      } else this.raw.prepare('INSERT INTO pm_account_sources VALUES(?,?,?,?,?,?,?,1,?)').run(source.id, batch.accountId, sourceKey, source.url, source.fetchedAt, source.sha256, source.excerpt, admittedAt);
    }
    const requireEvidence = (ids: readonly string[]) => {
      for (const id of ids) if (!this.raw.prepare('SELECT 1 FROM pm_account_sources WHERE account_id=? AND id=? AND fetched_at<=? AND admitted_at<=?').get(batch.accountId, id, admittedAt, at)) throw new Error('Missing or cross-account evidence');
    };
    for (const claim of batch.claims) {
      requireEvidence(claim.evidenceIds); const id = randomUUID();
      this.raw.prepare('INSERT INTO pm_account_claims VALUES(?,?,?,?)').run(id, batch.accountId, JSON.stringify(claim), admittedAt);
      for (const source of claim.evidenceIds) this.raw.prepare('INSERT INTO pm_account_claim_evidence VALUES(?,?,?)').run(batch.accountId, id, source);
    }
    for (const route of batch.routes) {
      requireEvidence(route.evidenceIds);
      const previous = this.raw.prepare('SELECT account_id,MAX(version) AS version FROM pm_account_routes WHERE id=? GROUP BY account_id').get(route.id) as { account_id: string; version: number } | undefined;
      if (previous && previous.account_id !== batch.accountId) throw new Error('Cross-account route identity');
      const version = (previous?.version ?? 0) + 1;
      this.raw.prepare('INSERT INTO pm_account_routes VALUES(?,?,?,?,?,?,?,?,?)').run(route.id, batch.accountId, version, route.personId, route.channel, route.value, route.purpose, route.verification, admittedAt);
      for (const source of route.evidenceIds) this.raw.prepare('INSERT INTO pm_account_route_evidence VALUES(?,?,?,?)').run(batch.accountId, route.id, version, source);
    }
    this.raw.prepare('UPDATE pm_accounts SET version=version+1,updated_at=? WHERE id=? AND version=?').run(at, batch.accountId, batch.expectedVersion);
    this.raw.prepare('INSERT INTO pm_account_commands VALUES(?,?,?,?,?,?)').run(batch.commandId, batch.accountId, accountFingerprint({ kind: 'evidence', input: batch }),
      JSON.stringify({ accountId: batch.accountId, version: batch.expectedVersion + 1, duplicate: false }), batch.expectedVersion + 1, admittedAt);
  }
}
