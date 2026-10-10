import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces}
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
type Row=Record<string,unknown>;
const absent='00000000-0000-4000-8000-000000009999';
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const insert=(f:Fixture,table:string,row:Row)=>f.session.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
function rows(f:Fixture):Record<string,Row>{const w=f.seeded.alpha.workspaceId,u=f.seeded.alpha.admin.userId;return {
 sourcing_experiments:{workspace_id:w,id:id(1),status:'accepted'},
 sourcing_experiment_revisions:{workspace_id:w,id:id(1),revision:1,content:'{}',report:'{}',created_by:u},
 sourcing_experiment_activations:{workspace_id:w,id:id(1),revision:1,activation_id:id(2),result:'{}'},
 outreach_email_admission_activation_receipts:{workspace_id:w,id:id(3),owner_user_id:u,control_revision:1,configuration_sha256:'a'.repeat(64),proof:'{}',proof_sha256:'b'.repeat(64)},
 };}
async function prepare(f:Fixture,table:string){const all=rows(f);if(table.startsWith('sourcing_experiment_'))await insert(f,'sourcing_experiments',all['sourcing_experiments']!);return all[table]!;}
const bad=(table:string,constraint:string,patch:Row):Case=>({constraint,run:async f=>insert(f,table,{...await prepare(f,table),...patch})});
const duplicate=(table:string,constraint:string,patch:Row={}):Case=>({constraint,run:async f=>{const row=await prepare(f,table);await insert(f,table,row);return insert(f,table,{...row,...patch});}});
export const ROADMAP_ACTIVATION_CONSTRAINT_CASES:Case[]=[];
for(const [table,checks]of Object.entries({
 sourcing_experiments:{revision_check:{revision:-1},status_check:{status:'live'},workspace_id_fkey:{workspace_id:absent}},
 sourcing_experiment_revisions:{revision_check:{revision:0},content_check:{content:'[]'},report_check:{report:'[]'},workspace_id_id_fkey:{id:absent},workspace_id_created_by_fkey:{created_by:absent}},
 sourcing_experiment_activations:{result_check:{result:'[]'},workspace_id_id_fkey:{id:absent},check:{stop_reason:'without stopped time'}},
})){
 for(const [suffix,patch]of Object.entries(checks))ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(bad(table,`${table}_${suffix}`,patch));
 ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(duplicate(table,`${table}_pkey`));
}
ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(duplicate('sourcing_experiment_activations','sourcing_experiment_one_active',{activation_id:id(4)}));
// Exercise the length arm as well as the JSON-object arm of each storage check.
for(const [table,column,limit]of [['sourcing_experiment_revisions','content',16384],['sourcing_experiment_revisions','report',262144],['sourcing_experiment_activations','result',4096]]as const)ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(bad(table,`${table}_${column}_check`,{[column]:JSON.stringify({text:'x'.repeat(limit)})}));
const receipt='outreach_email_admission_activation_receipts';
for(const [constraint,patch]of [
 ['outreach_email_admission_activation_rece_control_revision_check',{control_revision:0}],
 ['outreach_email_admission_activation__configuration_sha256_check',{configuration_sha256:'invalid'}],
 [`${receipt}_proof_check`,{proof:'[]'}],
 [`${receipt}_proof_check`,{proof:JSON.stringify({text:'x'.repeat(2097152)})}],
 [`${receipt}_proof_sha256_check`,{proof_sha256:'invalid'}],
 [`${receipt}_workspace_id_fkey`,{workspace_id:absent}],
 ['outreach_email_admission_activa_workspace_id_owner_user_id_fkey',{owner_user_id:absent}],
]as const)ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(bad(receipt,constraint,patch));
ROADMAP_ACTIVATION_CONSTRAINT_CASES.push(duplicate(receipt,`${receipt}_pkey`),{constraint:'outreach_admission_activation_receipt_fk',run:f=>insert(f,'outreach_email_admission_settings',{workspace_id:f.seeded.alpha.workspaceId,revision:1,activation_receipt_id:absent})});
async function handoff(f:Fixture):Promise<Row>{const w=f.seeded.alpha.workspaceId,u=f.seeded.alpha.admin.userId;
 await insert(f,'social_accounts',{workspace_id:w,id:id(5),owner_user_id:u,platform:'x',external_id:'manual-constraint',display_name:'Manual',account_kind:'profile'});
 await insert(f,'social_posts',{workspace_id:w,id:id(6),owner_user_id:u});
 await insert(f,'social_post_revisions',{workspace_id:w,post_id:id(6),revision:1,account_id:id(5),text:'Manual post',zone:'UTC'});
 return {workspace_id:w,id:id(7),post_id:id(6),revision:1,fingerprint:'a'.repeat(64),snapshot:'{}',approved_by:u};
}
const manual='social_manual_handoff_approvals';
for(const [constraint,patch]of [
 [`${manual}_revision_check`,{revision:0}],
 [`${manual}_fingerprint_check`,{fingerprint:'invalid'}],
 [`${manual}_snapshot_check`,{snapshot:'[]'}],
 [`${manual}_snapshot_check`,{snapshot:JSON.stringify({text:'x'.repeat(65536)})}],
 ['social_manual_handoff_approva_workspace_id_post_id_revisio_fkey',{post_id:absent}],
 [`${manual}_workspace_id_approved_by_fkey`,{approved_by:absent}],
]as const)ROADMAP_ACTIVATION_CONSTRAINT_CASES.push({constraint,run:async f=>insert(f,manual,{...await handoff(f),...patch})});
for(const [constraint,patch]of [[`${manual}_pkey`,{}],['social_manual_handoff_approva_workspace_id_post_id_revision_key',{id:id(8)}]]as const)ROADMAP_ACTIVATION_CONSTRAINT_CASES.push({constraint,run:async f=>{const row=await handoff(f);await insert(f,manual,row);return insert(f,manual,{...row,...patch});}});
