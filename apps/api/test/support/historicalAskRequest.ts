import {randomUUID} from 'node:crypto';
import type {z} from 'zod';
import type {crmSourceLookupSchema} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readProcessingContext} from '@fss/domain/crm/processingContext.ts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import {originalSourceAccessClosure} from '@fss/domain/crm/evidenceDecisions.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {AuthFixture} from './authFixture.ts';

/** Historical retained data, not an alternate answering or action creation API. */
export async function seedHistoricalAskRequest(fixture:AuthFixture,input:{source:z.infer<typeof crmSourceLookupSchema>;question:string}){
 const owner=fixture.alpha.admin;
 const context=repositoryContext(workspaceScope(fixture.alpha.workspaceId,{kind:'user',userId:owner.userId,role:'admin'}),fixture.db);
 return withTransaction(fixture.db,async()=>{
  const original=await readProcessingContext(context,input.source,createNativeCrmMailEvidence()),closure=await originalSourceAccessClosure(context,input.source);
  if(!original||!closure)throw new Error('Historical original unavailable');
  const requestId=randomUUID();
  await fixture.db.query("INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb,'unavailable','purpose_unavailable')",[fixture.alpha.workspaceId,requestId,owner.userId,input.question,JSON.stringify({sources:[input.source]}),JSON.stringify([original]),JSON.stringify(closure)]);
  return requestId;
 });
}
export async function readHistoricalAskRequest(fixture:AuthFixture,requestId:string){
 return (await fixture.db.query<{state:string;reason:string;question:string|null;result:unknown;validated_progress:unknown}>('SELECT state,reason,question,result,validated_progress FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[fixture.alpha.workspaceId,requestId])).rows[0];
}
