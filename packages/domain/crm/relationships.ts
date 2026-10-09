import type { z } from 'zod';
import type { relationshipSaveSchema, relationshipListSchema, IdentityEvidence } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import { activeIdentityActor, evidenceAvailable, sourceAccessPredicate, sourceContextPredicate, lockIdentityContext } from './identityAccess.ts';
export type RelationshipInput = z.infer<typeof relationshipSaveSchema>;
interface Row extends QueryResultRowLike {
  id: string;
  person_id: string;
  firm_id: string;
  firm_name: string;
  status: 'current' | 'historical' | 'unknown';
  start_date: string | null;
  end_date: string | null;
  revision: number;
  source_id: string;
  source_revision: number;
  source_hash: string;
  context_review: 'current' | 'required';
  source_invalidated: boolean;
}
const columns = `r.id,r.person_id,r.firm_id,f.name AS firm_name,r.status,r.start_date::text,r.end_date::text,r.revision,r.source_id,r.source_revision,r.source_hash,r.context_review,r.source_invalidated`;
export async function saveRelationship(context: RepositoryContext, input: RelationshipInput) {
  if (input.startDate !== null && input.endDate !== null && input.startDate > input.endDate)
    return { ok: false as const, reason: 'relationship_dates_invalid' };
  if (!await lockIdentityContext(context, { personIds: [input.personId], firmIds: [input.firmId], sourceIds: [input.evidence.sourceId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  if (!await evidenceAvailable(context, input.evidence))
    return { ok: false as const, reason: 'identity_evidence_unavailable' };
  const { rows } = await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_relationships(workspace_id,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [context.scope.workspaceId, input.personId, input.firmId, input.status, input.startDate, input.endDate, input.evidence.sourceId, input.evidence.sourceRevision, input.evidence.contentHash]);
  const relationshipId = rows[0]?.id;
  await context.db.query(`INSERT INTO crm_relationship_revisions(workspace_id,relationship_id,revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,actor_user_id) SELECT workspace_id,id,revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,$3 FROM crm_relationships WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, relationshipId, context.scope.actor.kind === 'user' ? context.scope.actor.userId : null]);
  return { ok: true as const, value: { relationshipId, revision: 1 } };
}
export async function readRelationships(context: RepositoryContext, input: {
  personId: string;
  afterId?: string | undefined;
  limit: number;
}): Promise<z.infer<typeof relationshipListSchema> | null> {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  const query = async () => context.db.query<Row>(`SELECT ${columns} FROM crm_relationships r JOIN firms f ON f.workspace_id=r.workspace_id AND f.id=r.firm_id JOIN crm_selected_sources s ON s.workspace_id=r.workspace_id AND s.id=r.source_id WHERE r.workspace_id=$1 AND r.person_id=$2 AND ($3::uuid IS NULL OR r.id>$3) AND ($4::boolean OR f.assigned_user_id=$5) AND ${sourceAccessPredicate('$4', '$5')} ORDER BY r.id LIMIT $6`, [context.scope.workspaceId, input.personId, input.afterId ?? null, actor.role === 'admin', actor.userId, input.limit + 1]);
  const initial = (await query()).rows;
  if (!await lockIdentityContext(context, { personIds: [input.personId], sourceIds: initial.map(row => row.source_id), firmIds: initial.map(row => row.firm_id), requireActiveFirms: false }))
    return null;
  const rows = (await query()).rows.filter(row => initial.some(previous => previous.id === row.id && previous.revision === row.revision && previous.firm_id === row.firm_id && previous.source_id === row.source_id));
  const relationships: z.infer<typeof relationshipListSchema>['relationships'] = [];
  for (const row of rows.slice(0, input.limit)) {
    const evidence = { sourceId: row.source_id, sourceRevision: row.source_revision, contentHash: row.source_hash };
    relationships.push({ relationshipId: row.id, personId: row.person_id, firmId: row.firm_id, firmName: row.firm_name, status: row.status, startDate: row.start_date, endDate: row.end_date, revision: row.revision, evidence, sourceState: !row.source_invalidated && await evidenceAvailable(context, evidence) ? 'available' : 'unavailable', contextReview: row.context_review });
  }
  if (!await activeIdentityActor(context))
    return null;
  return { relationships, nextAfterId: rows.length > input.limit ? rows[input.limit - 1]?.id ?? null : null };
}
export async function correctRelationship(context: RepositoryContext, input: RelationshipInput & {
  relationshipId: string;
  expectedRevision: number;
}) {
  if (input.startDate !== null && input.endDate !== null && input.startDate > input.endDate)
    return { ok: false as const, reason: 'relationship_dates_invalid' };
  const old = (await context.db.query<Row>(`SELECT ${columns} FROM crm_relationships r JOIN firms f ON f.workspace_id=r.workspace_id AND f.id=r.firm_id WHERE r.workspace_id=$1 AND r.id=$2`, [context.scope.workspaceId, input.relationshipId])).rows[0];
  if (old === undefined || old.person_id !== input.personId)
    return { ok: false as const, reason: 'identity_access_denied' };
  if (!await lockIdentityContext(context, { personIds: [input.personId], firmIds: [old.firm_id, input.firmId], sourceIds: [old.source_id, input.evidence.sourceId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  const current = (await context.db.query<{
    revision: number;
    firm_id: string;
    source_id: string;
  }>('SELECT revision,firm_id,source_id FROM crm_relationships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.relationshipId])).rows[0];
  if (current?.revision !== input.expectedRevision || current.firm_id !== old.firm_id || current.source_id !== old.source_id)
    return { ok: false as const, reason: 'relationship_revision_changed' };
  if (!await evidenceAvailable(context, input.evidence))
    return { ok: false as const, reason: 'identity_evidence_unavailable' };
  await context.db.query(`UPDATE crm_relationships SET firm_id=$3,status=$4,start_date=$5,end_date=$6,source_id=$7,source_revision=$8,source_hash=$9,revision=revision+1,context_review='required',source_invalidated=false WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.relationshipId, input.firmId, input.status, input.startDate, input.endDate, input.evidence.sourceId, input.evidence.sourceRevision, input.evidence.contentHash]);
  await context.db.query(`INSERT INTO crm_relationship_revisions(workspace_id,relationship_id,revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,actor_user_id) SELECT workspace_id,id,revision,person_id,firm_id,status,start_date,end_date,source_id,source_revision,source_hash,$3 FROM crm_relationships WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.relationshipId, context.scope.actor.kind === 'user' ? context.scope.actor.userId : null]);
  await context.db.query("UPDATE crm_source_relationship_contexts SET review='required' WHERE workspace_id=$1 AND relationship_id=$2", [context.scope.workspaceId, input.relationshipId]);
  return { ok: true as const, value: { relationshipId: input.relationshipId, revision: input.expectedRevision + 1 } };
}
export async function saveSourceContext(context: RepositoryContext, input: {
  personId: string;
  relationshipId: string;
  relationshipRevision: number;
  evidence: IdentityEvidence;
}) {
  const relation = (await context.db.query<{
    person_id: string;
    firm_id: string;
    revision: number;
    source_id: string;
  }>('SELECT person_id,firm_id,revision,source_id FROM crm_relationships WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.relationshipId])).rows[0];
  if (relation === undefined || relation.person_id !== input.personId)
    return { ok: false as const, reason: 'identity_access_denied' };
  if (!await lockIdentityContext(context, { personIds: [input.personId], firmIds: [relation.firm_id], sourceIds: [input.evidence.sourceId, relation.source_id] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  const current = (await context.db.query<{
    revision: number;
    firm_id: string;
    source_id: string;
    source_revision: number;
    source_hash: string;
    source_invalidated: boolean;
  }>('SELECT revision,firm_id,source_id,source_revision,source_hash,source_invalidated FROM crm_relationships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, input.relationshipId])).rows[0];
  if (current?.revision !== input.relationshipRevision || current.firm_id !== relation.firm_id || current.source_id !== relation.source_id)
    return { ok: false as const, reason: 'relationship_revision_changed' };
  if (current.source_invalidated || !await evidenceAvailable(context, { sourceId: current.source_id, sourceRevision: current.source_revision, contentHash: current.source_hash }) || !await evidenceAvailable(context, input.evidence))
    return { ok: false as const, reason: 'identity_evidence_unavailable' };
  const { rows } = await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_source_relationship_contexts(workspace_id,source_id,source_revision,source_hash,relationship_id,relationship_revision,person_id,firm_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(workspace_id,source_id,source_revision,relationship_id,relationship_revision) DO UPDATE SET review=crm_source_relationship_contexts.review RETURNING id`, [context.scope.workspaceId, input.evidence.sourceId, input.evidence.sourceRevision, input.evidence.contentHash, input.relationshipId, input.relationshipRevision, input.personId, relation.firm_id]);
  return { ok: true as const, value: { contextId: rows[0]?.id, sourceId: input.evidence.sourceId, relationshipId: input.relationshipId, relationshipRevision: input.relationshipRevision } };
}
export async function readSourceContexts(context: RepositoryContext, input: {
  personId: string;
  afterId?: string | undefined;
  limit: number;
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  const query = () => context.db.query<{
    id: string;
    source_id: string;
    source_revision: number;
    source_hash: string;
    relationship_id: string;
    relationship_revision: number;
    firm_id: string;
    review: 'current' | 'required';
    current_relation_revision: number;
    relation_invalidated: boolean;
    current_source_revision: number;
    current_source_hash: string | null;
    availability: string;
  }>(`SELECT c.id,c.source_id,c.source_revision,c.source_hash,c.relationship_id,c.relationship_revision,c.firm_id,c.review,r.revision AS current_relation_revision,r.source_invalidated AS relation_invalidated,s.revision AS current_source_revision,s.content_hash AS current_source_hash,s.availability FROM crm_source_relationship_contexts c JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id JOIN crm_relationships r ON r.workspace_id=c.workspace_id AND r.id=c.relationship_id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND c.person_id=$2 AND ($3::uuid IS NULL OR c.id>$3) AND ($4::boolean OR f.assigned_user_id=$5) AND ${sourceAccessPredicate('$4', '$5')} ORDER BY c.id LIMIT $6`, [context.scope.workspaceId, input.personId, input.afterId ?? null, actor.role === 'admin', actor.userId, input.limit + 1]);
  const initial = (await query()).rows;
  if (!await lockIdentityContext(context, { personIds: [input.personId], firmIds: initial.map(row => row.firm_id), sourceIds: initial.map(row => row.source_id), requireActiveFirms: false }))
    return null;
  for (const relationshipId of [...new Set(initial.map(row => row.relationship_id))].sort())
    await context.db.query('SELECT id FROM crm_relationships WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, relationshipId]);
  const rows = (await query()).rows.filter(row => initial.some(old => old.id === row.id && old.source_id === row.source_id && old.source_revision === row.source_revision && old.firm_id === row.firm_id && old.relationship_revision === row.relationship_revision));
  if (!await activeIdentityActor(context))
    return null;
  return { contexts: rows.slice(0, input.limit).map(row => ({ contextId: row.id, sourceId: row.source_id, relationshipId: row.relationship_id, relationshipRevision: row.relationship_revision, firmId: row.firm_id, review: row.review === 'required' || row.relation_invalidated || row.current_relation_revision !== row.relationship_revision || row.availability !== 'available' || row.current_source_revision !== row.source_revision || row.current_source_hash !== row.source_hash ? 'required' : 'current' })), nextAfterId: rows.length > input.limit ? rows[input.limit - 1]?.id ?? null : null };
}
interface RecaptureContext extends QueryResultRowLike {
  relationship_id: string;
  relationship_revision: number;
  person_id: string;
  firm_id: string;
}
/** Bound restoration work before any new body is retained; preserve immutable original snapshots. */
export async function prepareRecaptureContexts(context: RepositoryContext, sourceId: string): Promise<RecaptureContext[] | null> {
  const { rows } = await context.db.query<RecaptureContext>(`SELECT cx.relationship_id,cx.relationship_revision,cx.person_id,cx.firm_id FROM crm_selected_sources s JOIN crm_source_relationship_contexts cx ON ${sourceContextPredicate()} WHERE s.workspace_id=$1 AND s.id=$2 ORDER BY cx.id LIMIT 101`, [context.scope.workspaceId, sourceId]);
  return rows.length > 100 ? null : rows;
}
export async function recordRecaptureContexts(context: RepositoryContext, input: {
  sourceId: string;
  revision: number;
  contentHash: string;
}, snapshots: readonly RecaptureContext[]): Promise<void> {
  for (const snapshot of snapshots)
    await context.db.query(`INSERT INTO crm_source_relationship_contexts(workspace_id,source_id,source_revision,source_hash,relationship_id,relationship_revision,person_id,firm_id,review) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'required')`, [context.scope.workspaceId, input.sourceId, input.revision, input.contentHash, snapshot.relationship_id, snapshot.relationship_revision, snapshot.person_id, snapshot.firm_id]);
}
