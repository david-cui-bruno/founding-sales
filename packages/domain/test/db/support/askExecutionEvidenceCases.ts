import {randomUUID} from 'node:crypto';
import type {SqlParameter} from '../../../db/queryable.ts';
import type {CallToBookingFixture} from './callToBookingCases.ts';
import {seedAskRequest} from './askAnswerCases.ts';
type Fixture=CallToBookingFixture;type Row=Record<string,SqlParameter>;
const missing='00000000-0000-4000-8000-000000005580';
async function insert(f:Fixture,table:string,row:Row){const keys=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES(${keys.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));}
async function source(f:Fixture){return {workspace_id:f.seeded.alpha.workspaceId,request_id:await seedAskRequest(f,{execution_version:'agent_v1',original_agent_scope:JSON.stringify({kind:'business'})}),request_version:1,request_epoch:1,source_kind:'selected_note',source_id:randomUUID(),source_revision:1,source_hash:'a'.repeat(64),context_snapshot:JSON.stringify({personId:null,firmIds:[],relationships:[],review:'current'}),original_access_closure:JSON.stringify({firmIds:[],personIds:[]})};}
async function record(f:Fixture){return {workspace_id:f.seeded.alpha.workspaceId,request_id:await seedAskRequest(f,{execution_version:'agent_v1',original_agent_scope:JSON.stringify({kind:'business'})}),request_version:1,request_epoch:1,record_kind:'firm',record_id:randomUUID(),record_snapshot:'{}'};}
const cases:{constraint:string;run(f:Fixture):Promise<unknown>}[]=[];
for(const [column,value]of Object.entries({request_version:0,request_epoch:0,source_kind:'bad',source_revision:0,source_hash:'bad',admission_ordinal:0,context_snapshot:'{}',original_access_closure:'{}'}))cases.push({constraint:`crm_ask_admitted_sources_${column}_check`,run:async f=>insert(f,'crm_ask_admitted_sources',{...await source(f),[column]:value})});
for(const [column,value]of Object.entries({request_version:0,request_epoch:0,record_kind:'bad',record_snapshot:'[]'}))cases.push({constraint:`crm_ask_admitted_records_${column}_check`,run:async f=>insert(f,'crm_ask_admitted_records',{...await record(f),[column]:value})});
for(const [table,make]of [['crm_ask_admitted_sources',source],['crm_ask_admitted_records',record]]as const){
 cases.push({constraint:`${table}_workspace_id_request_id_fkey`,run:async f=>insert(f,table,{...await make(f),request_id:missing})});
 cases.push({constraint:`${table}_pkey`,run:async f=>{const value=await make(f);await insert(f,table,value);return insert(f,table,value);}});
 cases.push({constraint:table==='crm_ask_admitted_sources'?'crm_ask_admitted_source_current':'crm_ask_admitted_record_current',run:async f=>insert(f,table,{...await make(f),request_epoch:2})});
}
cases.push({constraint:'crm_ask_admitted_source_order',run:async f=>{const value=await source(f);await insert(f,'crm_ask_admitted_sources',value);return insert(f,'crm_ask_admitted_sources',{...value,source_id:randomUUID()});}});
cases.push({constraint:'crm_ask_requests_clarification_check',run:f=>seedAskRequest(f,{clarification:'[]'})});
cases.push({constraint:'crm_ask_clarification_redacted',run:f=>seedAskRequest(f,{state:'stale',question:null,result:null,result_at:null,clarification:'{}'})});
async function dependency(f:Fixture){return {workspace_id:f.seeded.alpha.workspaceId,request_id:await seedAskRequest(f),parent_request_id:await seedAskRequest(f,{state:'complete',created_at:new Date('2000-01-01T00:00:00Z'),result:JSON.stringify({answeredAt:'2000-01-01T00:00:00Z',claims:[],conflicts:[],missingEvidence:[],abstained:true,coverage:{acquisition:'unverified',semantic:'unverified',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:null}}),result_at:new Date()}),parent_version:1,parent_epoch:1};}
for(const [column,value]of Object.entries({parent_version:0,parent_epoch:0}))cases.push({constraint:`crm_ask_history_dependencies_${column}_check`,run:async f=>insert(f,'crm_ask_history_dependencies',{...await dependency(f),[column]:value})});
for(const column of ['request_id','parent_request_id'])cases.push({constraint:column==='request_id'?'crm_ask_history_child_fkey':'crm_ask_history_parent_fkey',run:async f=>insert(f,'crm_ask_history_dependencies',{...await dependency(f),[column]:missing})});
cases.push({constraint:'crm_ask_history_dependencies_pkey',run:async f=>{const value=await dependency(f);await insert(f,'crm_ask_history_dependencies',value);return insert(f,'crm_ask_history_dependencies',value);}});
cases.push({constraint:'crm_ask_history_dependencies_check',run:async f=>{const value=await dependency(f);return insert(f,'crm_ask_history_dependencies',{...value,parent_request_id:value.request_id});}});
cases.push({constraint:'crm_ask_history_dependency_current',run:async f=>insert(f,'crm_ask_history_dependencies',{...await dependency(f),parent_epoch:2})});
cases.push({constraint:'crm_ask_history_dependency_current',run:async f=>{const value=await dependency(f);const other=await seedAskRequest(f,{owner_user_id:f.seeded.alpha.admin.userId,state:'complete',created_at:new Date('2000-01-01T00:00:00Z'),result:JSON.stringify({answeredAt:'2000-01-01T00:00:00Z',claims:[],conflicts:[],missingEvidence:[],abstained:true,coverage:{acquisition:'unverified',semantic:'unverified',input:'complete',sourceCeiling:10,windowCeiling:1000,groupCeiling:10,evaluationFingerprint:null}}),result_at:new Date()});return insert(f,'crm_ask_history_dependencies',{...value,parent_request_id:other});}});
export const ASK_EXECUTION_EVIDENCE_CONSTRAINT_CASES=cases;
