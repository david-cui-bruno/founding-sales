import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { resolveCrmSource, type SourceLookup } from './sourceResolver.ts';

const PROCESSOR_VERSION = 'crm-extract-v1';
interface Generation extends QueryResultRowLike {
  id: string; purpose_revision: number; source_revision: number; processor_version: string; model_version: string | null;
  state: string; reason: string | null;
}
function dto(row: Generation) {
  return { generationId: row.id, purposeRevision: row.purpose_revision, sourceRevision: row.source_revision, processorVersion: row.processor_version,
    modelVersion: row.model_version, state: row.state, reason: row.reason, claims: [] };
}
export async function readCrmProcessing(context: RepositoryContext, source: SourceLookup) {
  if (await resolveCrmSource(context, { ...source, locator: null }) === null) return null;
  const purpose = await readCrmExtractionPurpose(context);
  const row = (await context.db.query<Generation>(`SELECT id,purpose_revision,source_revision,processor_version,model_version,state,reason
    FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 AND source_revision=$4
    AND source_hash=$5 AND processor_version=$6 AND purpose_revision=$7`,
  [context.scope.workspaceId, source.kind, source.sourceId, source.revision, source.contentHash, PROCESSOR_VERSION, purpose?.revision ?? 0])).rows[0];
  return row === undefined ? { state: 'not_requested', claims: [] } : dto(row);
}
export async function requestCrmProcessing(context: RepositoryContext, source: SourceLookup) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || await resolveCrmSource(context, { ...source, locator: null }) === null)
    return { ok: false as const, reason: 'source_unavailable' };
  const purpose = await readCrmExtractionPurpose(context);
  await context.db.query(`INSERT INTO crm_extraction_generations
    (workspace_id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,purpose_revision,model_version,state,reason)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unavailable',$10) ON CONFLICT DO NOTHING`,
  [context.scope.workspaceId, source.sourceId, source.kind, source.revision, source.contentHash, actor.userId, PROCESSOR_VERSION, purpose?.revision ?? 0, purpose?.modelVersion ?? null, purpose?.unavailableReason ?? 'purpose_not_configured']);
  return { ok: true as const, value: await readCrmProcessing(context, source) };
}

interface Purpose extends QueryResultRowLike {
  revision: number; enabled: boolean; endpoint_id: string; model_version: string;
  access_grant_version: string; data_handling_version: string; daily_ceiling_cents: number;
  monthly_ceiling_cents: number; input_token_price_micros: number; output_token_price_micros: number;
}
export async function readCrmExtractionPurpose(context: RepositoryContext) {
  const { activeIdentityActor } = await import('./identityAccess.ts');
  if (!await activeIdentityActor(context)) return null;
  const row = (await context.db.query<Purpose>('SELECT * FROM crm_extraction_purposes WHERE workspace_id=$1', [context.scope.workspaceId])).rows[0];
  if (row === undefined) return { enabled: false, configured: false, revision: 0, modelVersion: null, endpoint: null,
    dailyCeilingCents: 0, monthlyCeilingCents: 0, unavailableReason: 'purpose_not_configured' };
  return { enabled: row.enabled, configured: true, revision: row.revision, endpointId: row.endpoint_id,
    modelVersion: row.model_version, accessGrantVersion: row.access_grant_version, dataHandlingVersion: row.data_handling_version,
    dailyCeilingCents: row.daily_ceiling_cents, monthlyCeilingCents: row.monthly_ceiling_cents,
    inputTokenPriceMicros: row.input_token_price_micros, outputTokenPriceMicros: row.output_token_price_micros,
    unavailableReason: row.enabled ? null : 'activation_not_available' };
}
export async function saveCrmExtractionPurpose(context: RepositoryContext, input: {
  expectedRevision: number; enabled: boolean; endpointId: string; modelVersion: string;
  accessGrantVersion: string; dataHandlingVersion: string; dailyCeilingCents: number;
  monthlyCeilingCents: number; inputTokenPriceMicros: number; outputTokenPriceMicros: number;
}) {
  const actor = context.scope.actor;
  const { activeIdentityActor } = await import('./identityAccess.ts');
  if (actor.kind !== 'user' || actor.role !== 'admin' || !await activeIdentityActor(context))
    return { ok: false as const, reason: 'purpose_access_denied' };
  if (input.enabled) return { ok: false as const, reason: 'activation_not_available' };
  await context.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`${context.scope.workspaceId}:crm-extraction-purpose`]);
  if (!await activeIdentityActor(context)) return { ok: false as const, reason: 'purpose_access_denied' };
  const current = (await context.db.query<{ revision: number }>('SELECT revision FROM crm_extraction_purposes WHERE workspace_id=$1 FOR UPDATE', [context.scope.workspaceId])).rows[0];
  if ((current?.revision ?? 0) !== input.expectedRevision) return { ok: false as const, reason: 'purpose_revision_conflict' };
  await context.db.query(`INSERT INTO crm_extraction_purposes(workspace_id,revision,enabled,endpoint_id,model_version,
    access_grant_version,data_handling_version,daily_ceiling_cents,monthly_ceiling_cents,input_token_price_micros,output_token_price_micros,approved_by)
    VALUES($1,$2,false,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(workspace_id) DO UPDATE SET
    revision=EXCLUDED.revision,enabled=false,endpoint_id=EXCLUDED.endpoint_id,model_version=EXCLUDED.model_version,
    access_grant_version=EXCLUDED.access_grant_version,data_handling_version=EXCLUDED.data_handling_version,
    daily_ceiling_cents=EXCLUDED.daily_ceiling_cents,monthly_ceiling_cents=EXCLUDED.monthly_ceiling_cents,
    input_token_price_micros=EXCLUDED.input_token_price_micros,output_token_price_micros=EXCLUDED.output_token_price_micros,
    approved_by=EXCLUDED.approved_by,approved_at=now()`, [context.scope.workspaceId, input.expectedRevision + 1,
    input.endpointId,input.modelVersion,input.accessGrantVersion,input.dataHandlingVersion,input.dailyCeilingCents,
    input.monthlyCeilingCents,input.inputTokenPriceMicros,input.outputTokenPriceMicros,actor.userId]);
  return { ok: true as const, value: { revision: input.expectedRevision + 1, enabled: false } };
}

export async function readCrmProcessingHealth(context: RepositoryContext, input: { sourceId: string; kind: SourceLookup['kind'] }) {
  const { lockIdentityContext } = await import('./identityAccess.ts');
  if (input.kind !== 'selected_note' || !await lockIdentityContext(context, { sourceIds: [input.sourceId] })) return null;
  const source = (await context.db.query<{ revision: number; availability: string }>(
    'SELECT revision,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, input.sourceId])).rows[0];
  if (source === undefined) return null;
  const generations = (await context.db.query<Generation>(`SELECT id,purpose_revision,source_revision,processor_version,model_version,state,reason
    FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3
    ORDER BY observed_at DESC,id DESC LIMIT 51`, [context.scope.workspaceId,input.kind,input.sourceId])).rows;
  return { sourceId: input.sourceId, sourceRevision: source.revision, availability: source.availability,
    generations: generations.slice(0,50).map(dto), truncated: generations.length > 50 };
}
