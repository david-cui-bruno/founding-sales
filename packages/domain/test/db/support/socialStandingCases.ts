import type {SessionQueryable,SqlParameter} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces}
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
type Row=Record<string,SqlParameter>;
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
async function insert(f:Fixture,table:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
async function plan(f:Fixture){const row={workspace_id:f.seeded.alpha.workspaceId,id:id(925001),owner_user_id:f.seeded.alpha.admin.userId,revision:1,state:'active',configuration:'{}',budget_timezone:'UTC'};await insert(f,'social_standing_plans',row);return row;}
async function slot(f:Fixture){const p=await plan(f);return {workspace_id:p.workspace_id,id:id(925002),owner_user_id:p.owner_user_id,plan_id:p.id,plan_revision:1,local_week:'2026-11-02',ordinal:1,publish_at:'2026-11-03T15:00:00Z',attempt_id:id(925003),state:'preparing'};}
const badPlan=(constraint:string,patch:Row):Case=>({constraint,run:async f=>{const p=await plan(f);return insert(f,'social_standing_plans',{...p,id:id(925004),owner_user_id:id(925005),...patch});}});
const badSlot=(constraint:string,patch:Row):Case=>({constraint,run:async f=>insert(f,'social_standing_slots',{...await slot(f),...patch})});
const duplicateSlot=(constraint:string,patch:Row):Case=>({constraint,run:async f=>{const row={...await slot(f),generation_request_id:id(925006)};await insert(f,'social_standing_slots',row);return insert(f,'social_standing_slots',{...row,id:id(925007),ordinal:2,publish_at:'2026-11-04T15:00:00Z',attempt_id:id(925008),generation_request_id:null,...patch});}});
async function approval(f:Fixture){const s=await slot(f);await insert(f,'social_standing_slots',s);const account=id(925009),post=id(925010);await insert(f,'social_accounts',{workspace_id:s.workspace_id,id:account,owner_user_id:s.owner_user_id,platform:'linkedin',external_id:'standing-constraint-fixture',display_name:'Fictional fixture',account_kind:'profile'});await insert(f,'social_posts',{workspace_id:s.workspace_id,id:post,owner_user_id:s.owner_user_id});await insert(f,'social_post_revisions',{workspace_id:s.workspace_id,post_id:post,revision:1,account_id:account,text:'Fictional current text',zone:'UTC'});return {workspace_id:s.workspace_id,id:id(925011),post_id:post,revision:1,account_revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',approved_by:null,approval_kind:'founder_standing_v1',delegated_slot_id:s.id};}
export const SOCIAL_STANDING_CONSTRAINT_CASES:readonly Case[]=[
 badPlan('social_standing_plan_revision',{revision:0}),badPlan('social_standing_plan_state',{state:'enabled'}),
 {constraint:'social_standing_plan_key',run:async f=>{const p=await plan(f);return insert(f,'social_standing_plans',{...p,owner_user_id:id(925005)});}},
 {constraint:'social_standing_plan_owner',run:async f=>{const p=await plan(f);return insert(f,'social_standing_plans',{...p,id:id(925004)});}},
 badSlot('social_standing_slot_ordinal',{ordinal:4}),badSlot('social_standing_slot_state',{state:'draft'}),
 badSlot('social_standing_slot_plan',{plan_id:id(925099)}),
 badSlot('social_standing_marked_attempt',{submission_marked_at:'2026-11-03T14:00:00Z',state:'submitting'}),
 badSlot('social_standing_target',{publish_at:null}),
 duplicateSlot('social_standing_slot_key',{id:id(925002)}),duplicateSlot('social_standing_slot_week',{ordinal:1}),
 duplicateSlot('social_standing_slot_request',{generation_request_id:id(925006)}),duplicateSlot('social_standing_slot_attempt',{attempt_id:id(925003)}),
 duplicateSlot('social_standing_slot_target_instant',{publish_at:'2026-11-03T15:00:00Z'}),
 {constraint:'social_standing_lineage_key',run:async f=>{const s=await slot(f);await insert(f,'social_standing_slots',s);const row={workspace_id:s.workspace_id,owner_user_id:s.owner_user_id,input_id:id(925012),slot_id:s.id};await insert(f,'social_standing_lineage',row);return insert(f,'social_standing_lineage',row);}},
 {constraint:'social_standing_lineage_slot',run:async f=>{const p=await plan(f);return insert(f,'social_standing_lineage',{workspace_id:p.workspace_id,owner_user_id:p.owner_user_id,input_id:id(925012),slot_id:id(925099)});}},
 {constraint:'social_approval_delegated_slot',run:async f=>insert(f,'social_post_approvals',{...await approval(f),delegated_slot_id:id(925099)})},
 {constraint:'social_approval_origin',run:async f=>insert(f,'social_post_approvals',{...await approval(f),approved_by:f.seeded.alpha.admin.userId})},
 {constraint:'social_approval_origin',run:async f=>insert(f,'social_post_approvals',{...await approval(f),approved_by:f.seeded.alpha.admin.userId,approval_kind:'manual'})},
];
