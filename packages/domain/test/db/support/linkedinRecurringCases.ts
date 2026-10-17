import type {SessionQueryable,SqlParameter} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture{session:SessionQueryable;seeded:TwoWorkspaces}
interface Case{constraint:string;run(f:Fixture):Promise<unknown>}
type Row=Record<string,SqlParameter>;
const table='linkedin_recurring_slots',missing='00000000-0000-4000-8000-000000000999';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function insert(f:Fixture,t:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${t}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
async function seed(f:Fixture){
 const w=f.seeded.alpha.workspaceId,u=f.seeded.alpha.admin.userId;
 const policy={workspace_id:w,owner_user_id:u,revision:1,state:'saved',policy:'{}'};
 await insert(f,'linkedin_posting_settings',policy);await insert(f,'linkedin_posting_policy_revisions',policy);
 await insert(f,'social_accounts',{workspace_id:w,id:id(6171),owner_user_id:u,platform:'linkedin',external_id:'constraint-fixture',display_name:'Fixture',account_kind:'profile'});
 await insert(f,'social_draft_requests',{workspace_id:w,id:id(6172),owner_user_id:u,source_selection:'{}',source_hash:'a'.repeat(64),prompt_version:'fixture',model_name:'fixture',state:'review'});
 await insert(f,'social_posts',{workspace_id:w,id:id(6173),owner_user_id:u});
 await insert(f,'social_post_revisions',{workspace_id:w,post_id:id(6173),revision:1,account_id:id(6171),text:'Fixture',zone:'UTC'});
 return {workspace_id:w,id:id(6174),owner_user_id:u,account_id:id(6171),account_revision:1,policy_revision:1,target_at:'2026-11-03T15:00:00Z',state:'skipped',source_selection:null,source_hash:null,draft_request_id:null,post_id:null};
}
const bad=(suffix:string,patch:Row):Case=>({constraint:`${table}_${suffix}`,run:async f=>{
 const row=await seed(f);
 // Isolate overlapping FK failures inside the runner's rollback-only fixture transaction.
 if(suffix==='workspace_id_fkey')for(const c of ['workspace_id_account_id_fkey','workspace_id_owner_user_id_policy_fkey','workspace_id_draft_request_id_fkey','workspace_id_post_id_fkey'])await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_${c}`);
 return insert(f,table,{...row,...patch});
}});
export const LINKEDIN_RECURRING_CONSTRAINT_CASES:readonly Case[]=[
 bad('account_revision_check',{account_revision:0}),bad('policy_revision_check',{policy_revision:0}),
 bad('state_check',{state:'enabled'}),bad('reason_check',{reason:'x'.repeat(201)}),
 bad('source_hash_check',{source_selection:'{"mode":"linkedin_grounded"}',source_hash:'not-a-hash'}),
 bad('source_selection_check',{source_selection:'[]',source_hash:'a'.repeat(64)}),
 bad('target_at_check',{target_at:'2026-11-03T15:05:00Z'}),
 bad('target_at_check',{target_at:'2026-11-04T15:00:00Z'}),
 bad('check',{source_hash:'a'.repeat(64)}),
 bad('check1',{state:'pending'}),
 bad('check2',{state:'queued',source_selection:'{"mode":"linkedin_grounded"}',source_hash:'a'.repeat(64),draft_request_id:id(6172)}),
 bad('workspace_id_fkey',{workspace_id:missing}),bad('owner_user_id_fkey',{owner_user_id:missing}),
 bad('workspace_id_account_id_fkey',{account_id:missing}),
 bad('workspace_id_owner_user_id_policy_fkey',{policy_revision:99}),
 bad('workspace_id_draft_request_id_fkey',{draft_request_id:missing}),bad('workspace_id_post_id_fkey',{post_id:missing}),
 ...['pkey','workspace_id_account_id_target_at_key','workspace_id_id_post_id_key'].map(suffix=>({constraint:`${table}_${suffix}`,run:async(f:Fixture)=>{
  const row=await seed(f);await insert(f,table,{...row,post_id:id(6173)});
  if(suffix==='workspace_id_id_post_id_key')await f.session.query(`ALTER TABLE ${table} DROP CONSTRAINT ${table}_pkey CASCADE`);
  return insert(f,table,{...row,post_id:id(6173),...(suffix==='workspace_id_account_id_target_at_key'?{id:id(6175)}:suffix==='workspace_id_id_post_id_key'?{target_at:'2026-11-05T15:00:00Z'}:{})});
 }})),
 ...[
  {approval_kind:'manual',approved_by:null,standing_slot_id:null},
  {approval_kind:'standing_policy',approved_by:null,standing_slot_id:null},
  {approval_kind:'standing_policy',approved_by:'owner',standing_slot_id:id(6174)},
  {approval_kind:'enabled',approved_by:null,standing_slot_id:id(6174)},
 ].map(patch=>({constraint:'social_approval_origin',run:async(f:Fixture)=>{const row=await seed(f);await insert(f,table,{...row,post_id:id(6173)});return insert(f,'social_post_approvals',{workspace_id:row.workspace_id,id:id(6176),post_id:id(6173),revision:1,account_revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',...patch,approved_by:patch.approved_by==='owner'?row.owner_user_id:patch.approved_by});}})),
 {constraint:'social_approval_standing_slot_fk',run:async f=>{const row=await seed(f);return insert(f,'social_post_approvals',{workspace_id:row.workspace_id,id:id(6176),post_id:id(6173),revision:1,account_revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',approval_kind:'standing_policy',approved_by:null,standing_slot_id:missing});}},
];
