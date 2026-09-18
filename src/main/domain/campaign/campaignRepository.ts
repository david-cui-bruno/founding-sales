import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../../db/database';
import { accountIdSchema as id, accountInstantSchema as instant } from '../../../shared/contracts/accountContract';
import { campaignVersionSchema, campaignEventPayloadSchema, type CampaignEventPayload, enrollmentSchema, enrollmentStateSchema, type CampaignVersion, type Enrollment } from '../../../shared/contracts/campaignContract';
import { accountFingerprint as fingerprint } from '../accounts/accountEvidence';

const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const enrollSchema = z.strictObject({ commandId: z.uuid(), accountId: id, selectedRouteId: id, campaignVersionId: id, executionContextId: id, contextRevision: revision });
const stateSchema = z.strictObject({ commandId: z.uuid(), enrollmentId: id, expectedVersion: revision.positive(), state: enrollmentStateSchema, reason: z.string().min(1).max(2000) });
const routeSchema = z.strictObject({ commandId: z.uuid(), enrollmentId: id, expectedVersion: revision.positive(), selectedRouteId: id, executionContextId: id, contextRevision: revision });
/** Local-owned campaign mutations. Delegated accounts are only updated by the authenticated C1 projector. */
export class CampaignRepository {
  constructor(private readonly deps: { database: AppDatabase; workspaceId: string; clock: { now(): string } }) { id.parse(deps.workspaceId); }
  private get raw() { return this.deps.database.raw; }
  private get ws() { return this.deps.workspaceId; }
  private now() { return instant.parse(this.deps.clock.now()); }
  private local(accountId: string) {
    const owner = this.raw.prepare('SELECT workspace_id,owner,state FROM delegated_authorities WHERE account_id=?').get(accountId) as { workspace_id: string; owner: string; state: string } | undefined;
    if (owner && (owner.workspace_id !== this.ws || owner.owner !== 'local' || owner.state !== 'local')) throw new Error('campaign_owner_not_local');
  }
  private mutate<T>(commandId: string, input: unknown, run: () => T): T {
    if (this.raw.inTransaction) throw new Error('campaign_transaction_scope');
    z.uuid().parse(commandId); const fp = fingerprint(input);
    return this.raw.transaction(() => {
      const old = this.raw.prepare('SELECT fingerprint,result_json FROM campaign_command_receipts WHERE workspace_id=? AND command_id=?').get(this.ws, commandId) as { fingerprint: string; result_json: string } | undefined;
      if (old) { if (old.fingerprint !== fp) throw new Error('campaign_command_conflict'); return JSON.parse(old.result_json) as T; }
      const value = run();
      this.raw.prepare('INSERT INTO campaign_command_receipts(workspace_id,command_id,fingerprint,result_json,created_at) VALUES(?,?,?,?,?)').run(this.ws, commandId, fp, JSON.stringify(value), this.now());
      return value;
    }).immediate();
  }
  createVersion(input: { commandId: string; version: CampaignVersion }): CampaignVersion {
    const version = campaignVersionSchema.parse(input.version);
    return this.mutate(input.commandId, { kind: 'version', version }, () => {
      version.cohortAccountIds.forEach(account => this.local(account));
      if (version.approvedAt !== null) throw new Error('campaign_requires_approval');
      this.raw.prepare('INSERT INTO campaign_versions(workspace_id,id,campaign_id,version,snapshot_json,snapshot_hash,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(this.ws, version.id, version.campaignId, version.version, JSON.stringify(version), fingerprint(version), this.now());
      return version;
    });
  }
  getVersion(versionId: string): CampaignVersion {
    const row = this.raw.prepare('SELECT snapshot_json FROM campaign_versions WHERE workspace_id=? AND id=?').get(this.ws, id.parse(versionId)) as { snapshot_json: string } | undefined;
    if (!row) throw new Error('campaign_missing');
    const version = campaignVersionSchema.parse(JSON.parse(row.snapshot_json));
    const approval = this.raw.prepare('SELECT snapshot_hash,approved_at FROM campaign_approvals WHERE workspace_id=? AND campaign_version_id=?').get(this.ws, versionId) as { snapshot_hash: string; approved_at: string } | undefined;
    if (approval && approval.snapshot_hash !== fingerprint(version)) throw new Error('campaign_approval_mismatch');
    return { ...version, approvedAt: approval?.approved_at ?? null };
  }
  approve(input: { commandId: string; campaignVersionId: string; snapshotHash: string; approvedAt: string }): CampaignVersion {
    instant.parse(input.approvedAt);
    return this.mutate(input.commandId, { kind: 'approve', ...input }, () => {
      const version = this.getVersion(input.campaignVersionId); version.cohortAccountIds.forEach(account => this.local(account));
      if (version.approvedAt !== null || fingerprint(version) !== input.snapshotHash || input.approvedAt > this.now()) throw new Error('campaign_approval_mismatch');
      this.raw.prepare('INSERT INTO campaign_approvals(workspace_id,campaign_version_id,snapshot_hash,approved_at,command_id) VALUES(?,?,?,?,?)').run(this.ws, version.id, input.snapshotHash, input.approvedAt, input.commandId);
      for (const channel of ['call', 'email', 'linkedin']) this.raw.prepare('INSERT INTO campaign_caps(workspace_id,campaign_version_id,channel,revision,reserved,sent) VALUES(?,?,?,1,0,0)').run(this.ws, version.id, channel);
      return { ...version, approvedAt: input.approvedAt };
    });
  }
  private route(accountId: string, routeId: string) {
    const row = this.raw.prepare("SELECT id,version,person_id FROM pm_account_routes WHERE account_id=? AND id=? AND purpose='business' ORDER BY version DESC LIMIT 1")
      .get(accountId, routeId) as { id: string; version: number; person_id: string | null } | undefined;
    if (!row) throw new Error('campaign_route_mismatch'); return row;
  }
  getEnrollment(enrollmentId: string): Enrollment {
    const row = this.raw.prepare('SELECT * FROM campaign_enrollments WHERE workspace_id=? AND id=?').get(this.ws, id.parse(enrollmentId)) as Record<string, unknown> | undefined;
    if (!row) throw new Error('campaign_enrollment_missing');
    return enrollmentSchema.parse({ id: row.id, accountId: row.account_id, selectedRouteId: row.selected_route_id, selectedRouteVersion: row.selected_route_version, personId: row.person_id,
      campaignVersionId: row.campaign_version_id, currentStepId: row.current_step_id, version: row.version, state: row.state,
      contextRevision: row.context_revision, executionContextId: row.execution_context_id, startedAt: row.started_at,
      ...(row.next_due_at === null || row.next_due_at === undefined ? {} : { nextDueAt: row.next_due_at }),
      ...(row.resting_until === null || row.resting_until === undefined ? {} : { restingUntil: row.resting_until }) });
  }
  enroll(raw: z.infer<typeof enrollSchema>): Enrollment {
    const input = enrollSchema.parse(raw);
    return this.mutate(input.commandId, { kind: 'enroll', ...input }, () => {
      this.local(input.accountId); const version = this.getVersion(input.campaignVersionId);
      if (!version.approvedAt || version.approvedAt > this.now() || !version.cohortAccountIds.includes(input.accountId)) throw new Error('campaign_unapproved');
      if (this.raw.prepare("SELECT id FROM campaign_enrollments WHERE workspace_id=? AND account_id=? AND state IN('active','held','paused','conversation')").get(this.ws, input.accountId)) throw new Error('account_already_enrolled');
      const route = this.route(input.accountId, input.selectedRouteId); const enrollment = enrollmentSchema.parse({ id: randomUUID(), accountId: input.accountId,
        selectedRouteId: route.id, selectedRouteVersion: route.version, personId: route.person_id, campaignVersionId: version.id, currentStepId: version.steps[0]!.id, version: 1, state: 'active',
        executionContextId: input.executionContextId, contextRevision: input.contextRevision, startedAt: this.now() });
      this.raw.prepare(`INSERT INTO campaign_enrollments(workspace_id,id,account_id,campaign_version_id,selected_route_id,selected_route_version,person_id,current_step_id,version,state,context_revision,execution_context_id,started_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(this.ws, enrollment.id, enrollment.accountId, enrollment.campaignVersionId, route.id, route.version, route.person_id,
        enrollment.currentStepId, 1, 'active', enrollment.contextRevision, enrollment.executionContextId, enrollment.startedAt, this.now());
      return enrollment;
    });
  }
  changeState(raw: z.infer<typeof stateSchema>): Enrollment {
    const input = stateSchema.parse(raw);
    return this.mutate(input.commandId, { kind: 'state', ...input }, () => {
      const old = this.getEnrollment(input.enrollmentId); this.local(old.accountId);
      if (old.version !== input.expectedVersion) throw new Error('stale_enrollment');
      if (['completed', 'stopped'].includes(old.state)) throw new Error('terminal_enrollment');
      if (old.state === 'conversation' && input.state === 'active') throw new Error('conversation_requires_review');
      this.raw.prepare('UPDATE campaign_enrollments SET state=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?').run(input.state, this.now(), this.ws, old.id, old.version);
      return this.getEnrollment(old.id);
    });
  }
  switchRoute(raw: z.infer<typeof routeSchema>): Enrollment {
    const input = routeSchema.parse(raw);
    return this.mutate(input.commandId, { kind: 'route', ...input }, () => {
      const old = this.getEnrollment(input.enrollmentId); this.local(old.accountId);
      if (old.version !== input.expectedVersion) throw new Error('stale_enrollment');
      if (['completed', 'stopped'].includes(old.state) || input.contextRevision <= old.contextRevision || input.executionContextId === old.executionContextId) throw new Error('stale_context');
      const route = this.route(old.accountId, input.selectedRouteId);
      this.raw.prepare('UPDATE campaign_enrollments SET selected_route_id=?,selected_route_version=?,person_id=?,context_revision=?,execution_context_id=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=? AND version=?')
        .run(route.id, route.version, route.person_id, input.contextRevision, input.executionContextId, this.now(), this.ws, old.id, old.version);
      return this.getEnrollment(old.id);
    });
  }
  /** Called only inside C1 authenticated ordered-event transaction, never renderer/direct mutation. */
  applyProjection(accountId: string, raw: CampaignEventPayload): void {
    if (!this.raw.inTransaction) throw new Error('campaign_projection_scope');
    const payload = campaignEventPayloadSchema.parse(raw); id.parse(accountId);
    if (payload.version) {
      const version = payload.version;
      if (!version.cohortAccountIds.includes(accountId)) throw new Error('campaign_projection_account');
      const snapshot: CampaignVersion = { ...version, approvedAt: null };
      const old = this.raw.prepare('SELECT snapshot_hash FROM campaign_versions WHERE workspace_id=? AND id=?').get(this.ws, version.id) as { snapshot_hash: string } | undefined;
      if (old && old.snapshot_hash !== fingerprint(snapshot)) throw new Error('campaign_projection_conflict');
      if (!old) this.raw.prepare('INSERT INTO campaign_versions VALUES(?,?,?,?,?,?,?)').run(this.ws, version.id, version.campaignId, version.version, JSON.stringify(snapshot), fingerprint(snapshot), this.now());
      if (version.approvedAt) {
        const prior = this.raw.prepare('SELECT snapshot_hash,approved_at FROM campaign_approvals WHERE workspace_id=? AND campaign_version_id=?').get(this.ws, version.id) as { snapshot_hash: string; approved_at: string } | undefined;
        if (prior && (prior.snapshot_hash !== fingerprint(snapshot) || prior.approved_at !== version.approvedAt)) throw new Error('campaign_projection_conflict');
        if (!prior) {
          this.raw.prepare('INSERT INTO campaign_approvals VALUES(?,?,?,?,?)').run(this.ws, version.id, fingerprint(snapshot), version.approvedAt, payload.commandId);
          for (const channel of ['call','email','linkedin']) this.raw.prepare('INSERT INTO campaign_caps VALUES(?,?,?,1,0,0)').run(this.ws, version.id, channel);
        }
      }
    }
    if (payload.enrollment) {
      const e = payload.enrollment;
      if (e.accountId !== accountId) throw new Error('campaign_projection_account');
      const old = this.raw.prepare('SELECT version FROM campaign_enrollments WHERE workspace_id=? AND id=?').get(this.ws, e.id) as { version: number } | undefined;
      if (e.version !== (old?.version ?? 0) + 1) throw new Error('campaign_projection_gap');
      const route = this.raw.prepare('SELECT person_id FROM pm_account_routes WHERE account_id=? AND id=? AND version=?').get(accountId, e.selectedRouteId, e.selectedRouteVersion) as { person_id: string | null } | undefined;
      if (!route || route.person_id !== e.personId || !this.getVersion(e.campaignVersionId).cohortAccountIds.includes(accountId)) throw new Error('campaign_projection_binding');
      this.raw.prepare(`INSERT INTO campaign_enrollments(workspace_id,id,account_id,campaign_version_id,selected_route_id,selected_route_version,person_id,current_step_id,version,state,context_revision,execution_context_id,started_at,updated_at,next_due_at,resting_until)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET selected_route_id=excluded.selected_route_id,selected_route_version=excluded.selected_route_version,
        person_id=excluded.person_id,current_step_id=excluded.current_step_id,version=excluded.version,state=excluded.state,context_revision=excluded.context_revision,execution_context_id=excluded.execution_context_id,updated_at=excluded.updated_at,
        next_due_at=excluded.next_due_at,resting_until=excluded.resting_until`)
        .run(this.ws,e.id,e.accountId,e.campaignVersionId,e.selectedRouteId,e.selectedRouteVersion,e.personId,e.currentStepId,e.version,e.state,e.contextRevision,e.executionContextId,e.startedAt,this.now(),e.nextDueAt ?? null,e.restingUntil ?? null);
      if (payload.evidence) {
        const evidence = payload.evidence;
        if (evidence.enrollmentId !== e.id || evidence.accountId !== accountId || evidence.campaignVersionId !== e.campaignVersionId) throw new Error('campaign_projection_binding');
        const route = this.raw.prepare('SELECT version FROM pm_account_routes WHERE account_id=? AND id=? AND version=?').get(accountId,evidence.routeId,evidence.routeVersion) as { version: number } | undefined;
        if (!route) throw new Error('campaign_projection_binding');
        this.raw.prepare('INSERT INTO campaign_step_receipts VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(this.ws, payload.commandId, accountId, e.id, evidence.stepId,
          evidence.routeId, route.version, evidence.contextRevision, evidence.executionContextId, evidence.actionId, evidence.channel, evidence.state, evidence.conflict ? `conflict:${evidence.conflict}:${evidence.outcome}` : evidence.outcome, evidence.observation, evidence.source, evidence.observedAt, payload.commandId);
      }
    } else if (payload.evidence) throw new Error('campaign_projection_binding');
    if (payload.cap) {
      const cap = payload.cap;
      if (!this.getVersion(cap.campaignVersionId).cohortAccountIds.includes(accountId) || payload.enrollment && payload.enrollment.campaignVersionId !== cap.campaignVersionId) throw new Error('campaign_cap_projection_binding');
      const old = this.raw.prepare('SELECT revision,reserved,sent FROM campaign_caps WHERE workspace_id=? AND campaign_version_id=? AND channel=?').get(this.ws,cap.campaignVersionId,cap.channel) as { revision: number; reserved: number; sent: number } | undefined;
      if (!old || cap.revision < old.revision || cap.revision > old.revision + 1 || cap.revision === old.revision && (cap.reserved !== old.reserved || cap.sent !== old.sent)) throw new Error('campaign_cap_projection_conflict');
      if (cap.revision > old.revision) {
        const result = this.raw.prepare('UPDATE campaign_caps SET revision=?,reserved=?,sent=? WHERE workspace_id=? AND campaign_version_id=? AND channel=? AND revision=?').run(cap.revision,cap.reserved,cap.sent,this.ws,cap.campaignVersionId,cap.channel,old.revision);
        if (result.changes !== 1) throw new Error('campaign_cap_projection_conflict');
      }
    }

  }

}
