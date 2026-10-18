import type { LinkedinManualBind, LinkedinManualView } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor, evidenceAvailable, lockIdentityContext } from './identityAccess.ts';
import { recordCrmAuditEvent } from './audit.ts';

export interface ManualLedgerRow {
  id: string; owner_user_id: string; account_id: string; person_id: string; firm_id: string;
  claim_id: string; claim_revision: number; relationship_id: string; relationship_revision: number;
  [key: string]: unknown;
}
interface BindingRow {
  person_id: string; firm_id: string; claim_id: string; claim_revision: number;
  relationship_id: string; relationship_revision: number; person_name: string; firm_name: string;
  profile: string | null; shared: boolean; claim_invalidated: boolean; relationship_invalidated: boolean;
  claim_source: string; claim_source_revision: number; claim_hash: string;
  relationship_source: string; relationship_source_revision: number; relationship_hash: string;
  [key: string]: unknown;
}
const bindingSql = `SELECT c.person_id,r.firm_id,c.id AS claim_id,c.revision AS claim_revision,
 r.id AS relationship_id,r.revision AS relationship_revision,p.full_name AS person_name,f.name AS firm_name,
 e.value AS profile,c.shared,c.source_invalidated AS claim_invalidated,r.source_invalidated AS relationship_invalidated,
 c.source_id AS claim_source,c.source_revision AS claim_source_revision,c.source_hash AS claim_hash,
 r.source_id AS relationship_source,r.source_revision AS relationship_source_revision,r.source_hash AS relationship_hash
 FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id
 JOIN crm_people p ON p.workspace_id=c.workspace_id AND p.id=c.person_id
 JOIN crm_relationships r ON r.workspace_id=c.workspace_id AND r.person_id=c.person_id
 JOIN firms f ON f.workspace_id=r.workspace_id AND f.id=r.firm_id
 WHERE c.workspace_id=$1 AND e.kind='linkedin' AND c.status='current' AND r.status IN ('current','unknown')
 AND r.context_review='current' AND f.status='active' AND ($2::boolean OR f.assigned_user_id=$3)
 AND (c.start_date IS NULL OR c.start_date<=CURRENT_DATE) AND (c.end_date IS NULL OR c.end_date>=CURRENT_DATE)
 AND (r.start_date IS NULL OR r.start_date<=CURRENT_DATE) AND (r.end_date IS NULL OR r.end_date>=CURRENT_DATE)`;

async function availableBinding(ctx: RepositoryContext, row: BindingRow): Promise<boolean> {
  if (row.profile === null || row.shared || row.claim_invalidated || row.relationship_invalidated) return false;
  if (!await lockIdentityContext(ctx, { personIds: [row.person_id], firmIds: [row.firm_id], sourceIds: [row.claim_source, row.relationship_source] })) return false;
  return await evidenceAvailable(ctx, { sourceId: row.claim_source, sourceRevision: row.claim_source_revision, contentHash: row.claim_hash })
    && await evidenceAvailable(ctx, { sourceId: row.relationship_source, sourceRevision: row.relationship_source_revision, contentHash: row.relationship_hash });
}

async function auditExceptionalBinding(ctx: RepositoryContext, row: BindingRow) {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || actor.role !== 'admin') return;
  const sources = (await ctx.db.query<{ id: string; revision: number }>('SELECT id,revision FROM crm_selected_sources WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND owner_user_id<>$3 ORDER BY id', [ctx.scope.workspaceId, [row.claim_source, row.relationship_source], actor.userId])).rows;
  for (const source of sources) await recordCrmAuditEvent(ctx, { action: 'linkedin.manual_private_evidence_read', subjectKind: 'selected_source', subjectId: source.id, detail: { sourceRevision: source.revision, claimId: row.claim_id, relationshipId: row.relationship_id } });
}

/** No profile/name copies: current erasure-aware CRM evidence is rechecked on every read. */
export async function manualBindingChoices(ctx: RepositoryContext): Promise<LinkedinManualView['choices']> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || !await activeIdentityActor(ctx)) return [];
  const rows = (await ctx.db.query<BindingRow>(`${bindingSql} ORDER BY c.id,r.id LIMIT 101`, [ctx.scope.workspaceId, actor.role === 'admin', actor.userId])).rows;
  const choices: LinkedinManualView['choices'] = [];
  for (const row of rows.slice(0, 100)) {
    if (!await availableBinding(ctx, row)) continue;
    // Repeat after identity locks so a concurrent correction cannot leak old profile bytes.
    const fresh = (await ctx.db.query<BindingRow>(`${bindingSql} AND c.id=$4 AND r.id=$5`, [ctx.scope.workspaceId, actor.role === 'admin', actor.userId, row.claim_id, row.relationship_id])).rows[0];
    if (!fresh || fresh.claim_revision !== row.claim_revision || fresh.relationship_revision !== row.relationship_revision || fresh.profile === null || !await availableBinding(ctx, fresh)) continue;
    await auditExceptionalBinding(ctx, fresh);
    choices.push({ personId: fresh.person_id, firmId: fresh.firm_id, claimId: fresh.claim_id, claimRevision: fresh.claim_revision, relationshipId: fresh.relationship_id, relationshipRevision: fresh.relationship_revision, personName: fresh.person_name, firmName: fresh.firm_name, profile: fresh.profile });
  }
  return choices;
}

export async function currentManualBinding(ctx: RepositoryContext, input: LinkedinManualBind) {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user') return null;
  const row = (await ctx.db.query<BindingRow>(`${bindingSql} AND c.id=$4 AND r.id=$5`, [ctx.scope.workspaceId, actor.role === 'admin', actor.userId, input.claimId, input.relationshipId])).rows[0];
  if (!row || row.person_id !== input.personId || row.firm_id !== input.firmId || row.claim_revision !== input.claimRevision || row.relationship_revision !== input.relationshipRevision || !await availableBinding(ctx, row)) return null;
  const fresh = (await ctx.db.query<BindingRow>(`${bindingSql} AND c.id=$4 AND r.id=$5`, [ctx.scope.workspaceId, actor.role === 'admin', actor.userId, input.claimId, input.relationshipId])).rows[0];
  if (!fresh || fresh.claim_revision !== input.claimRevision || fresh.relationship_revision !== input.relationshipRevision || !await availableBinding(ctx, fresh)) return null;
  await auditExceptionalBinding(ctx, fresh);
  return fresh;
}

export async function accessibleManualLedger(ctx: RepositoryContext, ledgerId: string): Promise<ManualLedgerRow | null> {
  const actor = ctx.scope.actor;
  if (actor.kind !== 'user' || !await activeIdentityActor(ctx)) return null;
  const row = (await ctx.db.query<ManualLedgerRow>('SELECT l.* FROM linkedin_manual_ledgers l JOIN social_accounts a ON a.workspace_id=l.workspace_id AND a.id=l.account_id AND a.owner_user_id=l.owner_user_id WHERE l.workspace_id=$1 AND l.id=$2 AND l.owner_user_id=$3', [ctx.scope.workspaceId, ledgerId, actor.userId])).rows[0];
  if (!row || !await lockIdentityContext(ctx, { personIds: [row.person_id], firmIds: [row.firm_id] })) return null;
  return row;
}
