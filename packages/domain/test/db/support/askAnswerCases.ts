import {randomUUID} from 'node:crypto';
import type {SqlParameter} from '../../../db/queryable.ts';
import type {CallToBookingFixture} from './callToBookingCases.ts';
type Fixture=CallToBookingFixture;
type Row=Record<string,SqlParameter>;
interface Case {constraint:string;run(f:Fixture):Promise<unknown>}
const missing='00000000-0000-4000-8000-000000004930',hash='a'.repeat(64);
const closure={firmIds:[],personIds:[]};
const context={personId:null,firmIds:[],relationships:[],review:'current'};
const purposeSnapshot={purpose:'answer',revision:1,endpointId:'catalog-fake',modelVersion:'catalog-v1',accessGrantVersion:'grant-v1',dataHandlingVersion:'data-v1',evaluationFingerprint:hash,processorVersion:'processor-v1',retrievalVersion:'retrieval-v1',answerVersion:'answer-v1',supportVersion:'support-v1',chunkerVersion:'lexical-original-v1',inputTokenPriceMicros:1,outputTokenPriceMicros:1,dailyCeilingCents:100,monthlyCeilingCents:1000};
async function insert(f:Pick<Fixture,'session'>,table:string,row:Row){const columns=Object.keys(row);return f.session.query(`INSERT INTO ${table}(${columns.join(',')}) VALUES(${columns.map((_,index)=>'$'+(index+1)).join(',')}) RETURNING *`,Object.values(row));}
function request(f:Pick<Fixture,'session'|'seeded'>):Row{const sourceId=randomUUID();return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),owner_user_id:f.seeded.alpha.salesperson.userId,version:1,epoch:1,question:'What was promised?',scope:JSON.stringify({sources:[{workspaceId:f.seeded.alpha.workspaceId,sourceId,kind:'selected_note',revision:1,contentHash:hash,locator:null}]}),initial_contexts:JSON.stringify([context]),initial_access_closure:JSON.stringify(closure),state:'pending',reason:null,result:null,result_at:null,purpose_revision:1,evaluation_fingerprint:hash};}
function purpose(f:Fixture):Row{return {workspace_id:f.seeded.alpha.workspaceId,purpose:'answer',revision:1,enabled:false,endpoint_id:'catalog-fake',model_version:'catalog-v1',access_grant_version:'grant-v1',data_handling_version:'data-v1',evaluation_fingerprint:hash,processor_version:'processor-v1',retrieval_version:'retrieval-v1',answer_version:'answer-v1',support_version:'support-v1',chunker_version:'lexical-original-v1',daily_ceiling_cents:100,monthly_ceiling_cents:1000,input_token_price_micros:1,output_token_price_micros:1,approved_by:f.seeded.alpha.admin.userId};}
async function window(f:Fixture):Promise<Row>{const parent=request(f);await insert(f,'crm_ask_requests',parent);const scope=JSON.parse(String(parent['scope'])) as {sources:{sourceId:string}[]};return {workspace_id:f.seeded.alpha.workspaceId,request_id:parent['id']!,id:randomUUID(),request_version:1,request_epoch:1,ordinal:1,source_kind:'selected_note',source_id:scope.sources[0]!.sourceId,source_revision:1,source_hash:hash,locator:'text:0:4',parser_version:'canonical-original-v1',chunker_version:'lexical-original-v1',context_hash:hash,text_hash:hash,group_hash:hash,context_snapshot:JSON.stringify(context),original_access_closure:JSON.stringify(closure)};}
async function financial(f:Pick<Fixture,'session'|'seeded'>):Promise<Row>{const parent=request(f);await insert(f,'crm_ask_requests',parent);const reservationId=randomUUID(),jobId=randomUUID();await insert(f,'provider_reservations',{workspace_id:f.seeded.alpha.workspaceId,id:reservationId,provider_key:'catalog-fake',subject_kind:'crm_ask_answer',subject_id:parent['id']!,attempt:1,business_date:'2026-10-09',business_time_zone:'Etc/UTC',cents:1,model_name:'catalog-v1',max_input_tokens:1000,max_output_tokens:100});await insert(f,'jobs',{workspace_id:f.seeded.alpha.workspaceId,id:jobId,kind:'crm.ask_answer',payload:'{}',idempotency_key:randomUUID()});return {workspace_id:f.seeded.alpha.workspaceId,id:randomUUID(),request_id:parent['id']!,request_version:1,request_epoch:1,stage:'answer',attempt:1,reservation_id:reservationId,job_id:jobId,fencing_token:1,purpose_revision:1,purpose_snapshot:JSON.stringify(purposeSnapshot),config_fingerprint:hash,evaluation_fingerprint:hash,authorization_fingerprint:hash,input_hash:hash,input_price_micros:1,output_price_micros:1,max_input_tokens:1000,max_output_tokens:100,dispatch_state:'reserved'};}
const builders:Record<string,(f:Fixture)=>Row|Promise<Row>>={crm_ask_requests:request,crm_ask_purposes:purpose,crm_ask_request_windows:window,crm_ask_financial_receipts:financial};
function bad(constraint:string,table:string,patch:Row):Case{return {constraint,run:async f=>{
 const row={...await builders[table]!(f),...patch};
 if(table==='crm_ask_requests'&&patch['workspace_id']!==undefined){
  const scope=JSON.parse(String(row['scope'])) as {sources:Record<string,unknown>[]};
  for(const source of scope.sources)source['workspaceId']=patch['workspace_id'];
  row['scope']=JSON.stringify(scope);
 }
 return insert(f,table,row);
}};}
const cases:Case[]=[];
for(const [table,fields]of Object.entries({
 crm_ask_requests:{version:0,epoch:0,state:'bad',reason:'bad',purpose_revision:0,evaluation_fingerprint:'bad'},
 crm_ask_purposes:{purpose:'bad',revision:0,endpoint_id:'',model_version:'',access_grant_version:'',data_handling_version:'',evaluation_fingerprint:'bad',processor_version:'',retrieval_version:'',answer_version:'',support_version:'',chunker_version:'',daily_ceiling_cents:0,monthly_ceiling_cents:0,input_token_price_micros:0,output_token_price_micros:0},
 crm_ask_request_windows:{request_version:0,request_epoch:0,ordinal:0,source_kind:'bad',source_revision:0,source_hash:'bad',locator:'',parser_version:'',chunker_version:'',context_hash:'bad',text_hash:'bad',group_hash:'bad',context_snapshot:'[]',original_access_closure:'[]'},
 crm_ask_financial_receipts:{request_version:0,request_epoch:0,stage:'bad',attempt:0,fencing_token:0,purpose_revision:0,config_fingerprint:'bad',evaluation_fingerprint:'bad',authorization_fingerprint:'bad',input_hash:'bad',input_price_micros:0,output_price_micros:0,max_input_tokens:0,max_output_tokens:0,dispatch_state:'bad'},
}))for(const [column,value]of Object.entries(fields))cases.push(bad(`${table}_${column}_check`,table,{[column]:value}));
for(const [table,column,constraint]of [
 ['crm_ask_requests','workspace_id','crm_ask_requests_workspace_id_fkey'],['crm_ask_requests','owner_user_id','crm_ask_requests_workspace_id_owner_user_id_fkey'],
 ['crm_ask_purposes','workspace_id','crm_ask_purposes_workspace_id_fkey'],['crm_ask_purposes','approved_by','crm_ask_purposes_workspace_id_approved_by_fkey'],
 ['crm_ask_request_windows','request_id','crm_ask_request_windows_workspace_id_request_id_fkey'],
 ['crm_ask_financial_receipts','request_id','crm_ask_financial_receipts_workspace_id_request_id_fkey'],['crm_ask_financial_receipts','reservation_id','crm_ask_financial_receipts_workspace_id_reservation_id_fkey'],['crm_ask_financial_receipts','job_id','crm_ask_financial_receipts_workspace_id_job_id_fkey'],
]as const)cases.push(bad(constraint,table,{[column]:missing}));
cases.push(bad('crm_ask_request_private_shape','crm_ask_requests',{question:''}),bad('crm_ask_request_result_shape','crm_ask_requests',{result:'{}',result_at:'2026-10-09T00:00:00Z'}));
for(const table of Object.keys(builders))cases.push({constraint:`${table}_pkey`,run:async f=>{const row=await builders[table]!(f);await insert(f,table,row);return insert(f,table,row);}});
for(const [table,constraint,patch]of [
 ['crm_ask_request_windows','crm_ask_request_windows_workspace_id_request_id_request_ver_key',{}],
 ['crm_ask_financial_receipts','crm_ask_financial_attempt',{reservation_id:'new'}],
 ['crm_ask_financial_receipts','crm_ask_financial_reservation',{attempt:2}],
]as const)cases.push({constraint,run:async f=>{const row=await builders[table]!(f);await insert(f,table,row);const changes:Row={...patch};if(changes['reservation_id']==='new'){const other=await financial(f);changes['reservation_id']=other['reservation_id']!;}return insert(f,table,{...row,...changes,id:randomUUID()});}});
cases.push({constraint:'crm_ask_initial_identity_immutable',run:async f=>{const row=request(f);await insert(f,'crm_ask_requests',row);return f.session.query('UPDATE crm_ask_requests SET owner_user_id=$3 WHERE workspace_id=$1 AND id=$2',[row['workspace_id']!,row['id']!,f.seeded.alpha.admin.userId]);}});
// Missing and JSON-null input keys must fail closed rather than SQL CHECK UNKNOWN.
for(const patch of [
 {scope:'{}'}, {scope:'{"sources":null}'}, {scope:'{"sources":[]}'},
 {initial_contexts:'[]'}, {initial_contexts:'[null]'}, {initial_contexts:'[{}]'},
 {initial_access_closure:'null'},
])cases.push(bad('crm_ask_request_private_shape','crm_ask_requests',patch));
for(const field of ['workspaceId','sourceId','kind','revision','contentHash','locator']) {
 for(const mode of ['missing','null'] as const) {
  if(field==='locator'&&mode==='null')continue;
  cases.push({constraint:'crm_ask_request_private_shape',run:async f=>{
   const row=request(f);const scope=JSON.parse(String(row['scope'])) as {sources:Record<string,unknown>[]};
   if(mode==='missing')delete scope.sources[0]![field];else scope.sources[0]![field]=null;
   return insert(f,'crm_ask_requests',{...row,scope:JSON.stringify(scope)});
  }});
 }
}
cases.push({constraint:'crm_ask_request_private_shape',run:async f=>{
 const row=request(f);const scope=JSON.parse(String(row['scope'])) as {sources:Record<string,unknown>[]};
 return insert(f,'crm_ask_requests',{...row,scope:JSON.stringify({sources:[...scope.sources,...scope.sources]}),initial_contexts:JSON.stringify([context,context])});
}});
cases.push(bad('crm_ask_window_current_request','crm_ask_request_windows',{source_id:missing}));
cases.push(bad('crm_ask_financial_purpose_shape','crm_ask_financial_receipts',{purpose_snapshot:JSON.stringify({...purposeSnapshot,question:'A private copied question must not survive deletion.'})}));
for(const field of Object.keys(purposeSnapshot))for(const mode of ['missing','null'] as const)cases.push({constraint:'crm_ask_financial_purpose_shape',run:async f=>{
 const row=await financial(f),snapshot:Record<string,unknown>={...purposeSnapshot};
 if(mode==='missing')delete snapshot[field];else snapshot[field]=null;
 return insert(f,'crm_ask_financial_receipts',{...row,purpose_snapshot:JSON.stringify(snapshot)});
}});
cases.push({constraint:'crm_ask_financial_immutable',run:async f=>{
 const row=await financial(f);await insert(f,'crm_ask_financial_receipts',row);
 return f.session.query('UPDATE crm_ask_financial_receipts SET input_price_micros=2 WHERE workspace_id=$1 AND id=$2',[row['workspace_id']!,row['id']!]);
}});
cases.push(bad('crm_ask_history_revision_positive','crm_ask_requests',{history_revision:0}));
for(const history_title of ['', '   ', 'x'.repeat(101)])cases.push(bad('crm_ask_history_title_bound','crm_ask_requests',{history_title}));
export async function seedAskRequest(f:Pick<Fixture,'session'|'seeded'>){const row=request(f);await insert(f,'crm_ask_requests',row);return String(row['id']);}
export async function seedAskFinancialReceipt(f:Pick<Fixture,'session'|'seeded'>){const row=await financial(f);await insert(f,'crm_ask_financial_receipts',row);return String(row['id']);}
export const ASK_ANSWER_CONSTRAINT_CASES:readonly Case[]=cases;
