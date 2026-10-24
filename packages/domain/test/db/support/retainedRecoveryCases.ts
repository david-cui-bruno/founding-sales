import type {SessionQueryable} from '../../../db/queryable.ts';
import type {SeededCrm} from './crmFixtures.ts';
interface Fixture {session:SessionQueryable;crm:SeededCrm;seeded:{alpha:{workspaceId:string}}}
const candidate='81111111-1111-4111-8111-111111111111',original='82222222-2222-4222-8222-222222222222',decision='83333333-3333-4333-8333-333333333333',other='84444444-4444-4444-8444-444444444444';
async function insert(f:Fixture,table:string,row:Record<string,unknown>){
 const columns=Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
async function run(f:Fixture,patch:Record<string,unknown>={}){
 return insert(f,'sourcing_qualification_runs',{workspace_id:f.seeded.alpha.workspaceId,id:original,candidate_id:candidate,candidate_revision:1,fingerprint:'a'.repeat(64),prompt_version:'v1',policy_version:'v1',model_name:'test',...patch});
}
async function seed(f:Fixture){
 await insert(f,'sourcing_candidates',{workspace_id:f.seeded.alpha.workspaceId,id:candidate,identity_key:'e'.repeat(64),payload:'{}'});
 await run(f);
 const member=(await f.session.query<{user_id:string}>('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 LIMIT 1',[f.seeded.alpha.workspaceId])).rows[0]!;
 return {workspace_id:f.seeded.alpha.workspaceId,id:decision,candidate_id:candidate,original_run_id:original,original_revision:1,result_revision:1,reviewer_user_id:member.user_id,observation_id:other,block_id:'identity',content_hash:'a'.repeat(64),relevant_text_hash:'b'.repeat(64),name_start:0,name_end:10};
}
const checks:readonly [string,Record<string,unknown>][]=[
 ['block_id_check',{block_id:''}],['block_id_check',{block_id:'x'.repeat(81)}],
 ['check',{result_revision:0}],['check1',{name_end:0}],['check1',{name_end:2001}],
 ['content_hash_check',{content_hash:'bad'}],['relevant_text_hash_check',{relevant_text_hash:'bad'}],
 ['method_version_check',{method_version:'automatic'}],['name_start_check',{name_start:-1}],['original_revision_check',{original_revision:0}],
];
export const RETAINED_RECOVERY_CONSTRAINT_CASES=[
 ...checks.map(([suffix,patch])=>({constraint:`sourcing_retained_identity_decisions_${suffix}`,run:async(f:Fixture)=>insert(f,'sourcing_retained_identity_decisions',{...await seed(f),...patch})})),
 {constraint:'sourcing_retained_identity_de_workspace_id_candidate_id_or_fkey',run:async(f:Fixture)=>insert(f,'sourcing_retained_identity_decisions',{...await seed(f),original_run_id:other})},
 {constraint:'sourcing_retained_identity_de_workspace_id_reviewer_user_i_fkey',run:async(f:Fixture)=>insert(f,'sourcing_retained_identity_decisions',{...await seed(f),reviewer_user_id:other})},
 {constraint:'sourcing_retained_identity_decisions_pkey',run:async(f:Fixture)=>{const row=await seed(f);await insert(f,'sourcing_retained_identity_decisions',row);return insert(f,'sourcing_retained_identity_decisions',row);}},
 // Isolate the redundant triple key from its earlier primary-key index inside this case's rolled-back transaction.
 {constraint:'sourcing_retained_identity_dec_workspace_id_candidate_id_id_key',run:async(f:Fixture)=>{const row=await seed(f);await f.session.query('ALTER TABLE sourcing_retained_identity_decisions DROP CONSTRAINT sourcing_retained_identity_decisions_pkey');await insert(f,'sourcing_retained_identity_decisions',row);return insert(f,'sourcing_retained_identity_decisions',row);}},
 {constraint:'sourcing_retained_identity_de_workspace_id_candidate_id_ori_key',run:async(f:Fixture)=>{const row=await seed(f);await insert(f,'sourcing_retained_identity_decisions',row);return insert(f,'sourcing_retained_identity_decisions',{...row,id:other});}},
 {constraint:'sourcing_retained_run_decision',run:async(f:Fixture)=>{await seed(f);return run(f,{id:other,fingerprint:'c'.repeat(64),retained_identity_decision_id:decision});}},
 {constraint:'sourcing_retained_one_interpretation',run:async(f:Fixture)=>{await insert(f,'sourcing_retained_identity_decisions',await seed(f));await run(f,{id:other,fingerprint:'c'.repeat(64),retained_identity_decision_id:decision});return run(f,{id:decision,fingerprint:'d'.repeat(64),retained_identity_decision_id:decision});}},
 ...(['sourcing_retained_firm_acquisition_fences_pkey','sourcing_retained_firm_acquisition_fe_workspace_id_firm_id_fkey'] as const).map(constraint=>({constraint,run:async(f:Fixture)=>{
 const row={workspace_id:f.seeded.alpha.workspaceId,firm_id:constraint.endsWith('pkey')?f.crm.alpha.firmId:other,decision_id:decision,candidate_id:candidate};
 if(constraint.endsWith('pkey'))await insert(f,'sourcing_retained_firm_acquisition_fences',row);
 return insert(f,'sourcing_retained_firm_acquisition_fences',row);
 }})),
];
