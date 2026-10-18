import {randomUUID,createHash} from 'node:crypto';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {readProcessingContext} from '@fss/domain/crm/processingContext.ts';
import {originalSourceAccessClosure} from '@fss/domain/crm/evidenceDecisions.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import type {AuthFixture} from './authFixture.ts';

/** Historical data fixture only. Removed answer/action-create commands are not restored. */
export async function seedHistoricalAskAction(fixture:AuthFixture,input:{sourceId:string;firmId:string;text:string;kind:'task'|'note';humanText:string;owner:{userId:string;role:'admin'|'salesperson'};opportunityId?:string}){
 const workspaceId=fixture.alpha.workspaceId;
 const context=repositoryContext(workspaceScope(workspaceId,{kind:'user',...input.owner}),fixture.db);
 const source={workspaceId,sourceId:input.sourceId,kind:'selected_note' as const,revision:1,contentHash:createHash('sha256').update(input.text).digest('hex'),locator:null};
 return withTransaction(fixture.db,async()=>{
  const original=await readProcessingContext(context,source),closure=await originalSourceAccessClosure(context,source);
  if(!original||!closure)throw new Error('Historical original unavailable');
  const requestId=randomUUID(),actionId=randomUUID(),scope=JSON.stringify({sources:[source]}),contexts=JSON.stringify([original]),access=JSON.stringify(closure);
  await fixture.db.query("INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Historical finding',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')",[workspaceId,requestId,input.owner.userId,scope,contexts,access]);
  await fixture.db.query("INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,target_opportunity_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb)",[workspaceId,actionId,input.owner.userId,requestId,input.kind,input.kind==='task'?'open':'active',input.firmId,input.opportunityId??null,input.humanText,scope,contexts,access,JSON.stringify([{...source,locator:`text:0:${input.text.length}`}])]);
  return {requestId,actionId};
 });
}
