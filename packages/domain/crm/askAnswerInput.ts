import {createHash} from 'node:crypto';
import {askExplicitCorpusScopeSchema,crmClaimContextSchema,crmOriginalAccessClosureSchema} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
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
 const scope=askExplicitCorpusScopeSchema.parse(row['scope']);
 const contexts=crmClaimContextSchema.array().parse(row['initial_contexts']);
 const access=crmOriginalAccessClosureSchema.parse(row['initial_access_closure']);
 const purpose=await readAskPurpose(context,'answer');
 if(purpose===null||purpose.revision!==row['purpose_revision']||purpose.evaluationFingerprint!==row['evaluation_fingerprint'])return null;
 const census=await readAskCanonicalCorpus(context,{scope});
 if(census===null||!census.coverage.scanComplete||census.windows.length===0)return null;
 const windows:AskInputWindow[]=[];
 for(const [offset,window] of census.windows.entries()){
  const resolved=await resolveCrmSource(context,{...window.source,locator:window.locator},copiedMail);
  if(resolved===null||resolved.passage?.text!==window.text||resolved.source.contentHash===null)return null;
  const contextIndex=scope.sources.findIndex(source=>source.sourceId===window.source.sourceId&&source.kind===window.source.kind);
  const snapshot=contexts[contextIndex];if(snapshot===undefined)return null;
  const ordinal=offset+1;
  const hash=textHash(window.text),groupHash=askGroupHash(window.text);
  await context.db.query(`INSERT INTO crm_ask_request_windows(workspace_id,request_id,request_version,request_epoch,ordinal,source_kind,source_id,source_revision,source_hash,locator,context_hash,text_hash,group_hash,context_snapshot,original_access_closure) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15::jsonb) ON CONFLICT(workspace_id,request_id,request_version,request_epoch,ordinal) DO NOTHING`,[context.scope.workspaceId,requestId,version,epoch,ordinal,resolved.source.kind,resolved.source.sourceId,resolved.source.revision,resolved.source.contentHash,window.locator,processingContextHash(snapshot),hash,groupHash,JSON.stringify(snapshot),JSON.stringify(access)]);
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
 const inputScopeFingerprint=askFingerprint(scope),contextFingerprint=askFingerprint(contexts),initialAccessFingerprint=askFingerprint(access);
 const configFingerprint=askFingerprint({purpose,route});
 const authorizationFingerprint=askFingerprint({workspaceId:context.scope.workspaceId,ownerUserId:row['owner_user_id'],inputScopeFingerprint,contextFingerprint,initialAccessFingerprint});
 const proofInput:AskPurposeProofInput={stage:'answer',route:structuredClone(route),purpose,configFingerprint,authorizationFingerprint,workspaceId:context.scope.workspaceId,ownerUserId:String(row['owner_user_id']),inputScopeFingerprint,contextFingerprint,initialAccessFingerprint};
 const inputHash=askFingerprint({question:read.question,windows:windows.map(window=>({id:window.id,source:window.source,textHash:window.textHash})),selectedWindowIds:[...selectedIds],configFingerprint,authorizationFingerprint});
 return {question:read.question,windows:selectedWindows,groups,proofInput,inputHash,coverage:census.coverage,retrievalPartial:grouped.size>groups.length};
}
