import {readProcessingContext,parsedProcessingContext,sameProcessingContext,processingContextHash,NATIVE_PROCESSING_AUTHORIZATION_HASH} from './processingContext.ts';
import { enqueueJob } from '../jobs/jobStore.ts';
import type { QueryResultRowLike } from '../db/queryable.ts';
import type { RepositoryContext } from '../db/workspaceScope.ts';
import { resolveCrmSource, readNativeCrmSourceState, type SourceLookup } from './sourceResolver.ts';

const PROCESSOR_VERSION = 'crm-extract-v1';
export interface Generation extends QueryResultRowLike {
  id: string; purpose_revision: number; source_revision: number; processor_version: string; model_version: string | null;
  state: string; reason: string | null; source_kind: SourceLookup['kind']; source_id: string; source_hash: string; requested_by: string;context_snapshot:unknown;context_hash:string;authorization_hash:string;
}
function dto(row: Generation) {
  return { generationId: row.id, contextHash:row.context_hash,authorizationHash:row.authorization_hash,purposeRevision: row.purpose_revision, sourceRevision: row.source_revision, processorVersion: row.processor_version,
    modelVersion: row.model_version, state: row.state, reason: row.reason, claims: [] };
}
export async function readCrmProcessing(context: RepositoryContext, source: SourceLookup) {
  if (await resolveCrmSource(context, { ...source, locator: null }) === null) return null;
  const purpose = await readCrmExtractionPurpose(context);
  const liveContext=await readProcessingContext(context,source);if(liveContext===null)return null;
  const contextHash=processingContextHash(liveContext);
  const row = (await context.db.query<Generation>(`SELECT id,purpose_revision,source_revision,processor_version,model_version,state,reason,source_kind,source_id,source_hash,requested_by,context_snapshot,context_hash,authorization_hash
    FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 AND source_revision=$4
    AND source_hash=$5 AND processor_version=$6 AND purpose_revision=$7 AND context_hash=$8 AND authorization_hash=$9`,
  [context.scope.workspaceId, source.kind, source.sourceId, source.revision, source.contentHash, PROCESSOR_VERSION, purpose?.revision ?? 0,contextHash,NATIVE_PROCESSING_AUTHORIZATION_HASH])).rows[0];
  if(row===undefined)return {state:'not_requested',claims:[]};
  const claims=[];
  const originalContext=parsedProcessingContext(row.context_snapshot);
  const currentContext=row.state==='complete'?await readProcessingContext(context,source):null;
  if(row.state==='complete'&&(originalContext===null||currentContext===null||!sameProcessingContext(originalContext,currentContext)))return {...dto(row),state:'stale',reason:'source_context_changed',claims:[]};
  if(row.state==='complete')for(const claim of (await context.db.query<{id:string;kind:string;interpretation:string;status:string;locator:string;quote:string;claim_hash:string}>('SELECT id,kind,interpretation,status,locator,quote,claim_hash FROM crm_extraction_claims WHERE workspace_id=$1 AND generation_id=$2 ORDER BY id LIMIT 51',[context.scope.workspaceId,row.id])).rows){
    const evidence=await resolveCrmSource(context,{...source,locator:claim.locator});
    if(evidence?.passage?.text!==claim.quote)return {...dto(row),state:'stale',reason:'source_changed',claims:[]};
    claims.push({claimId:claim.id,claimRevision:1,claimHash:claim.claim_hash,context:currentContext,kind:claim.kind,interpretation:claim.interpretation,status:claim.status,quote:claim.quote,source:evidence.source});
  }
  const financial=(await context.db.query<{dispatch_state:string;settled_cents:number;settlement_state:string}>(`SELECT f.dispatch_state,p.settled_cents,p.state AS settlement_state FROM crm_extraction_financial_receipts f JOIN provider_reservations p ON p.workspace_id=f.workspace_id AND p.id=f.reservation_id WHERE f.workspace_id=$1 AND f.generation_id=$2`,[context.scope.workspaceId,row.id])).rows[0];
  return {...dto(row),claims,financial:financial===undefined?null:{dispatchState:financial.dispatch_state,settlementState:financial.settlement_state,settledCents:financial.settled_cents}};
}
export async function requestCrmProcessing(context: RepositoryContext, source: SourceLookup) {
  const actor = context.scope.actor;
  if (actor.kind !== 'user' || await resolveCrmSource(context, { ...source, locator: null }) === null)
    return { ok: false as const, reason: 'source_unavailable' };
  const purpose = await readCrmExtractionPurpose(context);
  const capturedContext=await readProcessingContext(context,source);if(capturedContext===null)return {ok:false as const,reason:'source_unavailable'};
  const contextHash=processingContextHash(capturedContext);
  await context.db.query("UPDATE crm_extraction_generations SET state='stale',reason='source_context_changed' WHERE workspace_id=$1 AND source_id=$2 AND source_kind=$3 AND source_revision=$4 AND source_hash=$5 AND processor_version=$6 AND purpose_revision=$7 AND context_hash<>$8 AND state NOT IN ('deleted','stale')",[context.scope.workspaceId,source.sourceId,source.kind,source.revision,source.contentHash,PROCESSOR_VERSION,purpose?.revision??0,contextHash]);
  const originalFirm=source.kind==='call_transcript'?(await context.db.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]?.firm_id:source.kind==='meeting_transcript'?(await context.db.query<{firm_id:string}>('SELECT m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]?.firm_id:null;
  const selectedOwner=source.kind==='selected_note'?(await context.db.query<{owner_user_id:string}>('SELECT owner_user_id FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]?.owner_user_id:null;
  const native=source.kind==='call_transcript'?(await context.db.query<{owner_user_id:string;meeting_id:null;recording_id:null}>('SELECT actor_user_id AS owner_user_id,NULL::uuid AS meeting_id,NULL::uuid AS recording_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]:source.kind==='meeting_transcript'?(await context.db.query<{owner_user_id:string|null;meeting_id:string;recording_id:string}>('SELECT r.crm_capture_owner_user_id AS owner_user_id,r.meeting_id,r.id AS recording_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id WHERE t.workspace_id=$1 AND t.id=$2',[context.scope.workspaceId,source.sourceId])).rows[0]:undefined;
  await context.db.query(`INSERT INTO crm_extraction_generations
    (workspace_id,source_id,source_kind,source_revision,source_hash,requested_by,processor_version,purpose_revision,model_version,state,reason,original_firm_id,context_hash,context_snapshot,authorization_hash,source_owner_user_id,original_meeting_id,original_recording_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'unavailable',$10,$11,$12,$13::jsonb,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
  [context.scope.workspaceId, source.sourceId, source.kind, source.revision, source.contentHash, actor.userId, PROCESSOR_VERSION, purpose?.revision ?? 0, purpose?.modelVersion ?? null, purpose?.unavailableReason ?? 'purpose_not_configured',(source.kind==='call_transcript'||source.kind==='meeting_transcript'?capturedContext.firmIds[0]:originalFirm)??null,contextHash,JSON.stringify(capturedContext),NATIVE_PROCESSING_AUTHORIZATION_HASH,selectedOwner??native?.owner_user_id??actor.userId,native?.meeting_id??null,native?.recording_id??null]);
  const value=await readCrmProcessing(context,source);
  if(value!==null&&'generationId' in value)await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.extract',idempotencyKey:`crm-extract:${value.generationId}`,payload:{generationId:value.generationId},maxAttempts:3});
  return { ok: true as const, value };
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
  if(input.kind==='selected_note'&&!await lockIdentityContext(context,{sourceIds:[input.sourceId]}))return null;
  const source=input.kind==='selected_note'?(await context.db.query<{ revision: number; availability: string }>(
    'SELECT revision,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',
    [context.scope.workspaceId, input.sourceId])).rows[0]:await readNativeCrmSourceState(context,input);
  if (source == null) return null;
  const generations = (await context.db.query<Generation>(`SELECT id,purpose_revision,source_revision,processor_version,model_version,state,reason,source_kind,source_id,source_hash,requested_by,context_snapshot,context_hash,authorization_hash
    FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3
    ORDER BY observed_at DESC,id DESC LIMIT 51`, [context.scope.workspaceId,input.kind,input.sourceId])).rows;
  const history=[];
  for(const generation of generations.slice(0,50)){
    const receipt=(await context.db.query<{dispatch_state:string;settled_cents:number;settlement_state:string}>(`SELECT f.dispatch_state,p.settled_cents,p.state AS settlement_state FROM crm_extraction_financial_receipts f JOIN provider_reservations p ON p.workspace_id=f.workspace_id AND p.id=f.reservation_id WHERE f.workspace_id=$1 AND f.generation_id=$2`,[context.scope.workspaceId,generation.id])).rows[0];
    history.push({...dto(generation),financial:receipt===undefined?null:{dispatchState:receipt.dispatch_state,settlementState:receipt.settlement_state,settledCents:receipt.settled_cents}});
  }
  const unknownAcceptance=(await context.db.query(`SELECT 1 FROM crm_extraction_financial_receipts f JOIN crm_extraction_generations g ON g.workspace_id=f.workspace_id AND g.id=f.generation_id WHERE g.workspace_id=$1 AND g.source_id=$2 AND g.source_kind=$3 AND f.dispatch_state IN ('calling','unknown_acceptance') LIMIT 1`,[context.scope.workspaceId,input.sourceId,input.kind])).rows.length>0;
  return { sourceId: input.sourceId, sourceRevision: source.revision, availability: source.availability,
    generations: history, truncated: generations.length > 50,unknownAcceptance };
}

/** Record health contains no transcript and does not depend on a live transcript row. */
export async function readCrmProcessingRecord(context:RepositoryContext,input:{kind:'call_session'|'meeting';recordId:string}){
 const {activeIdentityActor}=await import('./identityAccess.ts');const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const sources=(await context.db.query<{source_id:string;source_kind:SourceLookup['kind']}>('SELECT source_id,source_kind FROM crm_extraction_generations WHERE workspace_id=$1 AND (($2=\'meeting\' AND original_meeting_id=$3) OR ($2=\'call_session\' AND source_kind=\'call_transcript\' AND source_id=$3)) AND ($4 OR coalesce(source_owner_user_id,requested_by)=$5) GROUP BY source_id,source_kind ORDER BY source_id,source_kind LIMIT 51',[context.scope.workspaceId,input.kind,input.recordId,actor.role==='admin',actor.userId])).rows;
 const output=[];for(const source of sources.slice(0,50)){const health=await readCrmProcessingHealth(context,{kind:source.source_kind,sourceId:source.source_id});if(health!==null)output.push(health);}
 return {sources:output,truncated:sources.length>50};
}
