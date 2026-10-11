import type {AskAgentScope} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor,lockIdentityContext} from './identityAccess.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {readProcessingContext} from './processingContext.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';
const copiedMail=createNativeCrmMailEvidence();
/** Scope is caller intent, never access authority; freeze only current permitted copies. */
export async function resolveAskAgentScope(context:RepositoryContext,scope:AskAgentScope){
 if(!await activeIdentityActor(context))return null;
 const firmIds=scope.kind==='firm'?[scope.firmId]:[];
 const personIds=scope.kind==='person'?[scope.personId]:[];
 if(!await lockIdentityContext(context,{firmIds,personIds}))return null;
 if(scope.kind!=='selected')return {sources:[],firmIds,personIds,partial:true};
 const candidates=scope.sources;
 const sources=[];
 for(const candidate of candidates){
  if(sources.length===10)break;
  const source={workspaceId:candidate.workspaceId,kind:candidate.kind,sourceId:candidate.sourceId,revision:candidate.revision,contentHash:candidate.contentHash,locator:null};
  const resolved=await resolveCrmSource(context,source,copiedMail);
  if(resolved===null||resolved.source.availability!=='available'||resolved.source.contentHash===null)continue;
  const at=resolved.source.occurredAt;
  if((scope.from!==undefined&&(at===null||Date.parse(at)<Date.parse(scope.from)))||(scope.to!==undefined&&(at===null||Date.parse(at)>=Date.parse(scope.to))))continue;
  const current=await readProcessingContext(context,source,copiedMail);
  if(current===null)continue;
  firmIds.push(...current.firmIds);if(current.personId!==null)personIds.push(current.personId);
  sources.push({...source,contentHash:resolved.source.contentHash});
 }
 if(sources.length!==scope.sources.length)return null;
 if(!await activeIdentityActor(context))return null;
 return {sources,firmIds:[...new Set(firmIds)].sort(),personIds:[...new Set(personIds)].sort(),partial:false};
}

/** Complete source-access closure does not broaden the user's explicit tool intent. */
export function askToolFirmIds(scope:AskAgentScope|null,authorizedFirmIds:readonly string[]){
 return scope?.kind==='firm'?authorizedFirmIds.filter(id=>id===scope.firmId):[...authorizedFirmIds];
}
/** A previous broader turn cannot become current context merely by sharing a copy. */
export function askScopeWithin(previous:AskAgentScope,current:AskAgentScope){
 if(current.from!==undefined&&(previous.from===undefined||Date.parse(previous.from)<Date.parse(current.from)))return false;
 if(current.to!==undefined&&(previous.to===undefined||Date.parse(previous.to)>Date.parse(current.to)))return false;
 if(current.kind==='business')return true;
 if(current.kind!==previous.kind)return false;
 if(current.kind==='firm'&&previous.kind==='firm')return current.firmId===previous.firmId;
 if(current.kind==='person'&&previous.kind==='person')return current.personId===previous.personId;
 if(current.kind==='selected'&&previous.kind==='selected')return previous.sources.every(source=>current.sources.some(allowed=>allowed.workspaceId===source.workspaceId&&allowed.kind===source.kind&&allowed.sourceId===source.sourceId&&allowed.revision===source.revision&&allowed.contentHash===source.contentHash));
 return false;
}
