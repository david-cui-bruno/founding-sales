import {isDeepStrictEqual} from 'node:util';
import {resolveAskAgentScope} from './askAgentScope.ts';
import {askAgentScopeSchema,askAnswerRequestPayloadSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type AskAgentScope} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor,lockIdentityContext} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {readProcessingContext} from './processingContext.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {askFingerprint} from './askAnswerAuthority.ts';
import {readAskRecords} from './askRecords.ts';
const mail=createNativeCrmMailEvidence();
type Source=ReturnType<typeof askAnswerRequestPayloadSchema.parse>['scope']['sources'][number];
export interface AskExecutionKey {requestId:string;version:number;epoch:number}
async function parent(context:RepositoryContext,key:AskExecutionKey,pending=false,lock=false){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const row=(await context.db.query<Record<string,unknown>>(`SELECT * FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND version=$4 AND epoch=$5${lock?' FOR UPDATE':''}`,[context.scope.workspaceId,key.requestId,actor.userId,key.version,key.epoch])).rows[0];
 if(!row||row['question']===null||['stale','deleted'].includes(String(row['state']))||pending&&(row['state']!=='pending'||row['cancelled_at']!==null))return null;
 const input=askAnswerRequestPayloadSchema.safeParse({question:row['question'],scope:row['scope'],execution:row['execution_version']});const contexts=crmClaimContextSchema.array().max(10).safeParse(row['initial_contexts']);const closure=crmOriginalAccessClosureSchema.safeParse(row['initial_access_closure']);const parsed=askAgentScopeSchema.safeParse(row['original_agent_scope']);
 if(!input.success||!contexts.success||!closure.success||contexts.data.length!==input.data.scope.sources.length||row['original_agent_scope']!==null&&!parsed.success)return null;
 return {row,scope:input.data.scope,contexts:contexts.data,closure:closure.data,intent:parsed.success?parsed.data:null};
}
function within(intent:AskAgentScope|null,source:Source,current:ReturnType<typeof crmClaimContextSchema.parse>,at:string|null){
 if(!intent)return false;
 if(intent.from!==undefined&&(at===null||Date.parse(at)<Date.parse(intent.from)))return false;
 if(intent.to!==undefined&&(at===null||Date.parse(at)>=Date.parse(intent.to)))return false;
 if(intent.kind==='firm')return current.firmIds.includes(intent.firmId);
 if(intent.kind==='person')return current.personId===intent.personId;
 return intent.kind==='business'||intent.sources.some(ref=>ref.kind===source.kind&&ref.sourceId===source.sourceId&&ref.revision===source.revision&&ref.contentHash===source.contentHash);
}
/** Append-only canonical evidence, admitted only between fenced model steps. */
export async function admitAskSources(context:RepositoryContext,key:AskExecutionKey,sources:readonly Source[]){
 const initial=await parent(context,key,true);if(!initial||initial.row['execution_version']!=='agent_v1')return false;
 const prepared: {source:Source;current:ReturnType<typeof crmClaimContextSchema.parse>;closure:ReturnType<typeof crmOriginalAccessClosureSchema.parse>}[]=[];
 // Original source and identity locks precede the request lock, matching source invalidation.
 for(const source of [...new Map(sources.map(s=>[`${s.kind}:${s.sourceId}`,s])).values()]){
  if(source.workspaceId!==context.scope.workspaceId)return false;
  const resolved=await resolveCrmSource(context,source,mail),current=await readProcessingContext(context,source,mail);if(!resolved||!current||!within(initial.intent,source,current,resolved.source.occurredAt))return false;
  let closure=await originalSourceAccessClosure(context,source);
  if(!closure&&(source.kind==='call_transcript'||source.kind==='meeting_transcript')){const prior=await context.db.query('SELECT id FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 LIMIT 1',[context.scope.workspaceId,source.kind,source.sourceId]);if(prior.rows.length===0&&current.firmIds.length>0)closure={firmIds:current.firmIds,personIds:current.personId?[current.personId]:[]};}
  if(!closure||!await lockConflictSources(context,[source],[current],[closure]))return false;
  const verified=await readProcessingContext(context,source,mail);if(!isDeepStrictEqual(verified,current)||!await resolveCrmSource(context,source,mail))return false;
  prepared.push({source,current,closure});
 }
 const fenced=await parent(context,key,true,true);if(!fenced||!isDeepStrictEqual(fenced.intent,initial.intent))return false;
 const existing=(await context.db.query<{source_kind:string;source_id:string}>('SELECT source_kind,source_id FROM crm_ask_admitted_sources WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4',[context.scope.workspaceId,key.requestId,key.version,key.epoch])).rows;
 const known=new Set([...initial.scope.sources.map(s=>`${s.kind}:${s.sourceId}`),...existing.map(s=>`${s.source_kind}:${s.source_id}`)]);
 const fresh=prepared.filter(({source})=>!known.has(`${source.kind}:${source.sourceId}`));if(known.size+fresh.length>10)return false;
 for(const {source,current,closure}of fresh){
  await context.db.query('INSERT INTO crm_ask_admitted_sources(workspace_id,request_id,request_version,request_epoch,source_kind,source_id,source_revision,source_hash,context_snapshot,original_access_closure,admission_ordinal) SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,coalesce(max(admission_ordinal),0)+1 FROM crm_ask_admitted_sources WHERE workspace_id=$1 AND request_id=$2 ON CONFLICT DO NOTHING',[context.scope.workspaceId,key.requestId,key.version,key.epoch,source.kind,source.sourceId,source.revision,source.contentHash,JSON.stringify(current),JSON.stringify(closure)]);
 }
 return true;
}
async function recordProof(context:RepositoryContext,intent:AskAgentScope|null,record:{kind:'firm'|'person';recordId:string}){
 const selected=intent?.kind==='selected'?await resolveAskAgentScope(context,intent):null;
 const restriction=intent?.kind==='selected'?selected===null?null:{firmIds:selected.firmIds,personIds:selected.personIds}:intent?.kind==='firm'?{firmIds:[intent.firmId]}:intent?.kind==='person'?{personIds:[intent.personId]}:undefined;
 if(restriction===null)return null;
 const page=await readAskRecords(context,{operation:'records',kind:record.kind==='firm'?'firms':'people',limit:1,query:''},{...restriction,recordId:record.recordId});
 return page?.records.find(item=>item.recordId===record.recordId)??null;
}
export async function admitAskRecord(context:RepositoryContext,key:AskExecutionKey,record:{kind:'firm'|'person';recordId:string},expectedSnapshot?:unknown){
 const initial=await parent(context,key,true);if(!initial)return false;const proof=await recordProof(context,initial.intent,record);if(!proof||expectedSnapshot!==undefined&&!isDeepStrictEqual(proof,expectedSnapshot))return false;
 const fenced=await parent(context,key,true,true);if(!fenced||!isDeepStrictEqual(fenced.intent,initial.intent))return false;
 const existing=(await context.db.query<{record_snapshot:unknown}>('SELECT record_snapshot FROM crm_ask_admitted_records WHERE workspace_id=$1 AND request_id=$2 AND record_kind=$3 AND record_id=$4',[context.scope.workspaceId,key.requestId,record.kind,record.recordId])).rows[0];if(existing)return isDeepStrictEqual(existing.record_snapshot,proof);
 const count=(await context.db.query<{count:string}>('SELECT count(*)::text AS count FROM crm_ask_admitted_records WHERE workspace_id=$1 AND request_id=$2',[context.scope.workspaceId,key.requestId])).rows[0];if(Number(count?.count)>=100)return false;
 await context.db.query('INSERT INTO crm_ask_admitted_records(workspace_id,request_id,request_version,request_epoch,record_kind,record_id,record_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[context.scope.workspaceId,key.requestId,key.version,key.epoch,record.kind,record.recordId,JSON.stringify(proof)]);return true;
}
/** Every reuse checks original source closure, live context and canonical identity again. */
export async function readAskExecutionEvidence(context:RepositoryContext,key:AskExecutionKey){
 const initial=await parent(context,key);if(!initial)return null;
 const invalid=(await context.db.query(`SELECT 1 FROM crm_ask_history_dependencies d JOIN crm_ask_requests p ON p.workspace_id=d.workspace_id AND p.id=d.parent_request_id WHERE d.workspace_id=$1 AND d.request_id=$2 AND (p.state<>'complete' OR p.question IS NULL OR p.version<>d.parent_version OR p.epoch<>d.parent_epoch) LIMIT 1`,[context.scope.workspaceId,key.requestId])).rows;if(invalid.length>0)return null;
 const rows=(await context.db.query<Record<string,unknown>>('SELECT * FROM crm_ask_admitted_sources WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 ORDER BY admission_ordinal',[context.scope.workspaceId,key.requestId,key.version,key.epoch])).rows;
 const sources=[...initial.scope.sources],contexts=[...initial.contexts],closures=initial.scope.sources.map(()=>initial.closure);
 for(const row of rows){const source=askAnswerRequestPayloadSchema.shape.scope.shape.sources.element.parse({workspaceId:context.scope.workspaceId,kind:row['source_kind'],sourceId:row['source_id'],revision:row['source_revision'],contentHash:row['source_hash'],locator:null});sources.push(source);contexts.push(crmClaimContextSchema.parse(row['context_snapshot']));closures.push(crmOriginalAccessClosureSchema.parse(row['original_access_closure']));}
 if(sources.length>10||!await lockConflictSources(context,sources,contexts,[initial.closure,...closures]))return null;
 for(const [index,source]of sources.entries()){const current=await readProcessingContext(context,source,mail);if(JSON.stringify(current)!==JSON.stringify(contexts[index])||!await resolveCrmSource(context,source,mail))return null;}
 const records=(await context.db.query<{record_kind:'firm'|'person';record_id:string;record_snapshot:unknown}>('SELECT record_kind,record_id,record_snapshot FROM crm_ask_admitted_records WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 ORDER BY record_kind,record_id',[context.scope.workspaceId,key.requestId,key.version,key.epoch])).rows;
 for(const record of records){if(!isDeepStrictEqual(await recordProof(context,initial.intent,{kind:record.record_kind,recordId:record.record_id}),record.record_snapshot))return null;}
 const closure={firmIds:[...new Set([...initial.closure.firmIds,...closures.flatMap(c=>c.firmIds),...records.filter(r=>r.record_kind==='firm').map(r=>r.record_id)])].sort(),personIds:[...new Set([...initial.closure.personIds,...closures.flatMap(c=>c.personIds),...records.filter(r=>r.record_kind==='person').map(r=>r.record_id)])].sort()};
 if(!await lockIdentityContext(context,closure))return null;
 // After locking original evidence, fence the parent and verify the append-only ledger did not grow during this read.
 const fenced=await parent(context,key,false,true);if(!fenced||!isDeepStrictEqual(fenced.scope,initial.scope)||!isDeepStrictEqual(fenced.contexts,initial.contexts)||!isDeepStrictEqual(fenced.closure,initial.closure)||!isDeepStrictEqual(fenced.intent,initial.intent))return null;
 const finalSources=(await context.db.query<Record<string,unknown>>('SELECT * FROM crm_ask_admitted_sources WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 ORDER BY admission_ordinal',[context.scope.workspaceId,key.requestId,key.version,key.epoch])).rows;
 const finalRecords=(await context.db.query<{record_kind:'firm'|'person';record_id:string;record_snapshot:unknown}>('SELECT record_kind,record_id,record_snapshot FROM crm_ask_admitted_records WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 ORDER BY record_kind,record_id',[context.scope.workspaceId,key.requestId,key.version,key.epoch])).rows;
 if(!isDeepStrictEqual(rows,finalSources)||!isDeepStrictEqual(records,finalRecords))return null;
 return {scope:{sources},contexts,closure,sourceClosures:closures,records:records.map(r=>r.record_snapshot),intent:initial.intent,fingerprint:askFingerprint({scope:{sources},contexts,closure,records}),baseFingerprint:askFingerprint({scope:initial.scope,contexts:initial.contexts,closure:initial.closure,intent:initial.intent})};
}
