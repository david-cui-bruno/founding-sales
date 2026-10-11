import {readAskConversationAttribution} from './askHistoryInvestigation.ts';
import {readAskExecutionEvidence} from './askExecutionEvidence.ts';
import {askToolFirmIds} from './askAgentScope.ts';
import {askAgentScopeSchema} from '@fss/contracts';
import {readAskSessionContext} from './askSessionContext.ts';
import {createHash} from 'node:crypto';
import {askExplicitCorpusScopeSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readAskInputConflicts} from './askAnswerConflicts.ts';
import {readAskAnswer} from './askAnswers.ts';
import {readAskCanonicalCorpus} from './askCorpus.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
import {processingContextHash} from './processingContext.ts';
import {askFingerprint,readAskPurpose} from './askAnswerAuthority.ts';
import type {AskInputWindow,AskInputGroup,AskPurposeProofInput,AskAdapterRoute} from './askAnswerPorts.ts';
const copiedMail=createNativeCrmMailEvidence();
const textHash=(text:string)=>createHash('sha256').update(text).digest('hex');
export const askGroupHash=(text:string)=>textHash(text.trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US'));
/** Complete current inputs, assembled from originals, never recovered from saved answer prose. */
export async function readCurrentAskInput(context:RepositoryContext,requestId:string,version:number,epoch:number,route:AskAdapterRoute){
 const read=await readAskAnswer(context,requestId);
 if(read===null||read.state!=='pending'||read.question===null||read.reason==='source_unavailable'||read.version!==version)return null;
 const row=(await context.db.query<Record<string,unknown>>('SELECT * FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2 AND version=$3 AND epoch=$4 FOR UPDATE',[context.scope.workspaceId,requestId,version,epoch])).rows[0];
 if(row===undefined||row['state']!=='pending')return null;
 const evidence=await readAskExecutionEvidence(context,{requestId,version,epoch});if(!evidence)return null;
 const scope=evidence.scope,contexts=evidence.contexts,access=evidence.closure;
 const evidenceFingerprint=evidence.fingerprint;
 const target={kind:'request' as const,requestId,version,epoch};
 let attributionFingerprint=askFingerprint([]);
 const baseInputHash=askFingerprint({question:read.question,base:evidence.baseFingerprint});
 const agentScope=evidence.intent;
 const scopeDescriptor={intent:agentScope,records:evidence.records,sourceCount:scope.sources.length,sourceContexts:scope.sources.map((source,index)=>({kind:source.kind,sourceId:source.sourceId,...contexts[index]}))};
 const identityUnresolved=contexts.some(value=>value.review!=='current'||value.personId===null&&value.firmIds.length===0);
 const intent=askAgentScopeSchema.safeParse(row['original_agent_scope']);
 if(row['original_agent_scope']!==null&&row['original_agent_scope']!==undefined&&!intent.success)return null;
 const toolFirmIds=askToolFirmIds(intent.success?intent.data:null,access.firmIds);
 const history=await readAskSessionContext(context,requestId,scope);
 const purpose=await readAskPurpose(context,'answer');
 if(purpose===null||purpose.revision!==row['purpose_revision']||purpose.evaluationFingerprint!==row['evaluation_fingerprint'])return null;
 if(scope.sources.length===0){
  const configFingerprint=askFingerprint({purpose,route}),inputScopeFingerprint=askFingerprint(scope),contextFingerprint=askFingerprint(contexts),initialAccessFingerprint=askFingerprint(access);
  const authorizationFingerprint=askFingerprint({target,workspaceId:context.scope.workspaceId,ownerUserId:row['owner_user_id'],inputScopeFingerprint,contextFingerprint,initialAccessFingerprint,evidenceFingerprint,attributionFingerprint,agentScope});
  const proofInput:AskPurposeProofInput={stage:'answer',route:structuredClone(route),purpose,configFingerprint,authorizationFingerprint,workspaceId:context.scope.workspaceId,ownerUserId:String(row['owner_user_id']),inputScopeFingerprint,contextFingerprint,initialAccessFingerprint,target,evidenceFingerprint,attributionFingerprint,agentScope};
  return {scope,agentScope,scopeDescriptor,baseInputHash,evidenceFingerprint,toolFirmIds,identityUnresolved,identityAmbiguous:agentScope!==null&&['firm','person'].includes(agentScope.kind)&&identityUnresolved,history:history.turns,executionVersion:row['execution_version'],question:read.question,windows:[] as AskInputWindow[],groups:[] as AskInputGroup[],proofInput,inputHash:askFingerprint({toolFirmIds,question:read.question,scope,historyFingerprint:history.fingerprint,configFingerprint,authorizationFingerprint}),coverage:{scanComplete:true,acquisition:'unverified'},conflicts:[],inputBoundReached:false,retrievalPartial:true};
 }
 const census=await readAskCanonicalCorpus(context,{scope:askExplicitCorpusScopeSchema.parse(scope)});
 if(census===null||census.coverage.refusedSources>0||census.windows.length===0)return null;
 let originalsComplete=true;const originalSources=[];
 for(const source of scope.sources){const original=await resolveCrmSource(context,source,copiedMail);if(original===null)return null;if(original.source.completeness!=='complete')originalsComplete=false;originalSources.push(original.source);}
 const attribution=await readAskConversationAttribution(context,originalSources);if(attribution===null)return null;attributionFingerprint=askFingerprint(attribution);
 const windows:AskInputWindow[]=[];
 for(const window of census.windows){
  const resolved=await resolveCrmSource(context,{...window.source,locator:window.locator},copiedMail);
  if(resolved===null||resolved.passage?.text!==window.text||resolved.source.contentHash===null)return null;
  const contextIndex=scope.sources.findIndex(source=>source.sourceId===window.source.sourceId&&source.kind===window.source.kind);
  const snapshot=contexts[contextIndex];if(snapshot===undefined)return null;
  const existing=(await context.db.query<{ordinal:number}>('SELECT ordinal FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 AND source_kind=$5 AND source_id=$6 AND locator=$7',[context.scope.workspaceId,requestId,version,epoch,window.source.kind,window.source.sourceId,window.locator])).rows[0];
  const ordinal=existing?.ordinal??Number((await context.db.query<{ordinal:number}>('SELECT coalesce(max(ordinal),0)+1 AS ordinal FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4',[context.scope.workspaceId,requestId,version,epoch])).rows[0]!.ordinal);
  const hash=textHash(window.text),groupHash=askGroupHash(window.text);
  await context.db.query(`INSERT INTO crm_ask_request_windows(workspace_id,request_id,request_version,request_epoch,ordinal,source_kind,source_id,source_revision,source_hash,locator,context_hash,text_hash,group_hash,context_snapshot,original_access_closure) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb) ON CONFLICT(workspace_id,request_id,request_version,request_epoch,ordinal) DO NOTHING`,[context.scope.workspaceId,requestId,version,epoch,ordinal,resolved.source.kind,resolved.source.sourceId,resolved.source.revision,resolved.source.contentHash,window.locator,processingContextHash(snapshot),hash,groupHash,JSON.stringify(snapshot),JSON.stringify(evidence.sourceClosures[contextIndex])]);
  const stored=(await context.db.query<{id:string;source_id:string;source_revision:number;source_hash:string;locator:string;text_hash:string;group_hash:string}>('SELECT * FROM crm_ask_request_windows WHERE workspace_id=$1 AND request_id=$2 AND request_version=$3 AND request_epoch=$4 AND ordinal=$5',[context.scope.workspaceId,requestId,version,epoch,ordinal])).rows[0];
  if(stored===undefined||stored.source_id!==resolved.source.sourceId||stored.source_revision!==resolved.source.revision||stored.source_hash!==resolved.source.contentHash||stored.locator!==window.locator||stored.text_hash!==hash||stored.group_hash!==groupHash)return null;
  windows.push({id:stored.id,ordinal,source:resolved.source,text:window.text,textHash:hash});
 }
 const grouped=new Map<string,AskInputGroup>();
 for(const window of windows){const id=askGroupHash(window.text);const previous=grouped.get(id);grouped.set(id,{id,windowIds:[...(previous?.windowIds??[]),window.id],earliestOrdinal:previous?.earliestOrdinal??window.ordinal,score:0});}
 const matching=(await context.db.query<{ordinal:number}>("SELECT ordinal::int FROM unnest($1::text[]) WITH ORDINALITY AS chunk(text,ordinal) WHERE to_tsvector('simple',text) @@ websearch_to_tsquery('simple',$2) ORDER BY ordinal",[windows.map(window=>window.text),read.question])).rows;
 const matchingGroups=new Set(matching.map(row=>askGroupHash(windows[row.ordinal-1]!.text)));
 const groups=[...grouped.values()].filter(group=>matchingGroups.has(group.id)).slice(0,10);
 const selectedIds=new Set(groups.flatMap(group=>group.windowIds));
 const selectedWindows=windows.filter(window=>selectedIds.has(window.id));
 const conflicts=await readAskInputConflicts(context,scope,access);
 const inputScopeFingerprint=askFingerprint(scope),contextFingerprint=askFingerprint(contexts),initialAccessFingerprint=askFingerprint(access);
 const configFingerprint=askFingerprint({purpose,route});
 const authorizationFingerprint=askFingerprint({target,workspaceId:context.scope.workspaceId,ownerUserId:row['owner_user_id'],inputScopeFingerprint,contextFingerprint,initialAccessFingerprint,evidenceFingerprint,attributionFingerprint,agentScope});
 const proofInput:AskPurposeProofInput={stage:'answer',route:structuredClone(route),purpose,configFingerprint,authorizationFingerprint,workspaceId:context.scope.workspaceId,ownerUserId:String(row['owner_user_id']),inputScopeFingerprint,contextFingerprint,initialAccessFingerprint,target,evidenceFingerprint,attributionFingerprint,agentScope};
 const inputHash=askFingerprint({toolFirmIds,question:read.question,historyFingerprint:history.fingerprint,windows:windows.map(window=>({id:window.id,source:window.source,textHash:window.textHash})),selectedWindowIds:[...selectedIds],conflicts,inputBoundReached:conflicts===null,configFingerprint,authorizationFingerprint});
 return {scope,agentScope,scopeDescriptor,baseInputHash,evidenceFingerprint,toolFirmIds,identityUnresolved,identityAmbiguous:agentScope!==null&&['firm','person'].includes(agentScope.kind)&&identityUnresolved,history:history.turns,question:read.question,executionVersion:row['execution_version'],windows:row['execution_version']==='agent_v1'?windows:selectedWindows,groups,proofInput,inputHash,coverage:census.coverage,conflicts:conflicts??[],inputBoundReached:conflicts===null,retrievalPartial:!census.coverage.scanComplete||!originalsComplete||grouped.size>groups.length};
}
