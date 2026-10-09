import {randomUUID} from 'node:crypto';
import type {SqlParameter} from '../../../db/queryable.ts';
import type {CallToBookingFixture} from './callToBookingCases.ts';
import {seedAskRequest} from './askAnswerCases.ts';
type Fixture=CallToBookingFixture;
type Row=Record<string,SqlParameter>;
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
const missing='00000000-0000-4000-8000-000000004940';
async function insert(f:Pick<Fixture,'session'>,row:Row){const columns=Object.keys(row);return f.session.query<{id:string}>(`INSERT INTO crm_ask_actions(${columns.join(',')}) VALUES(${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING id`,Object.values(row));}
async function action(f:Pick<Fixture,'session'|'seeded'>):Promise<Row>{
 const requestId=await seedAskRequest(f);
 const parent=(await f.session.query<{scope:{sources:Record<string,unknown>[]};initial_contexts:unknown;initial_access_closure:unknown}>('SELECT scope,initial_contexts,initial_access_closure FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[f.seeded.alpha.workspaceId,requestId])).rows[0]!;
 return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.salesperson.userId,source_request_id:requestId,source_request_version:1,kind:'preference',status:'proposed',version:1,private_state:'available',target_firm_id:null,target_person_id:null,human_text:'Prefer explicit maintenance evidence',due:null,input_scope:JSON.stringify(parent.scope),initial_contexts:JSON.stringify(parent.initial_contexts),original_access_closure:JSON.stringify(parent.initial_access_closure),support_refs:JSON.stringify([{...parent.scope.sources[0],locator:'text:0:4'}]),review_required:false,completed_at:null};
}
function bad(constraint:string,patch:Row):Case{return {constraint,run:async f=>insert(f,{...await action(f),...patch})};}
const redacted={private_state:'deleted',target_firm_id:null,target_person_id:null,human_text:null,due:null,input_scope:null,initial_contexts:null,original_access_closure:null,support_refs:null};
const cases:Case[]=[
 {constraint:'crm_ask_action_due',run:async f=>insert(f,{...await action(f),kind:'task',status:'open',target_firm_id:f.crm.alpha.firmId,due:JSON.stringify({kind:'date',date:'2026-13-99',zone:'America/New_York',expression:'User chosen date'})})},
 {constraint:'crm_ask_action_current_request',run:async f=>insert(f,{...await action(f),owner_user_id:f.seeded.alpha.admin.userId})},
 bad('crm_ask_action_current_request',{source_request_version:2}),
 bad('crm_ask_action_current_request',{initial_contexts:JSON.stringify([{personId:null,firmIds:[],relationships:[],review:'required'}])}),
 {constraint:'crm_ask_action_current_request',run:async f=>insert(f,{...await action(f),original_access_closure:JSON.stringify({firmIds:[f.crm.alpha.firmId],personIds:[]})})},
 {constraint:'crm_ask_action_current_request',run:async f=>insert(f,{...await action(f),kind:'note',status:'active',target_firm_id:f.crm.alpha.firmId})},
 {constraint:'crm_ask_action_current_request',run:async f=>{const row=await action(f),scope=JSON.parse(String(row['input_scope'])) as {sources:Record<string,unknown>[]};scope.sources[0]!['revision']=2;return insert(f,{...row,input_scope:JSON.stringify(scope),support_refs:JSON.stringify([{...scope.sources[0],locator:'text:0:4'}])});}},
 ...(['stale','deleted'] as const).map(state=>({constraint:'crm_ask_action_current_request',run:async(f:Fixture)=>{const row=await action(f);await f.session.query(`UPDATE crm_ask_requests SET state=$3,reason=$4,version=version+1,epoch=epoch+1,question=NULL,scope=CASE WHEN $3='deleted' THEN NULL ELSE scope END,initial_contexts=CASE WHEN $3='deleted' THEN NULL ELSE initial_contexts END,initial_access_closure=CASE WHEN $3='deleted' THEN NULL ELSE initial_access_closure END,result=NULL,result_at=NULL WHERE workspace_id=$1 AND id=$2`,[row['workspace_id']!,row['source_request_id']!,state,state==='deleted'?'deleted':'source_changed']);return insert(f,row);}})),
 bad('crm_ask_actions_source_request_version_check',{source_request_version:0}),
 bad('crm_ask_actions_version_check',{version:0}),
 bad('crm_ask_actions_private_state_check',{...redacted,private_state:'unknown'}),
 bad('crm_ask_action_status',{status:'open'}),
 bad('crm_ask_action_status',{...redacted,kind:'unknown'}),
 bad('crm_ask_action_completion',{completed_at:'2026-10-09T12:00:00Z'}),
 bad('crm_ask_action_private_shape',{human_text:''}),
 bad('crm_ask_actions_workspace_id_owner_user_id_fkey',{owner_user_id:missing}),
 bad('crm_ask_actions_workspace_id_source_request_id_fkey',{source_request_id:missing}),
 {constraint:'crm_ask_actions_workspace_id_target_firm_id_fkey',run:async f=>insert(f,{...await action(f),kind:'note',status:'active',target_firm_id:f.crm.beta.firmId})},
 bad('crm_ask_actions_workspace_id_target_person_id_fkey',{kind:'note',status:'active',target_person_id:missing}),
 {constraint:'crm_ask_actions_pkey',run:async f=>{const row=await action(f);await insert(f,row);return insert(f,row);}},
 {constraint:'crm_ask_action_immutable',run:async f=>{const row=await action(f);await insert(f,row);return f.session.query("UPDATE crm_ask_actions SET human_text='Changed human instruction' WHERE workspace_id=$1 AND id=$2",[row['workspace_id']!,row['id']!]);}},
 {constraint:'crm_ask_action_support',run:async f=>{const row=await action(f);const refs=JSON.parse(String(row['support_refs'])) as Record<string,unknown>[];return insert(f,{...row,support_refs:JSON.stringify([{...refs[0],body:'Untracked private body'}])});}},
];
for(const field of ['workspaceId','sourceId','kind','revision','contentHash','locator'])for(const mode of ['missing','null'] as const)cases.push({constraint:'crm_ask_action_support',run:async f=>{
 const row=await action(f),refs=JSON.parse(String(row['support_refs'])) as Record<string,unknown>[];
 const ref={...refs[0]};if(mode==='missing')delete ref[field];else ref[field]=null;
 return insert(f,{...row,support_refs:JSON.stringify([ref])});
}});
for(const locator of ['', 'x'.repeat(501)])cases.push({constraint:'crm_ask_action_support',run:async f=>{const row=await action(f),refs=JSON.parse(String(row['support_refs'])) as Record<string,unknown>[];return insert(f,{...row,support_refs:JSON.stringify([{...refs[0],locator}])});}});
cases.push({constraint:'crm_ask_action_support',run:async f=>{const row=await action(f),refs=JSON.parse(String(row['support_refs'])) as Record<string,unknown>[];return insert(f,{...row,support_refs:JSON.stringify([refs[0],refs[0]])});}});
cases.push({constraint:'crm_ask_action_support',run:async f=>{const row=await action(f),refs=JSON.parse(String(row['support_refs'])) as Record<string,unknown>[];return insert(f,{...row,support_refs:JSON.stringify([{...refs[0],sourceId:missing}])});}});
export async function seedAskAction(f:Pick<Fixture,'session'|'seeded'>){const row=await action(f);await insert(f,row);return String(row['id']);}
export const ASK_ACTION_CONSTRAINT_CASES:readonly Case[]=cases;
