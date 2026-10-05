import type {SeededCrm} from './crmFixtures.ts';
import type {SessionQueryable} from '../../../db/queryable.ts';
interface Fixture {session:SessionQueryable;crm:SeededCrm;seeded:{alpha:{workspaceId:string}}}
const insert=(f:Fixture,overrides:Record<string,unknown>={})=>{
 const row={workspace_id:f.seeded.alpha.workspaceId,id:'55555555-5555-4555-8555-555555555555',identity_key:'a'.repeat(64),payload:'{}',status:'needs_review',revision:1,...overrides};
 return f.session.query('INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload,status,revision) VALUES($1,$2,$3,$4::jsonb,$5,$6)',Object.values(row));
};
export const SOURCING_CONSTRAINT_CASES=[
 {constraint:'sourcing_search_account_id_check',run:async(f:Fixture)=>{return f.session.query('INSERT INTO sourcing_search_account(id) VALUES(false)');}},
 {constraint:'sourcing_search_account_daily_used_check',run:async(f:Fixture)=>{return f.session.query('INSERT INTO sourcing_search_account(daily_used) VALUES(-1)');}},
 {constraint:'sourcing_search_account_monthly_used_check',run:async(f:Fixture)=>{return f.session.query('INSERT INTO sourcing_search_account(monthly_used) VALUES(-1)');}},
 {constraint:'sourcing_search_account_pkey',run:async(f:Fixture)=>{await f.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');return f.session.query('INSERT INTO sourcing_search_account(id) VALUES(true)');}},
 {constraint:'sourcing_discovery_settings_pkey',run:async(f:Fixture)=>{await f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id) VALUES($1)',[f.seeded.alpha.workspaceId]);return f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id) VALUES($1)',[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_settings_workspace_id_fkey',run:async(f:Fixture)=>{return f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id) VALUES($1)',['99999999-9999-4999-8999-999999999999']);}},
 {constraint:'sourcing_discovery_settings_query_cursor_check',run:async(f:Fixture)=>{return f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,query_cursor) VALUES($1,-1)',[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_attempts_pkey',run:async(f:Fixture)=>{await f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test')",[f.seeded.alpha.workspaceId]);return f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query,day) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test',current_date-1)",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_attempts_workspace_id_day_key',run:async(f:Fixture)=>{await f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test')",[f.seeded.alpha.workspaceId]);return f.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query) VALUES($1,'test','test')",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_attempts_workspace_id_fkey',run:async(f:Fixture)=>{return f.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query) VALUES($1,'test','test')",['99999999-9999-4999-8999-999999999999']);}},
 {constraint:'sourcing_discovery_attempts_query_check',run:async(f:Fixture)=>{return f.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query) VALUES($1,'test',$2)",[f.seeded.alpha.workspaceId,'x'.repeat(401)]);}},
 {constraint:'sourcing_discovery_attempts_state_check',run:async(f:Fixture)=>{return f.session.query("INSERT INTO sourcing_discovery_attempts(workspace_id,query_id,query,state) VALUES($1,'test','test','bad')",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_hits_pkey',run:async(f:Fixture)=>{await f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test')",[f.seeded.alpha.workspaceId]);await f.session.query("INSERT INTO sourcing_discovery_hits(workspace_id,attempt_id,source_url) VALUES($1,'88888888-8888-4888-8888-888888888888','https://example.test/')",[f.seeded.alpha.workspaceId]);return f.session.query("INSERT INTO sourcing_discovery_hits(workspace_id,attempt_id,source_url) VALUES($1,'88888888-8888-4888-8888-888888888888','https://example.test/')",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_hits_workspace_id_fkey',run:async(f:Fixture)=>{await f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test')",[f.seeded.alpha.workspaceId]);return f.session.query("INSERT INTO sourcing_discovery_hits(workspace_id,attempt_id,source_url) VALUES($1,'88888888-8888-4888-8888-888888888888','https://example.test/')",['99999999-9999-4999-8999-999999999999']);}},
 {constraint:'sourcing_discovery_hits_attempt_id_fkey',run:async(f:Fixture)=>{return f.session.query("INSERT INTO sourcing_discovery_hits(workspace_id,attempt_id,source_url) VALUES($1,'99999999-9999-4999-8999-999999999999','https://example.test/')",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_discovery_hits_source_url_check',run:async(f:Fixture)=>{await f.session.query("INSERT INTO sourcing_discovery_attempts(id,workspace_id,query_id,query) VALUES('88888888-8888-4888-8888-888888888888',$1,'test','test')",[f.seeded.alpha.workspaceId]);return f.session.query("INSERT INTO sourcing_discovery_hits(workspace_id,attempt_id,source_url) VALUES($1,'88888888-8888-4888-8888-888888888888',$2)",[f.seeded.alpha.workspaceId,'x'.repeat(501)]);}},
 {constraint:'sourcing_monitoring_status',run:async(f:Fixture)=>{await insert(f);return f.session.query("UPDATE sourcing_candidates SET next_source_check_at=now() WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_candidates_source_check_shape',run:async(f:Fixture)=>{await insert(f);return f.session.query("UPDATE sourcing_candidates SET source_check='[]'::jsonb WHERE workspace_id=$1",[f.seeded.alpha.workspaceId]);}},
 {constraint:'sourcing_candidates_source_check_shape',run:async(f:Fixture)=>{await insert(f);return f.session.query('UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE workspace_id=$1',[f.seeded.alpha.workspaceId,JSON.stringify({text:'a'.repeat(16001)})]);}},
 {constraint:'sourcing_candidates_workspace_id_fkey',run:async(f:Fixture)=>insert(f,{workspace_id:'99999999-9999-4999-8999-999999999999'})},
 {constraint:'sourcing_candidates_identity_key_check',run:async(f:Fixture)=>insert(f,{identity_key:'short'})},
 {constraint:'sourcing_candidates_payload_check',run:async(f:Fixture)=>insert(f,{payload:'[]'})},
 {constraint:'sourcing_candidates_payload_check',run:async(f:Fixture)=>insert(f,{payload:JSON.stringify({text:'a'.repeat(20001)})})},
 {constraint:'sourcing_candidates_status_check',run:async(f:Fixture)=>insert(f,{status:'verified'})},
 {constraint:'sourcing_candidates_revision_check',run:async(f:Fixture)=>insert(f,{revision:0})},
 {constraint:'sourcing_candidates_pkey',run:async(f:Fixture)=>{await insert(f);return insert(f,{identity_key:'b'.repeat(64)});}},
 {constraint:'sourcing_candidates_workspace_id_identity_key_key',run:async(f:Fixture)=>{await insert(f);return insert(f,{id:'66666666-6666-4666-8666-666666666666'});}},
];

const candidateId='55555555-5555-4555-8555-555555555555';
const runId='77777777-7777-4777-8777-777777777777';
const absent='99999999-9999-4999-8999-999999999999';
async function runRow(f:Fixture,overrides:Record<string,unknown>={}) {
 const row={workspace_id:f.seeded.alpha.workspaceId,id:runId,candidate_id:candidateId,candidate_revision:1,
 fingerprint:'c'.repeat(64),prompt_version:'v1',policy_version:'v1',model_name:'test',...overrides};
 const columns=Object.keys(row);
 return f.session.query(`INSERT INTO sourcing_qualification_runs(${columns.join(',')}) VALUES(${columns.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
async function admissionRow(f:Fixture,overrides:Record<string,unknown>={}) {
 const route=(await f.session.query<{id:string}>('SELECT id FROM phone_routes WHERE workspace_id=$1 AND firm_id=$2 LIMIT 1',[f.seeded.alpha.workspaceId,f.crm.alpha.firmId])).rows[0];
 if(!route)throw new Error('Missing fixture route');
 const row={workspace_id:f.seeded.alpha.workspaceId,candidate_id:candidateId,run_id:runId,firm_id:f.crm.alpha.firmId,route_id:route.id,...overrides};
 return f.session.query(`INSERT INTO sourcing_admissions(${Object.keys(row).join(',')}) VALUES($1,$2,$3,$4,$5)`,Object.values(row));
}
const qualificationChecks:readonly [string,Record<string,unknown>][]=[
 ['candidate_revision_check',{candidate_revision:0}],['fingerprint_check',{fingerprint:'bad'}],
 ['prompt_version_check',{prompt_version:''}],['policy_version_check',{policy_version:''}],
 ['state_check',{state:'approved'}],['reason_check',{reason:''}],
 ['observations_check',{observations:'{}'}],['observations_check',{observations:JSON.stringify(['x'.repeat(131073)])}],
 ['facts_check',{facts:'{}'}],['facts_check',{facts:JSON.stringify(['x'.repeat(65537)])}],
 ['verdict_check',{verdict:'[]'}],['verdict_check',{verdict:JSON.stringify({text:'x'.repeat(8193)})}],
 ['opening_question_check',{opening_question:'x'.repeat(241)}],
];
SOURCING_CONSTRAINT_CASES.push(
 {constraint:'sourcing_admission_reason',run:async(f:Fixture)=>{await insert(f);return runRow(f,{admission_reason:''});}},
 {constraint:'sourcing_owner_membership',run:async(f:Fixture)=>f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,owner_user_id) VALUES($1,$2)',[f.seeded.alpha.workspaceId,absent])},
 ...qualificationChecks.map(([name,overrides])=>({constraint:`sourcing_qualification_runs_${name}`,run:async(f:Fixture)=>{await insert(f);return runRow(f,overrides);}})),
 {constraint:'sourcing_qualification_deadline',run:async(f:Fixture)=>{await insert(f);return runRow(f,{deadline_at:'2000-01-01'});}},
 {constraint:'sourcing_qualification_runs_workspace_id_candidate_id_fkey',run:async(f:Fixture)=>runRow(f)},
 {constraint:'sourcing_qualification_runs_pkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return runRow(f,{fingerprint:'d'.repeat(64)});}},
 {constraint:'sourcing_qualification_runs_workspace_id_candidate_id_finge_key',run:async(f:Fixture)=>{await insert(f);await runRow(f);return runRow(f,{id:absent});}},
 // The triple unique key overlaps the primary key; the primary key rejects duplicates first.
 {constraint:'sourcing_qualification_candidate_run',run:async(f:Fixture)=>{await f.session.query('ALTER TABLE sourcing_qualification_runs DROP CONSTRAINT sourcing_qualification_runs_pkey');await insert(f);await runRow(f);return runRow(f,{fingerprint:'d'.repeat(64)});}},
 {constraint:'sourcing_admissions_pkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);await admissionRow(f);return admissionRow(f);}},
 {constraint:'sourcing_admissions_workspace_id_candidate_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{candidate_id:absent});}},
 {constraint:'sourcing_admissions_candidate_run',run:async(f:Fixture)=>{await insert(f);await runRow(f);await insert(f,{id:absent,identity_key:'b'.repeat(64)});return admissionRow(f,{candidate_id:absent});}},
 {constraint:'sourcing_admissions_workspace_id_firm_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{firm_id:absent});}},
 {constraint:'sourcing_admissions_workspace_id_route_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{route_id:absent});}},
);
