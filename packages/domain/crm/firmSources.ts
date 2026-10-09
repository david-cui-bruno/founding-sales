import { prepareRecaptureContexts, recordRecaptureContexts } from './relationships.ts';
import { recordCrmAuditEvent } from './audit.ts';
import { invalidateSelectedIdentitySources } from './identityInvalidation.ts';
import { createHash } from 'node:crypto';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { activeIdentityActor, sourceAccessPredicate, lockIdentityContext } from './identityAccess.ts';
export async function addFirmSource(context: RepositoryContext, input: {
  firmId: string;
  sourceKey: string;
  excerpt: string;
  occurredAt: string;
}) {
  if (!await lockIdentityContext(context, { firmIds: [input.firmId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return { ok: false as const, reason: 'identity_access_denied' };
  const key = createHash('sha256').update(input.sourceKey).digest('hex'), hash = createHash('sha256').update(input.excerpt).digest('hex');
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.scope.workspaceId}:${actor.userId}:${key}`]);
  const previous = (await context.db.query<{
    id: string;
    firm_id: string | null;
    availability: string;
    content_hash: string | null;
    occurred_at: Date | null;
  }>('SELECT id,firm_id,availability,content_hash,occurred_at FROM crm_selected_sources WHERE workspace_id=$1 AND owner_user_id=$2 AND source_key_hash=$3 FOR UPDATE', [context.scope.workspaceId, actor.userId, key])).rows[0];
  if (!await activeIdentityActor(context))
    return { ok: false as const, reason: 'identity_access_denied' };
  if (previous !== undefined) {
    if (previous.firm_id !== input.firmId)
      return { ok: false as const, reason: 'source_identity_conflict' };
    if (previous.availability === 'deleted')
      return { ok: false as const, reason: 'source_deleted' };
    if (previous.availability === 'available')
      return previous.content_hash === hash && previous.occurred_at?.toISOString() === new Date(input.occurredAt).toISOString() ? { ok: true as const, value: { sourceId: previous.id } } : { ok: false as const, reason: 'source_identity_conflict' };
    return { ok: false as const, reason: 'source_requires_explicit_recapture' };
  }
  const { rows } = await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_selected_sources(workspace_id,firm_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [context.scope.workspaceId, input.firmId, actor.userId, key, input.excerpt, hash, input.occurredAt]);
  return { ok: true as const, value: { sourceId: rows[0]?.id } };
}
export async function readFirmSources(context: RepositoryContext, input: {
  firmId: string;
  afterSourceId?: string | undefined;
  limit: number;
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  const query = () => context.db.query<{
    id: string;
    revision: number;
    content_hash: string | null;
    excerpt: string | null;
    occurred_at: Date | null;
    observed_at: Date;
    availability: 'available' | 'deleted' | 'awaiting_recapture';
  }>(`SELECT s.id,s.revision,s.content_hash,s.excerpt,s.occurred_at,s.observed_at,s.availability FROM crm_selected_sources s WHERE s.workspace_id=$1 AND s.firm_id=$2 AND ${sourceAccessPredicate('$3', '$4')} AND ($5::uuid IS NULL OR s.id>$5) ORDER BY s.id LIMIT $6`, [context.scope.workspaceId, input.firmId, actor.role === 'admin', actor.userId, input.afterSourceId ?? null, input.limit + 1]);
  const initial = (await query()).rows;
  if (!await lockIdentityContext(context, { firmIds: [input.firmId], sourceIds: initial.map(source => source.id), requireActiveFirms: false }))
    return null;
  const rows = (await query()).rows.filter(source => initial.some(old => old.id === source.id && old.revision === source.revision && old.content_hash === source.content_hash));
  if (!await activeIdentityActor(context))
    return null;
  if (actor.role === 'admin')
    await recordCrmAuditEvent(context, { action: 'crm.firm_source_read', subjectKind: 'firm', subjectId: input.firmId });
  return { sources: rows.slice(0, input.limit).map(source => ({ workspaceId: context.scope.workspaceId, sourceId: source.id, kind: 'selected_note', revision: source.revision, contentHash: source.content_hash, locator: source.availability === 'available' ? 'selected_excerpt' : null, speaker: null, occurredAt: source.occurred_at?.toISOString() ?? null, observedAt: source.observed_at.toISOString(), completeness: source.availability === 'available' ? 'selected_excerpt' : 'unavailable', availability: source.availability, excerpt: source.excerpt })), nextAfterSourceId: rows.length > input.limit ? rows[input.limit - 1]?.id ?? null : null };
}
export async function changeFirmSource(context: RepositoryContext, input: {
  firmId: string;
  sourceId: string;
  expectedRevision: number;
  excerpt?: string | undefined;
  occurredAt?: string | undefined;
}, action: 'delete' | 'restore' | 'recapture') {
  if (!await lockIdentityContext(context, { firmIds: [input.firmId], sourceIds: [input.sourceId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  const source = (await context.db.query<{
    revision: number;
    firm_id: string | null;
    availability: string;
  }>('SELECT revision,firm_id,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.sourceId])).rows[0];
  if (source === undefined || source.firm_id !== input.firmId)
    return { ok: false as const, reason: 'identity_access_denied' };
  if (source.revision !== input.expectedRevision)
    return { ok: false as const, reason: 'source_revision_changed' };
  if (action === 'restore' && source.availability !== 'deleted' || action === 'recapture' && source.availability !== 'awaiting_recapture')
    return { ok: false as const, reason: 'source_not_restored' };
  if (action === 'recapture') {
    if (input.excerpt === undefined || input.occurredAt === undefined)
      return { ok: false as const, reason: 'source_invalid' };
    const contexts = await prepareRecaptureContexts(context, input.sourceId);
    if (contexts === null)
      return { ok: false as const, reason: 'source_context_limit' };
    const contentHash = createHash('sha256').update(input.excerpt).digest('hex');
    await context.db.query(`UPDATE crm_selected_sources SET availability='available',excerpt=$3,content_hash=$4,occurred_at=$5,observed_at=now(),revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.sourceId, input.excerpt, contentHash, input.occurredAt]);
    await recordRecaptureContexts(context, { sourceId: input.sourceId, revision: source.revision + 1, contentHash }, contexts);
  }
  else {
    await context.db.query('UPDATE crm_selected_sources SET availability=$3,excerpt=NULL,content_hash=NULL,occurred_at=NULL,revision=revision+1 WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.sourceId, action === 'delete' ? 'deleted' : 'awaiting_recapture']);
    if (action === 'delete')
      await invalidateSelectedIdentitySources(context, [input.sourceId]);
  }
  return { ok: true as const, value: { sourceId: input.sourceId, revision: source.revision + 1 } };
}
