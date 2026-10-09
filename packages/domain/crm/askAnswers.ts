import {askAnswerAcknowledgmentSchema,type AskAnswerRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor} from './identityAccess.ts';
import {lockConflictSources,originalSourceAccessClosure} from './evidenceDecisions.ts';
import {readProcessingContext} from './processingContext.ts';
import {resolveCrmSource} from './sourceResolver.ts';
import {createNativeCrmMailEvidence} from './nativeMailEvidence.ts';

const copiedMail=createNativeCrmMailEvidence();

/** Private inputs are retained only after the complete selected copy closure is locked. */
export async function requestAskAnswer(context:RepositoryContext,input:AskAnswerRequest){
 const actor=context.scope.actor;
 if(actor.kind!=='user'||!await activeIdentityActor(context)||!await lockConflictSources(context,input.scope.sources))return {ok:false as const,reason:'source_unavailable'};
 const contexts=[];
 const closures=[];
 for(const source of input.scope.sources){
  if(await resolveCrmSource(context,source,copiedMail)===null)return {ok:false as const,reason:'source_unavailable'};
  const current=await readProcessingContext(context,source,copiedMail);
  const original=await originalSourceAccessClosure(context,source);
  if(current===null||original===null)return {ok:false as const,reason:'source_unavailable'};
  contexts.push(current);
  closures.push(original);
 }
 if(!await lockConflictSources(context,input.scope.sources,contexts,closures))return {ok:false as const,reason:'source_unavailable'};
 const closure={firmIds:[...new Set(closures.flatMap(value=>value.firmIds))].sort(),personIds:[...new Set(closures.flatMap(value=>value.personIds))].sort()};
 const row=(await context.db.query<{id:string;version:number}>(`INSERT INTO crm_ask_requests(workspace_id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable') RETURNING id,version`,[context.scope.workspaceId,actor.userId,input.question,JSON.stringify(input.scope),JSON.stringify(contexts),JSON.stringify(closure)])).rows[0]!;
 return {ok:true as const,value:askAnswerAcknowledgmentSchema.parse({requestId:row.id,version:row.version,state:'unavailable'})};
}
