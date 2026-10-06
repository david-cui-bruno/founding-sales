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
 {constraint:'sourcing_discovery_settings_qualification_evaluation_check',run:async(f:Fixture)=>f.session.query("INSERT INTO sourcing_discovery_settings(workspace_id,qualification_evaluation) VALUES($1,'[]')",[f.seeded.alpha.workspaceId])},
 {constraint:'sourcing_owner_membership',run:async(f:Fixture)=>f.session.query('INSERT INTO sourcing_discovery_settings(workspace_id,owner_user_id) VALUES($1,$2)',[f.seeded.alpha.workspaceId,absent])},
 ...qualificationChecks.map(([name,overrides])=>({constraint:`sourcing_qualification_runs_${name}`,run:async(f:Fixture)=>{await insert(f);return runRow(f,overrides);}})),
 {constraint:'sourcing_qualification_deadline',run:async(f:Fixture)=>{await insert(f);return runRow(f,{deadline_at:'2000-01-01'});}},
 {constraint:'sourcing_qualification_runs_workspace_id_candidate_id_fkey',run:async(f:Fixture)=>runRow(f)},
 {constraint:'sourcing_qualification_runs_pkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return runRow(f,{fingerprint:'d'.repeat(64)});}},
 {constraint:'sourcing_qualification_runs_workspace_id_candidate_id_finge_key',run:async(f:Fixture)=>{await insert(f);await runRow(f);return runRow(f,{id:absent});}},
 // The triple unique key overlaps the primary key; the primary key rejects duplicates first.
 {constraint:'sourcing_qualification_candidate_run',run:async(f:Fixture)=>{await f.session.query('ALTER TABLE sourcing_attributions DROP CONSTRAINT sourcing_attributions_workspace_id_run_id_fkey');await f.session.query('ALTER TABLE sourcing_qualification_runs DROP CONSTRAINT sourcing_qualification_runs_pkey');await insert(f);await runRow(f);return runRow(f,{fingerprint:'d'.repeat(64)});}},
 {constraint:'sourcing_admissions_pkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);await admissionRow(f);return admissionRow(f);}},
 {constraint:'sourcing_admissions_workspace_id_candidate_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{candidate_id:absent});}},
 {constraint:'sourcing_admissions_candidate_run',run:async(f:Fixture)=>{await insert(f);await runRow(f);await insert(f,{id:absent,identity_key:'b'.repeat(64)});return admissionRow(f,{candidate_id:absent});}},
 {constraint:'sourcing_admissions_workspace_id_firm_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{firm_id:absent});}},
 {constraint:'sourcing_admissions_workspace_id_route_id_fkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);return admissionRow(f,{route_id:absent});}},
);

async function feedbackRow(f:Fixture,overrides:Record<string,unknown>={}) {
 const row={workspace_id:f.seeded.alpha.workspaceId,id:absent,candidate_id:candidateId,run_id:runId,code:'real_pain',...overrides};
 return f.session.query(`INSERT INTO sourcing_feedback(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
SOURCING_CONSTRAINT_CASES.push(
 {constraint:'sourcing_feedback_code',run:async(f:Fixture)=>{await insert(f);await runRow(f);return feedbackRow(f,{code:'bad'});}},
 {constraint:'sourcing_feedback_note',run:async(f:Fixture)=>{await insert(f);await runRow(f);return feedbackRow(f,{note:'x'.repeat(501)});}},
 {constraint:'sourcing_feedback_run',run:async(f:Fixture)=>feedbackRow(f)},
 {constraint:'sourcing_feedback_pkey',run:async(f:Fixture)=>{await insert(f);await runRow(f);await feedbackRow(f);return feedbackRow(f);}},
);

const attributionId='66666666-6666-4666-8666-666666666666';
async function learningRow(f:Fixture,table:string,overrides:Record<string,unknown>={}){
 const base:Record<string,Record<string,unknown>>={
  sourcing_attributions:{workspace_id:f.seeded.alpha.workspaceId,id:attributionId,firm_id:f.crm.alpha.firmId,source_key:'test',hypothesis:'unknown',policy_version:'v1',acquisition:'unknown'},
  sourcing_interactions:{workspace_id:f.seeded.alpha.workspaceId,id:absent,attribution_id:attributionId,kind:'call',subject_id:runId,source_revision:0,occurred_at:new Date()},
  sourcing_first_touches:{workspace_id:f.seeded.alpha.workspaceId,firm_id:f.crm.alpha.firmId,attribution_id:attributionId,occurred_at:new Date()},
 };
 const row={...base[table],...overrides},keys=Object.keys(row);
 return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
SOURCING_CONSTRAINT_CASES.push(
 ...([
  ['sourcing_attribution_acquisition',{acquisition:'invented'}],['sourcing_attribution_codes',{hypothesis:''}],
  ['sourcing_attributions_workspace_id_firm_id_fkey',{firm_id:absent}],
  ['sourcing_attributions_workspace_id_candidate_id_fkey',{candidate_id:absent}],
  ['sourcing_attributions_workspace_id_run_id_fkey',{run_id:absent}],
 ] as [string,Record<string,unknown>][]).map(([constraint,overrides])=>({constraint,run:async(f:Fixture)=>learningRow(f,'sourcing_attributions',overrides)})),
 {constraint:'sourcing_attributions_pkey',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');return learningRow(f,'sourcing_attributions',{source_key:'other'});}},
 {constraint:'sourcing_attributions_workspace_id_firm_id_source_key_key',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');return learningRow(f,'sourcing_attributions',{id:absent});}},
 ...([
  ['sourcing_interaction_kind',{kind:'unknown'}],['sourcing_interaction_revision',{source_revision:-1}],
  ['sourcing_interactions_workspace_id_attribution_id_fkey',{attribution_id:runId}],
 ] as [string,Record<string,unknown>][]).map(([constraint,overrides])=>({constraint,run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');return learningRow(f,'sourcing_interactions',overrides);}})),
 {constraint:'sourcing_interactions_pkey',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');await learningRow(f,'sourcing_interactions');return learningRow(f,'sourcing_interactions',{source_revision:1});}},
 {constraint:'sourcing_interactions_workspace_id_kind_subject_id_source_r_key',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');await learningRow(f,'sourcing_interactions');return learningRow(f,'sourcing_interactions',{id:runId});}},
 {constraint:'sourcing_first_touches_pkey',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');await learningRow(f,'sourcing_first_touches');return learningRow(f,'sourcing_first_touches');}},
 {constraint:'sourcing_first_touches_workspace_id_firm_id_fkey',run:async(f:Fixture)=>{await learningRow(f,'sourcing_attributions');return learningRow(f,'sourcing_first_touches',{firm_id:absent});}},
 {constraint:'sourcing_first_touches_workspace_id_attribution_id_fkey',run:async(f:Fixture)=>learningRow(f,'sourcing_first_touches')},
);
async function meetingQualificationRow(f:Fixture,overrides:Record<string,unknown>={}){
 await f.session.query(`INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'qualification-constraint','qualification-constraint','booked',now(),now(),now()) ON CONFLICT DO NOTHING`,[f.seeded.alpha.workspaceId,runId,f.crm.alpha.firmId]);
 const member=(await f.session.query<{user_id:string}>('SELECT user_id FROM workspace_memberships WHERE workspace_id=$1 LIMIT 1',[f.seeded.alpha.workspaceId])).rows[0]!;
 const row={workspace_id:f.seeded.alpha.workspaceId,meeting_id:runId,firm_id:f.crm.alpha.firmId,revision:1,buying_participant:'unknown',maintenance_need:'unknown',open_to_paying:'unknown',evidence:'[]',command_id:'qualification-test',created_by_user_id:member.user_id,...overrides};
 return f.session.query(`INSERT INTO meeting_qualification_revisions(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
}
SOURCING_CONSTRAINT_CASES.push(
 ...([
  ['meeting_qualification_revision',{revision:0}],['meeting_qualification_answers',{maintenance_need:'maybe'}],
  ['meeting_qualification_evidence',{evidence:'{}'}],['meeting_qualification_command',{command_id:'not a command'}],
  ['meeting_qualification_revisio_workspace_id_meeting_id_firm_fkey',{meeting_id:absent}],
  ['meeting_qualification_revisio_workspace_id_created_by_user_fkey',{created_by_user_id:absent}],
 ] as [string,Record<string,unknown>][]).map(([constraint,overrides])=>({constraint,run:async(f:Fixture)=>meetingQualificationRow(f,overrides)})),
 {constraint:'meeting_qualification_revisions_pkey',run:async(f:Fixture)=>{await meetingQualificationRow(f);return meetingQualificationRow(f,{command_id:'another'});}},
 {constraint:'meeting_qualification_revisions_workspace_id_command_id_key',run:async(f:Fixture)=>{await meetingQualificationRow(f);return meetingQualificationRow(f,{revision:2});}},
);
