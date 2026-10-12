import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {askAgentScopeSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema,type AskAgentScope,type CanonicalSourceReference} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {discoverAskHistorySources,copiedAskSource} from './askHistoryInvestigation.ts';
import {readAskCanonicalCorpus} from './askCorpus.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {readProcessingContext,processingContextHash} from './processingContext.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {askFingerprint,readAskPurpose} from './askAnswerAuthority.ts';
import type {AskAdapterRoute,AskPurposeSnapshot,AskPurposeProofInput} from './askAnswerPorts.ts';
import {lockAskLifecycle} from './askAnswerLifecycle.ts';
import {enqueueJob} from '../jobs/jobStore.ts';
import {rankCanonicalVectors} from './askVectorDistance.ts';
const mail=createNativeCrmMailEvidence();
const reviewPermitted=(scope:AskAgentScope,review:string)=>review==='current'||scope.kind==='business'||scope.kind==='selected';
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
export async function indexOriginal(context:RepositoryContext,source:CanonicalSourceReference){
 const lookup=copiedAskSource(source);const corpus=await readAskCanonicalCorpus(context,{scope:{sources:[lookup]}});if(!corpus)return null;
 const snapshot=await readProcessingContext(context,lookup,mail);let closure=await originalSourceAccessClosure(context,lookup);
 if(!closure&&snapshot&&(source.kind==='call_transcript'||source.kind==='meeting_transcript')&&(await context.db.query('SELECT 1 FROM crm_extraction_generations WHERE workspace_id=$1 AND source_kind=$2 AND source_id=$3 LIMIT 1',[context.scope.workspaceId,source.kind,source.sourceId])).rows.length===0)closure={firmIds:snapshot.firmIds,personIds:[]};
 if(!snapshot||!closure||!await lockConflictSources(context,[lookup],[snapshot],[closure]))return null;
 return {source,windows:corpus.windows,context:snapshot,closure,partial:!corpus.coverage.scanComplete||corpus.coverage.truncatedSources>0};
}
export async function requestAskIndex(context:RepositoryContext,input:{scope:AskAgentScope;expectedPurposeRevision:number;after?:{kind:CanonicalSourceReference['kind'];sourceId:string}|undefined}):Promise<{ok:false;reason:string}|{ok:true;value:{state:'pending'|'complete'|'unavailable';reason:string|null;workId:string|null}}>{
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context)||!askAgentScopeSchema.safeParse(input.scope).success)return {ok:false as const,reason:'source_unavailable'};
 await lockAskLifecycle(context);
 const purpose=await readAskPurpose(context,'embedding');
 if(!purpose||purpose.revision!==input.expectedPurposeRevision||!purpose.embeddingDimensions)return {ok:true as const,value:{state:'unavailable' as const,reason:'purpose_unavailable',workId:null}};
 const discovery=await discoverAskHistorySources(context,input.scope,{...input.after?{after:input.after}:{},candidateCeiling:100});if(!discovery)return {ok:false as const,reason:'source_unavailable'};
 const sources=discovery.sources.slice(0,100);const originals=[];
 for(const source of sources){const original=await indexOriginal(context,source);if(!original)return {ok:false as const,reason:'source_unavailable'};if(!reviewPermitted(input.scope,original.context.review))return {ok:true as const,value:{state:'unavailable',reason:'identity_clarification_required',workId:null}};originals.push(original);}
 const closure={firmIds:[...new Set(originals.flatMap(row=>row.closure.firmIds))].sort(),personIds:[...new Set(originals.flatMap(row=>row.closure.personIds))].sort()};
 const row=(await context.db.query<{id:string}>(`INSERT INTO crm_ask_index_work(workspace_id,owner_user_id,scope,source_scope,context_snapshot,original_access_closure,purpose_snapshot,purpose_revision,state,scan_partial) VALUES($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,'pending',$9) RETURNING id`,[context.scope.workspaceId,actor.userId,JSON.stringify(input.scope),JSON.stringify({sources,nextAfter:discovery.nextAfter}),JSON.stringify(originals.map(row=>row.context)),JSON.stringify(closure),JSON.stringify(purpose),purpose.revision,discovery.partial||sources.length<discovery.sources.length||originals.some(row=>row.partial)])).rows[0]!;
 let ordinal=0,partial=discovery.partial;
 for(const original of originals)for(const window of original.windows){if(ordinal>=1000){partial=true;break;}ordinal++;
 await context.db.query(`INSERT INTO crm_ask_canonical_windows(workspace_id,owner_user_id,work_id,source_kind,source_id,source_revision,source_hash,locator,text_hash,context_hash,context_snapshot,original_access_closure,chunker_version,purpose_revision,model_version,dimensions,config_fingerprint,ordinal) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16,$17,$18)`,[context.scope.workspaceId,actor.userId,row.id,original.source.kind,original.source.sourceId,original.source.revision,original.source.contentHash,window.locator,hash(window.text),processingContextHash(original.context),JSON.stringify(original.context),JSON.stringify(original.closure),purpose.chunkerVersion,purpose.revision,purpose.modelVersion,purpose.embeddingDimensions,askFingerprint({purpose}),ordinal]);
 }
 await context.db.query('UPDATE crm_ask_index_work SET total_windows=$3,scan_partial=scan_partial OR $4,state=CASE WHEN $3=0 THEN \'complete\' ELSE state END WHERE workspace_id=$1 AND id=$2',[context.scope.workspaceId,row.id,ordinal,partial]);
 if(ordinal)await enqueueJob(context.db,{workspaceId:context.scope.workspaceId,kind:'crm.ask_index',idempotencyKey:`ask-index:${row.id}:1`,payload:{workId:row.id,revision:1},maxAttempts:3});
 return {ok:true as const,value:{state:ordinal?'pending' as const:'complete' as const,reason:null,workId:row.id}};
}
export async function readAskIndex(context:RepositoryContext,workId:string){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 await lockAskLifecycle(context);
 const row=(await context.db.query<Record<string,unknown>>('SELECT * FROM crm_ask_index_work WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3',[context.scope.workspaceId,workId,actor.userId])).rows[0];if(!row)return null;
 if(!['stale','deleted'].includes(String(row['state']))){
  const scope=row['source_scope'] as {sources:CanonicalSourceReference[]};const expected=crmClaimContextSchema.array().safeParse(row['context_snapshot']);let valid=expected.success;
  for(const [offset,source] of scope.sources.entries()){const original=await indexOriginal(context,source);const before=expected.success?expected.data[offset]:null;if(!original||!before||!reviewPermitted(askAgentScopeSchema.parse(row['scope']),original.context.review)||processingContextHash(original.context)!==processingContextHash(before)){valid=false;break;}}
  if(!valid){await context.db.query("UPDATE crm_ask_canonical_windows SET state='stale',embedding=NULL,context_snapshot=NULL,original_access_closure=NULL WHERE workspace_id=$1 AND work_id=$2 AND state IN ('pending','current')",[context.scope.workspaceId,workId]);await context.db.query("UPDATE crm_ask_index_work SET state='stale',scope=NULL,source_scope=NULL,context_snapshot=NULL,original_access_closure=NULL,reason='source_unavailable',revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND state NOT IN ('stale','deleted')",[context.scope.workspaceId,workId]);row['state']='stale';row['reason']='source_unavailable';row['revision']=Number(row['revision'])+1;row['source_scope']=null;}
 }
 const counts=(await context.db.query<{current:string;stale:string}>(`SELECT count(*) FILTER(WHERE state='current')::text current,count(*) FILTER(WHERE state IN ('stale','deleted'))::text stale FROM crm_ask_canonical_windows WHERE workspace_id=$1 AND work_id=$2`,[context.scope.workspaceId,workId])).rows[0]!;
 return {workId,revision:Number(row['revision']),state:row['state'],reason:row['reason'],indexedWindows:Number(counts.current),totalWindows:Number(row['total_windows']),staleWindows:Number(counts.stale),partial:row['scan_partial']===true,nextAfter:row['source_scope']===null?null:(row['source_scope'] as {nextAfter?:unknown}).nextAfter??null};
}
export async function readCurrentIndexWindow(context:RepositoryContext,workId:string,revision:number,route:AskAdapterRoute){
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const work=(await context.db.query<Record<string,unknown>>(`SELECT * FROM crm_ask_index_work WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND revision=$4 AND state='pending'`,[context.scope.workspaceId,workId,actor.userId,revision])).rows[0];if(!work)return null;
 const frozenSources=work['source_scope'] as {sources:CanonicalSourceReference[]};const frozenContexts=crmClaimContextSchema.array().safeParse(work['context_snapshot']);if(!frozenContexts.success||frozenContexts.data.length!==frozenSources.sources.length)return null;
 for(const [offset,ref] of frozenSources.sources.entries()){const original=await indexOriginal(context,ref);if(!original||processingContextHash(original.context)!==processingContextHash(frozenContexts.data[offset]!)||!reviewPermitted(askAgentScopeSchema.parse(work['scope']),original.context.review))return null;}
 const purpose=await readAskPurpose(context,'embedding');if(!purpose||!isDeepStrictEqual(purpose,work['purpose_snapshot'])||purpose.endpointId!==route.endpointId||purpose.modelVersion!==route.modelVersion||!purpose.embeddingDimensions)return null;
 const window=(await context.db.query<Record<string,unknown>>(`SELECT * FROM crm_ask_canonical_windows WHERE workspace_id=$1 AND work_id=$2 AND ordinal=$3 AND state='pending'`,[context.scope.workspaceId,workId,work['next_ordinal']])).rows[0];if(!window)return null;
 const source={workspaceId:context.scope.workspaceId,kind:window['source_kind'],sourceId:window['source_id'],revision:window['source_revision'],contentHash:window['source_hash'],locator:window['locator']} as Parameters<typeof resolveCrmSource>[1];
 const resolved=await resolveCrmSource(context,source,mail);const snapshot=await readProcessingContext(context,source,mail);const stored=crmClaimContextSchema.safeParse(window['context_snapshot']);const closure=crmOriginalAccessClosureSchema.safeParse(window['original_access_closure']);
 if(!resolved?.passage||hash(resolved.passage.text)!==window['text_hash']||!snapshot||!stored.success||!closure.success||processingContextHash(snapshot)!==window['context_hash']||!reviewPermitted(askAgentScopeSchema.parse(work['scope']),snapshot.review)||!await lockConflictSources(context,[source],[stored.data],[closure.data]))return null;
 const lockedWork=(await context.db.query("SELECT id FROM crm_ask_index_work WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 AND revision=$4 AND next_ordinal=$5 AND state='pending' FOR UPDATE",[context.scope.workspaceId,workId,actor.userId,revision,window['ordinal']])).rows.length===1;
 if(!lockedWork||(await context.db.query("SELECT id FROM crm_ask_canonical_windows WHERE workspace_id=$1 AND id=$2 AND work_id=$3 AND state='pending' FOR UPDATE",[context.scope.workspaceId,window['id'],workId])).rows.length!==1)return null;
 const configFingerprint=askFingerprint({purpose,route}),inputScopeFingerprint=askFingerprint(work['source_scope']),contextFingerprint=askFingerprint(work['context_snapshot']),initialAccessFingerprint=askFingerprint(work['original_access_closure']);
 const target={kind:'canonical_index' as const,workId,revision,windowId:String(window['id'])};
 const authorizationFingerprint=askFingerprint({workspaceId:context.scope.workspaceId,ownerUserId:actor.userId,inputScopeFingerprint,contextFingerprint,initialAccessFingerprint,target});
 const proofInput:AskPurposeProofInput={target,stage:'embedding_document',route,purpose,configFingerprint,authorizationFingerprint,workspaceId:context.scope.workspaceId,ownerUserId:actor.userId,inputScopeFingerprint,contextFingerprint,initialAccessFingerprint};
 return {windowId:String(window['id']),ordinal:Number(window['ordinal']),text:resolved.passage.text,purpose,proofInput,inputHash:askFingerprint({source,textHash:window['text_hash'],contextHash:window['context_hash'],configFingerprint,authorizationFingerprint})};
}
/** Current body-free authority for independent indexing; never invokes a provider or verifier. */
export async function readCurrentCanonicalIndexAuthority(context:RepositoryContext,target:{kind:'canonical_index';workId:string;revision:number;windowId:string},route:AskAdapterRoute){
 const status=await readAskIndex(context,target.workId);if(!status||status.state!=='pending'||status.revision!==target.revision)return null;
 const current=await readCurrentIndexWindow(context,target.workId,target.revision,route);if(!current||current.windowId!==target.windowId)return null;
 const row=(await context.db.query<{source_scope:{sources:CanonicalSourceReference[]}}>('SELECT source_scope FROM crm_ask_index_work WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND state=\'pending\'',[context.scope.workspaceId,target.workId,target.revision])).rows[0];if(!row)return null;
 return {proofInput:current.proofInput,sources:row.source_scope.sources.map(source=>({kind:source.kind,sourceId:source.sourceId}))};
}
/** Numeric ranking is private and transient; only current authorized originals are rehydrated. */
export async function searchCanonicalIndex(context:RepositoryContext,input:{eligibleSources:readonly CanonicalSourceReference[];queryVector:readonly number[];purpose:AskPurposeSnapshot;route:AskAdapterRoute;limit:number}){
 const actor=context.scope.actor;const empty={windows:[],coverage:{state:'unavailable' as const,eligibleSourceCount:input.eligibleSources.length,indexedSourceCount:0,staleCount:0}};
 if(actor.kind!=='user'||!await activeIdentityActor(context)||!Number.isInteger(input.limit)||input.limit<1||input.limit>20||!input.purpose.embeddingDimensions||input.queryVector.length!==input.purpose.embeddingDimensions||input.queryVector.some(value=>!Number.isFinite(value))||input.queryVector.every(value=>value===0)||!Number.isFinite(input.queryVector.reduce((sum,value)=>sum+value*value,0)))return empty;
 const purpose=await readAskPurpose(context,'embedding');if(!purpose||!isDeepStrictEqual(purpose,input.purpose))return empty;
 const eligible=input.eligibleSources.slice(0,1000);const {rows}=await rankCanonicalVectors(context.db,{workspaceId:context.scope.workspaceId,ownerUserId:actor.userId,configFingerprint:askFingerprint({purpose,route:input.route}),queryVector:input.queryVector,eligibleSources:eligible});
 const windows:{source:CanonicalSourceReference;locator:string;text:string;score:number}[]=[];const indexed=new Set<string>();let staleCount=0;
 for(const row of rows){const source=eligible.find(source=>source.kind===row['source_kind']&&source.sourceId===row['source_id']);if(!source)continue;const original=await indexOriginal(context,source);const window=original?.windows.find(window=>window.locator===row['locator']);
 if(!window||hash(window.text)!==row['text_hash']||processingContextHash(original!.context)!==row['context_hash']||!isDeepStrictEqual(original!.closure,row['original_access_closure'])){staleCount++;continue;}
 indexed.add(`${source.kind}:${source.sourceId}`);if(windows.length<input.limit&&!windows.some(item=>item.source.sourceId===source.sourceId&&item.locator===window.locator))windows.push({source,locator:window.locator,text:window.text,score:Number(row['score'])||0});
 }
 return {windows,coverage:{state:indexed.size===input.eligibleSources.length&&staleCount===0?'complete' as const:indexed.size?'partial' as const:'unavailable' as const,eligibleSourceCount:input.eligibleSources.length,indexedSourceCount:indexed.size,staleCount}};
}
