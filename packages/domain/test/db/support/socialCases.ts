import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces}
type Row=Record<string,unknown>;
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
const absent='00000000-0000-4000-8000-000000009999';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
// Fixed identifiers live only within the caller's rolled-back transaction.
function rows(f:Fixture):Record<string,Row>{const w=f.seeded.alpha.workspaceId,u=f.seeded.alpha.admin.userId;return {
 social_library_usage:{workspace_id:w,bytes_reserved:0},
 social_assets:{workspace_id:w,id:id(1),owner_user_id:u,origin:'{}'},
 social_asset_objects:{workspace_id:w,asset_id:id(1),version:1,upload_id:id(2),object_key:'social-case',kind:'original',state:'ready',sha256:'a'.repeat(64),bytes:20,mime:'image/png'},
 social_object_deletions:{workspace_id:w,asset_id:id(1),version:1,object_key:'social-case',bytes:20},
 social_accounts:{workspace_id:w,id:id(3),owner_user_id:u,platform:'linkedin',external_id:'profile',display_name:'Founder',account_kind:'profile'},
 social_posts:{workspace_id:w,id:id(4),owner_user_id:u},
 social_post_revisions:{workspace_id:w,post_id:id(4),revision:1,account_id:id(3),text:'Approved',zone:'UTC'},
 social_post_approvals:{workspace_id:w,id:id(5),post_id:id(4),revision:1,account_revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',approved_by:u},
 social_deliveries:{workspace_id:w,id:id(6),post_id:id(4),revision:1,approval_id:id(5),submission_id:id(7)},
 social_draft_requests:{workspace_id:w,id:id(8),owner_user_id:u,source_selection:'{}',source_hash:'a'.repeat(64),prompt_version:'v1',model_name:'fixture',created_at:'2026-10-06T12:00:00Z',deadline_at:'2026-10-06T12:30:00Z'},
 social_weekly_settings:{workspace_id:w,owner_user_id:u},
};}
async function insert(f:Fixture,table:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));}
async function prepare(f:Fixture,table:string){const all=rows(f);for(const [name,row] of Object.entries(all)){if(name===table)return row;await insert(f,name,row);}throw new Error('unknown fixture table');}
const bad=(table:string,suffix:string,patch:Row):Case=>({constraint:`${table}_${suffix}`,run:async f=>{
 const row=await prepare(f,table);
 // These guards are also implied by the composite shape check, which Postgres
 // reports first. Isolate the named guard inside the caller's rollback, as the
 // other constraint suites do for overlapping keys; the shape has its own case.
 if(table==='social_asset_objects'&&['version_check','kind_check'].includes(suffix))await f.session.query('ALTER TABLE social_asset_objects DROP CONSTRAINT social_asset_objects_check');
 return insert(f,table,{...row,...patch});
}});
const duplicate=(table:string,suffix:string,patch:Row={}):Case=>({constraint:`${table}_${suffix}`,run:async f=>{const row=await prepare(f,table);await insert(f,table,row);return insert(f,table,{...row,...patch});}});
const cases:Case[]=[];
const checks:Record<string,Record<string,Row>>={
 social_library_usage:{bytes_reserved_check:{bytes_reserved:-1},workspace_id_fkey:{workspace_id:absent}},
 social_assets:{current_version_check:{current_version:0},state_check:{state:'bad'},workspace_id_fkey:{workspace_id:absent},owner_user_id_fkey:{owner_user_id:absent}},
 social_asset_objects:{version_check:{version:0},kind_check:{kind:'bad'},state_check:{state:'bad'},sha256_check:{sha256:'bad'},bytes_check:{bytes:0},mime_check:{mime:'bad'},check:{kind:'derivative'},workspace_id_asset_id_fkey:{asset_id:absent}},
 social_object_deletions:{bytes_check:{bytes:0},attempts_check:{attempts:-1},workspace_id_asset_id_version_fkey:{version:99}},
 social_accounts:{platform_check:{platform:'bad'},external_id_check:{external_id:''},display_name_check:{display_name:''},account_kind_check:{account_kind:'bad'},state_check:{state:'bad'},revision_check:{revision:0},max_schedule_days_check:{max_schedule_days:0},workspace_id_fkey:{workspace_id:absent},owner_user_id_fkey:{owner_user_id:absent}},
 social_posts:{current_revision_check:{current_revision:0},workspace_id_fkey:{workspace_id:absent},owner_user_id_fkey:{owner_user_id:absent}},
 social_post_revisions:{revision_check:{revision:0},text_check:{text:''},state_check:{state:'bad'},workspace_id_post_id_fkey:{post_id:absent},workspace_id_account_id_fkey:{account_id:absent}},
 social_post_approvals:{fingerprint_check:{fingerprint:'bad'},approved_by_fkey:{approved_by:absent},workspace_id_post_id_revision_fkey:{revision:99}},
 social_deliveries:{media_binding_check:{media_binding:'[]'},state_check:{state:'bad'},inspection_attempts_check:{inspection_attempts:-1},workspace_id_post_id_revision_fkey:{revision:99},workspace_id_approval_id_fkey:{approval_id:absent}},
 social_draft_requests:{source_selection_check:{source_selection:'[]'},source_hash_check:{source_hash:'bad'},state_check:{state:'bad'},paid_attempts_check:{paid_attempts:3},concepts_check:{concepts:'[]'},reason_check:{reason:'x'.repeat(201)},check:{deadline_at:'2026-10-06T13:00:00Z'},check1:{state:'ready'},weekly_revision_check:{weekly_revision:0},workspace_id_fkey:{workspace_id:absent},workspace_id_owner_user_id_fkey:{owner_user_id:absent}},
 social_weekly_settings:{revision_check:{revision:0},last_result_check:{last_result:'bad'},check:{enabled:true},workspace_id_owner_user_id_fkey:{owner_user_id:absent}},
};
for(const [table,entries] of Object.entries(checks))for(const [name,patch] of Object.entries(entries))cases.push(bad(table,name,patch));
for(const table of Object.keys(checks))cases.push(duplicate(table,'pkey',table==='social_asset_objects'?{object_key:'different',upload_id:id(99)}:{}));
cases.push(
 duplicate('social_accounts','workspace_id_owner_user_id_platform_externa_key',{id:id(99)}),
 duplicate('social_asset_objects','object_key_key',{version:2,kind:'derivative',width:10,height:10,upload_id:id(99)}),
 duplicate('social_asset_objects','workspace_id_upload_id_key',{version:2,kind:'derivative',width:10,height:10,object_key:'other'}),
 duplicate('social_post_approvals','workspace_id_post_id_revision_key',{id:id(99)}),
 duplicate('social_deliveries','workspace_id_post_id_revision_key',{id:id(99),submission_id:id(98)}),
 {constraint:'social_asset_pending',run:async f=>{const row=await prepare(f,'social_asset_objects');await insert(f,'social_asset_objects',{...row,state:'uploading'});return insert(f,'social_asset_objects',{...row,state:'uploading',version:2,kind:'derivative',width:10,height:10,upload_id:id(99),object_key:'other'});}},
 {constraint:'social_draft_active_source',run:async f=>{const row=await prepare(f,'social_draft_requests');await insert(f,'social_draft_requests',row);return insert(f,'social_draft_requests',{...row,id:id(99)});}},
 {constraint:'social_deliveries_workspace_id_submission_id_key',run:async f=>{const row=await prepare(f,'social_deliveries');await insert(f,'social_deliveries',row);await insert(f,'social_post_revisions',{...rows(f)['social_post_revisions'],revision:2});return insert(f,'social_deliveries',{...row,id:id(99),revision:2});}},
);
export const SOCIAL_CONSTRAINT_CASES:readonly Case[]=cases;
