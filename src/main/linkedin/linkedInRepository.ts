import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppDatabase } from '../db/database';
import { accountIdSchema as id } from '../../shared/contracts/accountContract';
import { linkedInBodySchema, linkedInDraftSchema, linkedInSaveSchema, type LinkedInDraft, type LinkedInSave } from '../../shared/contracts/linkedInContract';
import { manualHandoffBindingSchema } from '../../shared/contracts/ownerCommandContract';
import { CampaignRepository } from '../domain/campaign/campaignRepository';
export const linkedInHash = (text: string) => createHash('sha256').update(text).digest('hex');
export type LinkedInStepContext = Omit<LinkedInDraft, 'id' | 'revision' | 'body' | 'contentHash' | 'state' | 'updatedAt'> & { enrollmentVersion: number; target: string };
/** Workspace AND enrollment scoped. Never changes owner, action or campaign outcomes. */
export class LinkedInRepository {
  constructor(private readonly deps: { database: AppDatabase; workspaceId: string; enrollmentId: string; clock: { now(): string } }) {
    id.parse(deps.workspaceId); id.parse(deps.enrollmentId);
  }
  private get raw() { return this.deps.database.raw; }
  private atomic<T>(run: () => T): T {
    if (this.raw.inTransaction) throw new Error('linkedin_transaction_scope');
    return this.raw.transaction(run).immediate();
  }
  private enrollment() {
    const result = this.raw.prepare('SELECT * FROM campaign_enrollments WHERE workspace_id=? AND id=?').get(this.deps.workspaceId, this.deps.enrollmentId) as Record<string, unknown> | undefined;
    if (!result) throw new Error('enrollment_missing'); return result;
  }
  private assertAvailable(accountId: string, personId: string | null) {
    if (this.raw.prepare('SELECT 1 FROM pm_account_suppression_tombstones WHERE account_id=?').get(accountId)) throw new Error('linkedin_suppressed');
    if (personId !== null) {
      const person = this.raw.prepare('SELECT opted_out,deleted_at FROM persons WHERE id=?').get(personId) as { opted_out: number; deleted_at: string | null } | undefined;
      if (!person || person.opted_out || person.deleted_at) throw new Error('linkedin_suppressed');
    }
  }
  requireStep(stepId: string, expectedVersion: number): LinkedInStepContext {
    id.parse(stepId); z.number().int().positive().parse(expectedVersion);
    const e = this.enrollment();
    if (e.version !== expectedVersion || e.current_step_id !== stepId || e.state !== 'active') throw new Error('stale_context');
    const campaign = new CampaignRepository(this.deps).getVersion(String(e.campaign_version_id));
    if (!campaign.approvedAt || campaign.approvedAt > this.deps.clock.now() || !campaign.steps.some(s => s.id === stepId && s.channel === 'linkedin')) throw new Error('linkedin_step_unavailable');
    const route = this.raw.prepare('SELECT * FROM pm_account_routes WHERE account_id=? AND id=? AND version=?')
      .get(e.account_id, e.selected_route_id, e.selected_route_version) as Record<string, unknown> | undefined;
    if (!route || route.channel !== 'linkedin' || route.purpose !== 'business' || !['published', 'confirmed'].includes(String(route.verification)) || route.person_id !== e.person_id) throw new Error('linkedin_profile_unavailable');
    const personId = route.person_id === null ? null : String(route.person_id);
    this.assertAvailable(String(e.account_id), personId);
    return { workspaceId: this.deps.workspaceId, enrollmentId: this.deps.enrollmentId, accountId: String(e.account_id), campaignVersionId: campaign.id,
      personId, stepId, routeId: String(route.id), routeVersion: Number(route.version), contextRevision: Number(e.context_revision), executionContextId: String(e.execution_context_id),
      enrollmentVersion: expectedVersion, target: String(route.value), targetHash: linkedInHash(String(route.value)) };
  }
  requireRevision(draftId: string, expectedRevision: number): LinkedInDraft {
    id.parse(draftId); z.number().int().positive().parse(expectedRevision);
    const row = this.raw.prepare('SELECT * FROM manual_linkedin_drafts WHERE workspace_id=? AND enrollment_id=? AND id=?')
      .get(this.deps.workspaceId, this.deps.enrollmentId, draftId) as Record<string, unknown> | undefined;
    if (!row) throw new Error('draft_missing');
    if (row.revision !== expectedRevision) throw new Error('stale_draft');
    return linkedInDraftSchema.parse({ id: row.id, workspaceId: row.workspace_id, accountId: row.account_id, enrollmentId: row.enrollment_id, campaignVersionId: row.campaign_version_id,
      personId: row.person_id, stepId: row.step_id, routeId: row.route_id, routeVersion: row.route_version, contextRevision: row.context_revision, executionContextId: row.execution_context_id,
      revision: row.revision, body: row.body, contentHash: row.content_hash, targetHash: row.target_hash, state: row.state, updatedAt: row.updated_at });
  }
  requireAction(draftId: string, expectedRevision: number): { draft: LinkedInDraft; context: LinkedInStepContext } {
    const draft = this.requireRevision(draftId, expectedRevision); const e = this.enrollment();
    if (e.selected_route_id !== draft.routeId || e.selected_route_version !== draft.routeVersion || e.context_revision !== draft.contextRevision || e.execution_context_id !== draft.executionContextId
      || e.person_id !== draft.personId || e.campaign_version_id !== draft.campaignVersionId) throw new Error('stale_context');
    const context = this.requireStep(draft.stepId, Number(e.version));
    if (draft.state === 'held' || draft.state === 'closed' || linkedInHash(draft.body) !== draft.contentHash || context.targetHash !== draft.targetHash) throw new Error('draft_unavailable');
    return { draft, context };
  }
  approve(input: { commandId: string; draftId: string; expectedRevision: number }) {
    z.uuid().parse(input.commandId);
    return this.atomic(() => {
      const { draft, context } = this.requireAction(input.draftId, input.expectedRevision);
      const previous = this.raw.prepare('SELECT command_id,content_hash,target_hash,context_revision,execution_context_id FROM manual_linkedin_draft_approvals WHERE workspace_id=? AND draft_id=? AND draft_revision=?')
        .get(draft.workspaceId, draft.id, draft.revision) as Record<string, unknown> | undefined;
      if (previous && (previous.command_id !== input.commandId || previous.content_hash !== draft.contentHash || previous.target_hash !== draft.targetHash
        || previous.context_revision !== draft.contextRevision || previous.execution_context_id !== draft.executionContextId)) throw new Error('approval_command_conflict');
      if (!previous) this.raw.prepare('INSERT INTO manual_linkedin_draft_approvals(workspace_id,draft_id,draft_revision,content_hash,target_hash,context_revision,execution_context_id,approved_at,command_id) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(draft.workspaceId, draft.id, draft.revision, draft.contentHash, draft.targetHash, draft.contextRevision, draft.executionContextId, this.deps.clock.now(), input.commandId);
      this.raw.prepare("UPDATE manual_linkedin_drafts SET state='approved' WHERE workspace_id=? AND id=? AND revision=?").run(draft.workspaceId, draft.id, draft.revision);
      const campaign = new CampaignRepository(this.deps).getVersion(draft.campaignVersionId);
      return { commandId: input.commandId, binding: manualHandoffBindingSchema.parse({ actionId: `${draft.id}:${draft.revision}`, channel: 'linkedin', routeId: draft.routeId,
        routeVersion: draft.routeVersion, contentHash: draft.contentHash, targetHash: draft.targetHash, contextRevision: draft.executionContextId,
        campaign: { campaignId: campaign.campaignId, campaignRevision: campaign.version, enrollmentId: draft.enrollmentId, enrollmentRevision: context.enrollmentVersion, stepId: draft.stepId } }) };
    });
  }
  find(context: LinkedInStepContext): LinkedInDraft | null {
    const row = this.raw.prepare('SELECT id,revision FROM manual_linkedin_drafts WHERE workspace_id=? AND enrollment_id=? AND step_id=? AND execution_context_id=? AND context_revision=?')
      .get(this.deps.workspaceId, this.deps.enrollmentId, context.stepId, context.executionContextId, context.contextRevision) as { id: string; revision: number } | undefined;
    return row ? this.requireRevision(row.id, row.revision) : null;
  }
  generationContext(context: LinkedInStepContext) {
    const current = this.requireStep(context.stepId, context.enrollmentVersion);
    if (JSON.stringify(current) !== JSON.stringify(context)) throw new Error('stale_context');
    const account = this.raw.prepare('SELECT name FROM pm_accounts WHERE id=?').get(context.accountId) as { name: string };
    const person = context.personId === null ? null : this.raw.prepare('SELECT display_name FROM persons WHERE id=?').get(context.personId) as { display_name: string };
    const facts = this.raw.prepare(`SELECT s.id,s.excerpt AS text FROM pm_account_sources s JOIN pm_account_route_evidence e ON e.source_id=s.id AND e.account_id=s.account_id
      WHERE e.account_id=? AND e.route_id=? AND e.route_version=? AND s.permitted=1 ORDER BY s.id`).all(context.accountId, context.routeId, context.routeVersion) as { id: string; text: string }[];
    if (!facts.length) throw new Error('linkedin_evidence_unavailable');
    return { accountId: context.accountId, personId: context.personId, accountName: account.name, personName: person?.display_name ?? null,
      facts: facts.map(f => ({ ...f, id: `source:${f.id}` })) };
  }
  create(context: LinkedInStepContext, body: string): LinkedInDraft {
    linkedInBodySchema.parse(body);
    return this.atomic(() => {
      const current = this.requireStep(context.stepId, context.enrollmentVersion);
      if (JSON.stringify(current) !== JSON.stringify(context)) throw new Error('stale_context');
      const old = this.raw.prepare('SELECT id,revision FROM manual_linkedin_drafts WHERE workspace_id=? AND enrollment_id=? AND step_id=? AND execution_context_id=? AND context_revision=?')
        .get(context.workspaceId, context.enrollmentId, context.stepId, context.executionContextId, context.contextRevision) as { id: string; revision: number } | undefined;
      if (old) return this.requireRevision(old.id, old.revision);
      const draftId = randomUUID(); const at = this.deps.clock.now();
      this.raw.prepare(`INSERT INTO manual_linkedin_drafts(workspace_id,id,account_id,enrollment_id,campaign_version_id,person_id,step_id,route_id,route_version,context_revision,execution_context_id,revision,body,content_hash,target_hash,state,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,'draft',?,?)`).run(context.workspaceId, draftId, context.accountId, context.enrollmentId, context.campaignVersionId, context.personId, context.stepId,
        context.routeId, context.routeVersion, context.contextRevision, context.executionContextId, body, linkedInHash(body), context.targetHash, at, at);
      return this.requireRevision(draftId, 1);
    });
  }
  save(raw: LinkedInSave): LinkedInDraft {
    const input = linkedInSaveSchema.parse(raw);
    return this.atomic(() => {
      const { draft } = this.requireAction(input.draftId, input.expectedRevision);
      if (draft.revision === Number.MAX_SAFE_INTEGER) throw new Error('revision_exhausted');
      const result = this.raw.prepare("UPDATE manual_linkedin_drafts SET body=?,content_hash=?,revision=revision+1,state='draft',updated_at=? WHERE workspace_id=? AND enrollment_id=? AND id=? AND revision=?")
        .run(input.body, linkedInHash(input.body), this.deps.clock.now(), this.deps.workspaceId, this.deps.enrollmentId, draft.id, draft.revision);
      if (result.changes !== 1) throw new Error('stale_draft');
      return this.requireRevision(draft.id, draft.revision + 1);
    });
  }
}
