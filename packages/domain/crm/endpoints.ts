import { createHash } from 'node:crypto';
import type { z } from 'zod';
import type { endpointClaimSchema, endpointListSchema } from '@fss/contracts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import { activeIdentityActor, evidenceAvailable, sourceAccessPredicate, lockIdentityContext, readIdentityPerson } from './identityAccess.ts';
export type EndpointInput = z.infer<typeof endpointClaimSchema>;
interface Claim extends QueryResultRowLike {
  id: string;
  endpoint_id: string;
  kind: 'email' | 'phone';
  value: string | null;
  value_hash: string;
  person_id: string | null;
  firm_id: string | null;
  firm_name: string | null;
  shared: boolean;
  status: 'current' | 'historical' | 'unknown';
  start_date: string | null;
  end_date: string | null;
  revision: number;
  source_id: string;
  source_revision: number;
  source_hash: string;
  source_invalidated: boolean;
}
const columns = `c.id,c.endpoint_id,e.kind,e.value,e.value_hash,c.person_id,c.firm_id,f.name AS firm_name,c.shared,c.status,c.start_date::text,c.end_date::text,c.revision,c.source_id,c.source_revision,c.source_hash,c.source_invalidated`;
export function normalizeIdentityEndpoint(kind: 'email' | 'phone', value: string): string | null {
  const trimmed = value.trim();
  if (kind === 'phone')
    return /^\+[1-9]\d{6,14}$/u.test(trimmed) ? trimmed : null;
  const split = trimmed.lastIndexOf('@');
  if (split < 1 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(trimmed))
    return null;
  return trimmed.slice(0, split + 1) + trimmed.slice(split + 1).toLowerCase();
}
/** Fence absent and existing keys before row locks or upserts. Deletion uses sorted row locks only. */
async function lockEndpointKeys(context: RepositoryContext, keys: readonly string[]) {
  for (const key of [...new Set(keys)].sort())
    await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`identity-endpoint:${context.scope.workspaceId}:${key}`]);
}
export async function claimEndpoint(context: RepositoryContext, input: EndpointInput) {
  const value = normalizeIdentityEndpoint(input.kind, input.value);
  if (value === null)
    return { ok: false as const, reason: 'endpoint_invalid' };
  if (input.startDate !== null && input.endDate !== null && input.startDate > input.endDate)
    return { ok: false as const, reason: 'relationship_dates_invalid' };
  if (!await lockIdentityContext(context, { personIds: input.personId === null ? [] : [input.personId], firmIds: input.firmId === null ? [] : [input.firmId], sourceIds: [input.evidence.sourceId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  if (!await evidenceAvailable(context, input.evidence))
    return { ok: false as const, reason: 'identity_evidence_unavailable' };
  const hash = createHash('sha256').update(value).digest('hex');
  await lockEndpointKeys(context, [`${input.kind}:${hash}`]);
  await context.db.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND kind=$2 AND value_hash=$3 FOR UPDATE', [context.scope.workspaceId, input.kind, hash]);
  if (!await activeIdentityActor(context))
    return { ok: false as const, reason: 'identity_access_denied' };
  const { rows } = await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_identity_endpoints(workspace_id,kind,value,value_hash) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,value_hash) DO UPDATE SET value=EXCLUDED.value RETURNING id`, [context.scope.workspaceId, input.kind, value, hash]);
  const endpointId = rows[0]?.id;
  const claim = (await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_endpoint_claims(workspace_id,endpoint_id,person_id,firm_id,shared,status,start_date,end_date,source_id,source_revision,source_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [context.scope.workspaceId, endpointId, input.personId, input.firmId, input.shared, input.status, input.startDate, input.endDate, input.evidence.sourceId, input.evidence.sourceRevision, input.evidence.contentHash])).rows[0];
  await writeClaimRevision(context, claim?.id ?? '');
  return { ok: true as const, value: { endpointId, claimId: claim?.id, revision: 1 } };
}
async function writeClaimRevision(context: RepositoryContext, claimId: string) {
  await context.db.query(`INSERT INTO crm_endpoint_claim_revisions(workspace_id,claim_id,revision,endpoint_id,person_id,firm_id,shared,status,start_date,end_date,source_id,source_revision,source_hash,actor_user_id) SELECT workspace_id,id,revision,endpoint_id,person_id,firm_id,shared,status,start_date,end_date,source_id,source_revision,source_hash,$3 FROM crm_endpoint_claims WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, claimId, context.scope.actor.kind === 'user' ? context.scope.actor.userId : null]);
}
async function claimDto(context: RepositoryContext, row: Claim): Promise<z.infer<typeof endpointListSchema>['claims'][number] | null> {
  const evidence = { sourceId: row.source_id, sourceRevision: row.source_revision, contentHash: row.source_hash };
  if (row.value === null)
    return null;
  const person = row.person_id === null ? null : await readIdentityPerson(context, row.person_id);
  if (row.person_id !== null && person === null)
    return null;
  return { claimId: row.id, endpointId: row.endpoint_id, kind: row.kind, value: row.value, personId: row.person_id, personName: person?.fullName ?? null, firmId: row.firm_id, firmName: row.firm_name, shared: row.shared, status: row.status, startDate: row.start_date, endDate: row.end_date, revision: row.revision, evidence, sourceState: !row.source_invalidated && await evidenceAvailable(context, evidence) ? 'available' : 'unavailable' };
}
export async function matchEndpoint(context: RepositoryContext, input: {
  kind: 'email' | 'phone';
  value: string;
}) {
  const empty = { personId: null, firmId: null, candidates: [] };
  const value = normalizeIdentityEndpoint(input.kind, input.value);
  if (value === null)
    return { outcome: 'no_supported_match', reason: 'no_supported_evidence', ...empty };
  const query = () => context.db.query<Claim>(`SELECT ${columns} FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND e.kind=$2 AND e.value_hash=$3 AND NOT c.source_invalidated ORDER BY c.id LIMIT 101`, [context.scope.workspaceId, input.kind, createHash('sha256').update(value).digest('hex')]);
  const rows = (await query()).rows;
  if (rows.length === 0)
    return { outcome: 'no_supported_match', reason: 'no_supported_evidence', ...empty };
  if (rows.length > 100 || !await lockIdentityContext(context, { personIds: rows.flatMap(row => row.person_id === null ? [] : [row.person_id]), firmIds: rows.flatMap(row => row.firm_id === null ? [] : [row.firm_id]), sourceIds: rows.map(row => row.source_id), requireActiveFirms: false }))
    return { outcome: 'needs_review', reason: 'uncertain_identity', ...empty };
  await context.db.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, rows[0]?.endpoint_id]);
  const current = (await query()).rows;
  if (current.length !== rows.length || current.some(row => !rows.some(previous => previous.id === row.id && previous.revision === row.revision && previous.source_id === row.source_id && previous.person_id === row.person_id && previous.firm_id === row.firm_id)))
    return { outcome: 'needs_review', reason: 'uncertain_identity', ...empty };
  const candidates = [];
  for (const row of current) {
    const candidate = await claimDto(context, row);
    if (candidate !== null)
      candidates.push(candidate);
  }
  if (!await activeIdentityActor(context))
    return null;
  const today = (await context.db.query<{
    today: string;
  }>("SELECT (clock_timestamp() AT TIME ZONE business_time_zone)::date::text AS today FROM workspaces WHERE id=$1", [context.scope.workspaceId])).rows[0]?.today;
  if (today === undefined || candidates.length !== 1 || candidates[0]?.sourceState !== 'available' || candidates[0]?.status !== 'current' || candidates[0]?.startDate === null || candidates[0].startDate > today || (candidates[0].endDate !== null && candidates[0].endDate < today))
    return { outcome: 'needs_review', reason: 'uncertain_identity', ...empty, candidates };
  const selected = candidates[0];
  return selected.shared ? { outcome: 'firm_endpoint_match', reason: 'shared_endpoint', ...empty, firmId: selected.firmId, candidates } : { outcome: 'person_match', reason: 'supported_unique', ...empty, personId: selected.personId, candidates };
}
export async function listEndpoints(context: RepositoryContext, input: {
  personId?: string | undefined;
  firmId?: string | undefined;
  afterId?: string | undefined;
  limit: number;
}) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user')
    return null;
  const query = () => context.db.query<Claim>(`SELECT ${columns} FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id LEFT JOIN crm_people p ON p.workspace_id=c.workspace_id AND p.id=c.person_id LEFT JOIN crm_legacy_contact_people b ON b.workspace_id=p.workspace_id AND b.person_id=p.id LEFT JOIN contacts lc ON lc.workspace_id=b.workspace_id AND lc.id=b.contact_id LEFT JOIN firms lf ON lf.workspace_id=lc.workspace_id AND lf.id=lc.firm_id WHERE c.workspace_id=$1 AND ($2::uuid IS NULL OR c.person_id=$2) AND ($3::uuid IS NULL OR c.firm_id=$3) AND ($4::uuid IS NULL OR c.id>$4) AND NOT c.source_invalidated AND e.value IS NOT NULL AND ($5::boolean OR c.person_id IS NOT NULL OR f.assigned_user_id=$6) AND ${sourceAccessPredicate('$5', '$6')} ORDER BY c.id LIMIT $7`, [context.scope.workspaceId, input.personId ?? null, input.firmId ?? null, input.afterId ?? null, actor.role === 'admin', actor.userId, input.limit + 1]);
  const initial = (await query()).rows;
  if (!await lockIdentityContext(context, { personIds: initial.flatMap(row => row.person_id === null ? [] : [row.person_id]), firmIds: initial.flatMap(row => row.firm_id === null ? [] : [row.firm_id]), sourceIds: initial.map(row => row.source_id), requireActiveFirms: false }))
    return null;
  const current = (await query()).rows.filter(row => initial.some(old => old.id === row.id && old.revision === row.revision && old.source_id === row.source_id && old.person_id === row.person_id && old.firm_id === row.firm_id));
  const claims = [];
  for (const row of current.slice(0, input.limit)) {
    const dto = await claimDto(context, row);
    if (dto !== null)
      claims.push(dto);
  }
  if (!await activeIdentityActor(context))
    return null;
  return { claims, nextAfterId: current.length > input.limit ? current[input.limit - 1]?.id ?? null : null };
}
export async function correctEndpoint(context: RepositoryContext, input: EndpointInput & {
  claimId: string;
  expectedRevision: number;
}) {
  const value = normalizeIdentityEndpoint(input.kind, input.value);
  if (value === null)
    return { ok: false as const, reason: 'endpoint_invalid' };
  if (input.startDate !== null && input.endDate !== null && input.startDate > input.endDate)
    return { ok: false as const, reason: 'relationship_dates_invalid' };
  const old = (await context.db.query<Claim>(`SELECT ${columns} FROM crm_endpoint_claims c JOIN crm_identity_endpoints e ON e.workspace_id=c.workspace_id AND e.id=c.endpoint_id LEFT JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE c.workspace_id=$1 AND c.id=$2`, [context.scope.workspaceId, input.claimId])).rows[0];
  if (old === undefined)
    return { ok: false as const, reason: 'identity_access_denied' };
  if (!await lockIdentityContext(context, { personIds: [old.person_id, input.personId].filter((id): id is string => id !== null), firmIds: [old.firm_id, input.firmId].filter((id): id is string => id !== null), sourceIds: [old.source_id, input.evidence.sourceId] }))
    return { ok: false as const, reason: 'identity_access_denied' };
  const current = (await context.db.query<{
    revision: number;
    source_id: string;
    person_id: string | null;
    firm_id: string | null;
  }>('SELECT revision,source_id,person_id,firm_id FROM crm_endpoint_claims WHERE workspace_id=$1 AND id=$2', [context.scope.workspaceId, input.claimId])).rows[0];
  if (current?.revision !== input.expectedRevision || current.source_id !== old.source_id || current.person_id !== old.person_id || current.firm_id !== old.firm_id)
    return { ok: false as const, reason: 'endpoint_revision_changed' };
  if (!await evidenceAvailable(context, input.evidence))
    return { ok: false as const, reason: 'identity_evidence_unavailable' };
  const hash = createHash('sha256').update(value).digest('hex');
  await lockEndpointKeys(context, [`${old.kind}:${old.value_hash}`, `${input.kind}:${hash}`]);
  const existing = (await context.db.query<{
    id: string;
  }>('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND kind=$2 AND value_hash=$3', [context.scope.workspaceId, input.kind, hash])).rows[0];
  for (const id of [...new Set([old.endpoint_id, ...(existing === undefined ? [] : [existing.id])])].sort())
    await context.db.query('SELECT id FROM crm_identity_endpoints WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [context.scope.workspaceId, id]);
  if (!await activeIdentityActor(context))
    return { ok: false as const, reason: 'identity_access_denied' };
  const endpoint = (await context.db.query<{
    id: string;
  }>(`INSERT INTO crm_identity_endpoints(workspace_id,kind,value,value_hash) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,kind,value_hash) DO UPDATE SET value=EXCLUDED.value RETURNING id`, [context.scope.workspaceId, input.kind, value, hash])).rows[0];
  await context.db.query(`UPDATE crm_endpoint_claims SET endpoint_id=$3,person_id=$4,firm_id=$5,shared=$6,status=$7,start_date=$8,end_date=$9,source_id=$10,source_revision=$11,source_hash=$12,source_invalidated=false,revision=revision+1 WHERE workspace_id=$1 AND id=$2`, [context.scope.workspaceId, input.claimId, endpoint?.id, input.personId, input.firmId, input.shared, input.status, input.startDate, input.endDate, input.evidence.sourceId, input.evidence.sourceRevision, input.evidence.contentHash]);
  await writeClaimRevision(context, input.claimId);
  await context.db.query(`UPDATE crm_identity_endpoints e SET value=NULL WHERE e.workspace_id=$1 AND e.id=$2 AND NOT EXISTS(SELECT 1 FROM crm_endpoint_claims c JOIN crm_selected_sources s ON s.workspace_id=c.workspace_id AND s.id=c.source_id WHERE c.workspace_id=e.workspace_id AND c.endpoint_id=e.id AND NOT c.source_invalidated AND s.availability='available' AND s.revision=c.source_revision AND s.content_hash=c.source_hash)`, [context.scope.workspaceId, old.endpoint_id]);
  return { ok: true as const, value: { endpointId: endpoint?.id, claimId: input.claimId, revision: input.expectedRevision + 1 } };
}
