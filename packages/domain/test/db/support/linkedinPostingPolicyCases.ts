import type {SessionQueryable,SqlParameter} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture{session:SessionQueryable;seeded:TwoWorkspaces}
type Row=Record<string,SqlParameter>;
interface Case{constraint:string;run(f:Fixture):Promise<unknown>}
const settings='linkedin_posting_settings',revisions='linkedin_posting_policy_revisions';
const missing='00000000-0000-4000-8000-000000000616';
const valid=(f:Fixture):Row=>({workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,revision:1,state:'saved',policy:'{}'});
async function insert(f:Fixture,table:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
const bad=(table:string,constraint:string,patch:Row):Case=>({constraint,run:async f=>{if(table===revisions)await insert(f,settings,valid(f));return insert(f,table,{...valid(f),...patch});}});
const duplicate=(table:string):Case=>({constraint:`${table}_pkey`,run:async f=>{if(table===revisions)await insert(f,settings,valid(f));await insert(f,table,valid(f));return insert(f,table,valid(f));}});
export const LINKEDIN_POSTING_POLICY_CONSTRAINT_CASES:readonly Case[]=[
 ...[settings,revisions].flatMap(table=>[bad(table,`${table}_revision_check`,{revision:0}),bad(table,`${table}_state_check`,{state:'unknown'}),bad(table,`${table}_policy_check`,{policy:'[]'}),duplicate(table)]),
 bad(settings,`${settings}_workspace_id_fkey`,{workspace_id:missing}),bad(settings,`${settings}_owner_user_id_fkey`,{owner_user_id:missing}),
 bad(revisions,'linkedin_posting_policy_revisio_workspace_id_owner_user_id_fkey',{owner_user_id:missing}),
 ...['posting_candidate_delivery_fk','posting_candidate_policy_fk','linkedin_posting_candidate_bindings_pkey'].map(constraint=>({constraint,run:async(f:Fixture)=>{
  const w=f.seeded.alpha.workspaceId,u=f.seeded.alpha.admin.userId;
  const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
  await insert(f,settings,valid(f));await insert(f,revisions,valid(f));
  await insert(f,'social_accounts',{workspace_id:w,id:id(6161),owner_user_id:u,platform:'linkedin',external_id:'fixture',display_name:'Founder',account_kind:'profile'});
  await insert(f,'social_posts',{workspace_id:w,id:id(6162),owner_user_id:u});
  await insert(f,'social_post_revisions',{workspace_id:w,post_id:id(6162),revision:1,account_id:id(6161),text:'Fixture',zone:'UTC'});
  await insert(f,'social_post_approvals',{workspace_id:w,id:id(6163),post_id:id(6162),revision:1,account_revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',approved_by:u});
  await insert(f,'social_deliveries',{workspace_id:w,id:id(6164),post_id:id(6162),revision:1,approval_id:id(6163)});
  const binding={workspace_id:w,delivery_id:id(6164),owner_user_id:u,policy_revision:1};
  if(constraint.endsWith('pkey'))await insert(f,'linkedin_posting_candidate_bindings',binding);
  return insert(f,'linkedin_posting_candidate_bindings',{...binding,...(constraint==='posting_candidate_delivery_fk'?{delivery_id:missing}:constraint==='posting_candidate_policy_fk'?{policy_revision:99}:{})});
 }})),
];
