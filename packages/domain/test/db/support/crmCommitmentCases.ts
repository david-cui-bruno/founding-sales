import { randomUUID } from 'node:crypto';
import type { CallToBookingFixture } from './callToBookingCases.ts';
import type { SqlParameter } from '../../../db/queryable.ts';
type Row = Record<string, SqlParameter>;
type Case = {constraint:string;run(f:CallToBookingFixture):Promise<unknown>};
const absent='00000000-0000-4000-8000-000000004900';
const hash='a'.repeat(64);
async function insert(f:CallToBookingFixture,table:string,row:Row){
 const keys=Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,index)=>'$'+(index+1)).join(',')})`,Object.values(row));
}
async function review(f:CallToBookingFixture,patch:Row={}){
 const id=randomUUID();
 await insert(f,'crm_claim_review_anchors',{
  workspace_id:f.seeded.alpha.workspaceId,id,source_kind:'selected_note',source_id:randomUUID(),source_revision:1,source_hash:hash,
  owner_user_id:f.seeded.alpha.salesperson.userId,original_access_closure:'{"firmIds":[],"personIds":[]}',
  context_snapshot:'{"personId":null,"firmIds":[],"relationships":[],"review":"current"}',context_hash:hash,
  semantic_hash:randomUUID().replaceAll('-','').repeat(2),review_family_hash:hash,claim_kind:'commitment',locator_hash:hash,
  original_claim_id:randomUUID(),original_claim_hash:hash,original_claim_revision:1,original_observed_at:'2026-10-01T00:00:00Z',
 });
 return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.salesperson.userId,
  task_key:randomUUID().replaceAll('-','').repeat(2),anchor_id:id,target:'{}',
  context_snapshot:'{"personId":null,"firmIds":[],"relationships":[],"review":"current"}',original_access_closure:'{"firmIds":[],"personIds":[]}',
  classification:'internal_promise',actor:'self',action_label:'Internal work',today_eligibility:'unknown',...patch};
}
function task(f:CallToBookingFixture,patch:Row={}){
 return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.salesperson.userId,
  task_key:randomUUID().replaceAll('-','').repeat(2),...patch};
}
function columns(table:string,make:(f:CallToBookingFixture,patch:Row)=>Row|Promise<Row>,cases:readonly(readonly[string,Row])[]):Case[]{
 return cases.map(([constraint,patch])=>({constraint,run:async f=>insert(f,table,await make(f,patch))}));
}
function duplicate(table:string,make:(f:CallToBookingFixture)=>Row|Promise<Row>,constraint:string,identity:'id'|'task_key'):Case{
 return {constraint,run:async f=>{const first=await make(f);await insert(f,table,first);const next=await make(f);next[identity]=first[identity]!;return insert(f,table,next);}};
}
export const CRM_COMMITMENT_CONSTRAINT_CASES:readonly Case[]=[
 ...columns('crm_commitment_reviews',review,[
  ['crm_commitment_projection_shape',{projection_receipt:'{}'}],
  ['crm_commitment_review_private_shape',{context_snapshot:'{}'}],
  ['crm_commitment_reviews_action_label_check',{action_label:'   '}],
  ['crm_commitment_reviews_actor_check',{actor:'invented'}],
  ['crm_commitment_reviews_check',{projected_revision:-1}],
  ['crm_commitment_reviews_classification_check',{classification:'invented'}],
  ['crm_commitment_reviews_projection_version_check',{projection_version:-1}],
  ['crm_commitment_reviews_revision_check',{revision:0}],
  ['crm_commitment_reviews_state_check',{state:'invented'}],
  ['crm_commitment_reviews_task_key_check',{task_key:'invalid'}],
  ['crm_commitment_reviews_workspace_id_anchor_id_fkey',{anchor_id:absent}],
  ['crm_commitment_reviews_workspace_id_owner_user_id_fkey',{owner_user_id:absent}],
  ['crm_commitment_today_eligibility',{today_eligibility:'invented'}],
 ]),
 duplicate('crm_commitment_reviews',review,'crm_commitment_reviews_pkey','id'),
 duplicate('crm_commitment_reviews',review,'crm_commitment_reviews_workspace_id_task_key_key','task_key'),
 ...columns('crm_internal_tasks',task,[
  ['crm_internal_completion_shape',{status:'done'}],
  ['crm_internal_tasks_status_check',{status:'invented'}],
  ['crm_internal_tasks_task_key_check',{task_key:'invalid'}],
  ['crm_internal_tasks_version_check',{version:0}],
  ['crm_internal_tasks_workspace_id_owner_user_id_fkey',{owner_user_id:absent}],
  ['crm_internal_tasks_workspace_id_review_id_fkey',{review_id:absent}],
 ]),
 duplicate('crm_internal_tasks',task,'crm_internal_tasks_pkey','id'),
 duplicate('crm_internal_tasks',task,'crm_internal_tasks_workspace_id_task_key_key','task_key'),
];
