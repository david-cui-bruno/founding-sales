import type {SessionQueryable,SqlParameter} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';

interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces}
type Row=Record<string,SqlParameter>;
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
const settings='linkedin_outreach_settings';
const revisions='linkedin_outreach_policy_revisions';
const absent='00000000-0000-4000-8000-000000006270';
const approvalAt='2026-10-13T16:13:36Z';
function valid(f:Fixture):Row{
 return {workspace_id:f.seeded.alpha.workspaceId,owner_user_id:f.seeded.alpha.admin.userId,revision:1,state:'saved',approved:true,approved_at:approvalAt,policy:'{}'};
}
async function insert(f:Fixture,table:string,row:Row):Promise<unknown>{
 const keys=Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
function bad(table:string,constraint:string,patch:Row):Case{
 return {constraint,run:async f=>{
  if(table===revisions)await insert(f,settings,valid(f));
  // The combined approval-state shape also refuses every unknown state. Isolate
  // the enum guard only inside the inventory runner's rolled-back transaction,
  // as the established social cases do for overlapping guards. Its combined
  // shape has separate genuine failing insert cases below, never an exemption.
  if(constraint===`${settings}_state_check`)await f.session.query(`ALTER TABLE ${settings} DROP CONSTRAINT ${settings}_check`);
  return insert(f,table,{...valid(f),...patch});
 }};
}
function duplicate(table:string):Case{
 return {constraint:`${table}_pkey`,run:async f=>{
  const row=valid(f);
  if(table===revisions)await insert(f,settings,row);
  await insert(f,table,row);
  return insert(f,table,row);
 }};
}
export const LINKEDIN_POLICY_CONSTRAINT_CASES:readonly Case[]=[
 bad(settings,`${settings}_revision_check`,{revision:0}),
 bad(settings,`${settings}_state_check`,{state:'unrecognized'}),
 bad(settings,`${settings}_policy_check`,{policy:'[]'}),
 bad(settings,`${settings}_workspace_id_fkey`,{workspace_id:absent}),
 bad(settings,`${settings}_owner_user_id_fkey`,{owner_user_id:absent}),
 duplicate(settings),
 // Explicit approval is required only for saved state. Stops clear both fields.
 bad(settings,`${settings}_check`,{approved:false}),
 bad(settings,`${settings}_check`,{approved_at:null}),
 bad(settings,`${settings}_check`,{state:'disabled'}),
 bad(settings,`${settings}_check`,{state:'revoked'}),
 bad(settings,`${settings}_check`,{state:'disabled',approved:false}),
 bad(revisions,`${revisions}_revision_check`,{revision:0}),
 bad(revisions,`${revisions}_state_check`,{state:'unrecognized'}),
 bad(revisions,`${revisions}_policy_check`,{policy:'[]'}),
 bad(revisions,'linkedin_outreach_policy_revisi_workspace_id_owner_user_id_fkey',{owner_user_id:absent}),
 duplicate(revisions),
];
