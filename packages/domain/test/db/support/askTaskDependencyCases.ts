import { randomUUID } from 'node:crypto';
import type { SqlParameter } from '../../../db/queryable.ts';
import type { CallToBookingFixture } from './callToBookingCases.ts';
import { seedAskRequest } from './askAnswerCases.ts';
type Fixture = CallToBookingFixture;
type Row = Record<string, SqlParameter>;
type Case = {constraint: string; run(f: Fixture): Promise<unknown>};
const missing = '00000000-0000-4000-8000-000000005590';
const hash = 'a'.repeat(64);
const context = {personId:null,firmIds:[],relationships:[],review:'current'};
const closure = {firmIds:[],personIds:[]};
async function insert(f: Fixture, table: string, row: Row) {
 const keys = Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`, Object.values(row));
}
async function action(f: Fixture, patch: Row = {}) {
 const sourceRequest = await seedAskRequest(f,{initial_contexts:JSON.stringify([{...context,firmIds:[f.crm.alpha.firmId]}]),initial_access_closure:JSON.stringify({...closure,firmIds:[f.crm.alpha.firmId]})});
 const proof = (await f.session.query<{scope:{sources:Record<string,unknown>[]};initial_contexts:unknown;initial_access_closure:unknown}>('SELECT scope,initial_contexts,initial_access_closure FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[f.seeded.alpha.workspaceId,sourceRequest])).rows[0]!;
 const id = randomUUID();
 await insert(f,'crm_ask_actions',{workspace_id:f.seeded.alpha.workspaceId,id,owner_user_id:f.seeded.alpha.salesperson.userId,source_request_id:sourceRequest,source_request_version:1,kind:'task',status:'open',target_firm_id:f.crm.alpha.firmId,human_text:'Review independent task proof',input_scope:JSON.stringify(proof.scope),initial_contexts:JSON.stringify(proof.initial_contexts),original_access_closure:JSON.stringify(proof.initial_access_closure),support_refs:JSON.stringify([{...proof.scope.sources[0],locator:'text:0:4'}]),...patch});
 return id;
}
async function internalTask(f: Fixture) {
 const anchorId=randomUUID(),reviewId=randomUUID(),id=randomUUID(),sourceId=randomUUID();
 await insert(f,'crm_claim_review_anchors',{workspace_id:f.seeded.alpha.workspaceId,id:anchorId,source_kind:'selected_note',source_id:sourceId,source_revision:1,source_hash:hash,owner_user_id:f.seeded.alpha.salesperson.userId,original_access_closure:JSON.stringify(closure),context_snapshot:JSON.stringify(context),context_hash:hash,semantic_hash:randomUUID().replaceAll('-','').repeat(2),review_family_hash:hash,claim_kind:'commitment',locator_hash:hash,original_claim_id:randomUUID(),original_claim_hash:hash,original_claim_revision:1,original_observed_at:'2026-10-01T00:00:00Z'});
 await insert(f,'crm_commitment_reviews',{workspace_id:f.seeded.alpha.workspaceId,id:reviewId,owner_user_id:f.seeded.alpha.salesperson.userId,family_key:randomUUID().replaceAll('-','').repeat(2),activation_key:hash,anchor_id:anchorId,target:'{}',initial_context_snapshot:JSON.stringify(context),context_snapshot:JSON.stringify(context),original_access_closure:JSON.stringify(closure),basis:'human',classification:'internal_promise',actor:'self',action_label:'Internal work',today_eligibility:'unknown'});
 const receipt={reviewId,reviewRevision:1,activationKey:hash,sourceKind:'selected_note',sourceId,sourceRevision:1,sourceHash:hash,anchorId,decisionRevision:0,contextHash:hash,initialContextSnapshot:context,contextSnapshot:context,originalAccessClosure:closure,actionHash:hash,dueHash:hash,activatedAt:'2026-10-01T00:00:00.000Z'};
 await insert(f,'crm_internal_tasks',{workspace_id:f.seeded.alpha.workspaceId,id,owner_user_id:f.seeded.alpha.salesperson.userId,task_key:hash,review_id:reviewId,activation_receipt:JSON.stringify(receipt)});
 return id;
}
async function dependency(f: Fixture, internal=false, requestPatch: Row={}) {
 return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),request_id:await seedAskRequest(f,{execution_version:'agent_v1',original_agent_scope:JSON.stringify({kind:'business'}),...requestPatch}),request_version:1,request_epoch:1,action_id:internal?null:await action(f),internal_task_id:internal?await internalTask(f):null,task_version:1};
}
const cases: Case[]=[];
for(const column of ['request_version','request_epoch','task_version'])cases.push({constraint:`crm_ask_task_dependencies_${column}_check`,run:async f=>insert(f,'crm_ask_task_dependencies',{...await dependency(f),[column]:0})});
for(const patch of [{action_id:null,internal_task_id:null},{internal_task_id:missing}])cases.push({constraint:'crm_ask_task_dependencies_check',run:async f=>insert(f,'crm_ask_task_dependencies',{...await dependency(f),...patch})});
for(const column of ['request_id','action_id','internal_task_id'])cases.push({constraint:`crm_ask_task_dependencies_workspace_id_${column}_fkey`,run:async f=>insert(f,'crm_ask_task_dependencies',{...await dependency(f,column==='internal_task_id'),[column]:missing})});
cases.push({constraint:'crm_ask_task_dependencies_pkey',run:async f=>{const row=await dependency(f);await insert(f,'crm_ask_task_dependencies',row);return insert(f,'crm_ask_task_dependencies',row);}});
for(const [internal,constraint] of [[false,'crm_ask_task_dependencies_workspace_id_request_id_action_id_key'],[true,'crm_ask_task_dependencies_workspace_id_request_id_internal__key']] as const)cases.push({constraint,run:async f=>{const row=await dependency(f,internal);await insert(f,'crm_ask_task_dependencies',row);return insert(f,'crm_ask_task_dependencies',{...row,id:randomUUID()});}});
for(const patch of [{request_version:2},{request_epoch:2},{task_version:2}])cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>insert(f,'crm_ask_task_dependencies',{...await dependency(f),...patch})});
for(const requestPatch of [{execution_version:'legacy_v1',original_agent_scope:null},{state:'unavailable',reason:'purpose_unavailable'},{owner_user_id:'admin'}])cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>insert(f,'crm_ask_task_dependencies',await dependency(f,false,requestPatch.owner_user_id==='admin'?{owner_user_id:f.seeded.alpha.admin.userId}:requestPatch))});
cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>{const row=await dependency(f);await f.session.query('UPDATE crm_ask_requests SET cancelled_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[row.workspace_id,row.request_id]);return insert(f,'crm_ask_task_dependencies',row);}});
for(const patch of [{kind:'note',status:'active'},{status:'done',completed_at:'2026-10-01T00:00:00Z'}])cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>{const row=await dependency(f);return insert(f,'crm_ask_task_dependencies',{...row,action_id:await action(f,patch)});}});
for(const patch of [{task_version:2},{request_epoch:2}])cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>insert(f,'crm_ask_task_dependencies',{...await dependency(f,true),...patch})});
cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>insert(f,'crm_ask_task_dependencies',await dependency(f,true,{owner_user_id:f.seeded.alpha.admin.userId}))});
cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>{
 const row=await dependency(f,true);
 const id=randomUUID();
 await insert(f,'crm_internal_tasks',{workspace_id:f.seeded.alpha.workspaceId,id,owner_user_id:f.seeded.alpha.salesperson.userId,task_key:randomUUID().replaceAll('-','').repeat(2)});
 return insert(f,'crm_ask_task_dependencies',{...row,internal_task_id:id});
}});
cases.push({constraint:'crm_ask_task_dependency_current',run:async f=>{
 const row=await dependency(f);
 await f.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs) SELECT a.workspace_id,gen_random_uuid(),a.owner_user_id,a.source_request_id,a.source_request_version,a.kind,a.status,a.target_firm_id,a.human_text,a.input_scope,a.initial_contexts,a.original_access_closure,a.support_refs FROM crm_ask_actions a CROSS JOIN generate_series(1,1000) WHERE a.workspace_id=$1 AND a.id=$2`,[row.workspace_id,row.action_id]);
 await f.session.query('SET CONSTRAINTS crm_ask_task_dependency_current DEFERRED');
 await f.session.query(`INSERT INTO crm_ask_task_dependencies(workspace_id,request_id,request_version,request_epoch,action_id,task_version) SELECT a.workspace_id,$3,1,1,a.id,1 FROM crm_ask_actions a WHERE a.workspace_id=$1 AND a.source_request_id=(SELECT source_request_id FROM crm_ask_actions WHERE workspace_id=$1 AND id=$2)`,[row.workspace_id,row.action_id,row.request_id]);
 return f.session.query('SET CONSTRAINTS crm_ask_task_dependency_current IMMEDIATE');
}});
export const ASK_TASK_DEPENDENCY_CONSTRAINT_CASES=cases;
