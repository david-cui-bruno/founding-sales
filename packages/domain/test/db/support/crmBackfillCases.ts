import type { SessionQueryable } from '../../../db/queryable.ts';
import type { TwoWorkspaces } from './fixtures.ts';
import type { SeededMail } from './mailFixtures.ts';
import type { SeededCrm } from './crmFixtures.ts';
interface Fixture {session:SessionQueryable;seeded:TwoWorkspaces;mail:SeededMail;crm:SeededCrm}
interface Case {constraint:string;run:(f:Fixture)=>Promise<unknown>}
const missing='00000000-0000-4000-8000-000000000000';
const hash='a'.repeat(64);
/** Valid infrastructure rows. Every case runs in its own rolled-back transaction. */
async function seed(f:Fixture,table:string):Promise<void>{
 const w=f.seeded.alpha.workspaceId,m=f.mail.alpha.mailboxId,u=f.seeded.alpha.salesperson.userId;
 await f.session.query("INSERT INTO crm_mail_imports(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,controls_revision,policy_revision,from_at,to_at) VALUES($1,$2,$3,'catalog-account',$4,1,1,1,now()-interval '90 days',now())",[w,m,u,hash]);
 if(table==='crm_mail_imports')return;
 if(table==='crm_mail_import_allocations'){
  await f.session.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,$4,$4,100,100,10,10,1,1,1,1,1,$4,now()+interval '1 hour')",[w,m,u,hash]);return;
 }
 if(table==='crm_mail_sources'){
  const job=(await f.session.query<{id:string}>("INSERT INTO jobs(workspace_id,kind,idempotency_key,payload,not_before) VALUES($1,'crm.mail_capture','backfill-catalog','{}',now()) RETURNING id",[w])).rows[0]!.id;
  const conversation=(await f.session.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'backfill-catalog-thread','Catalog','[]',now(),'uncertain','unclassified_metadata','metadata-v1',$4) RETURNING id",[w,m,u,hash])).rows[0]!.id;
  const identity=(await f.session.query<{id:string}>("INSERT INTO crm_mail_capture_identities(workspace_id,mailbox_id,account_binding,provider_message_id,source_id,lease_fencing_token,job_id,state) VALUES($1,$2,$3,'backfill-catalog-message',$4,1,$5,'blocked') RETURNING id",[w,m,hash,f.mail.alpha.messageId,job])).rows[0]!.id;
  await f.session.query("INSERT INTO crm_mail_sources(workspace_id,source_id,capture_identity_id,source_revision,content_hash,owner_user_id,mailbox_id,provider_account_id,account_binding,acquired_generation,controls_revision,policy_revision,conversation_id,decision_revision,disclosure_version,disclosure_sha256,verification_receipts,parser_version,representation,completeness,passage_ranges,participants,availability) VALUES($1,$2,$3,1,$4,$5,$6,'catalog-account',$4,1,1,1,$7,0,'disclosure-v1',$4,'{}','parser-v1','plain_text','unavailable','[]','[]','awaiting_recapture')",[w,f.mail.alpha.messageId,identity,hash,u,m,conversation]);return;
 }
 const id=(await f.session.query<{id:string}>('SELECT id FROM crm_mail_imports WHERE workspace_id=$1',[w])).rows[0]!.id;
 if(table==='crm_mail_import_slices')await f.session.query('INSERT INTO crm_mail_import_slices(workspace_id,import_id,ordinal,from_epoch_seconds,to_epoch_seconds) VALUES($1,$2,0,0,86400)',[w,id]);
 if(table==='crm_mail_import_read_reservations')await f.session.query("INSERT INTO crm_mail_import_read_reservations(workspace_id,import_id,project_hash,user_hash,allocation_revision,method,units) VALUES($1,$2,$3,$3,1,'metadata',1)",[w,id,hash]);
 if(table==='crm_mail_import_messages')await f.session.query("INSERT INTO crm_mail_import_messages(workspace_id,import_id,message_hash,provider_message_id,provider_thread_id,provider_at,scope,state) VALUES($1,$2,$3,'catalog-message','catalog-thread',now(),'historical','available')",[w,id,hash]);
 if(table==='crm_mail_history_recoveries')await f.session.query("INSERT INTO crm_mail_history_recoveries(workspace_id,import_id,epoch,account_binding,generation,controls_revision,policy_revision,allocation_revision,configuration_hash,from_at) VALUES($1,$2,1,$3,1,1,1,1,$3,now())",[w,id,hash]);
}
function mutation(constraint:string,table:string,changes:Record<string,unknown>,dropShape=false):Case{return {constraint,run:async f=>{
 // Isolate redundant enum/shape guards only when no row can violate one without the other.
 if(dropShape)await f.session.query('ALTER TABLE crm_mail_sources DROP CONSTRAINT crm_mail_original_observation_shape');
 if(constraint==='crm_mail_import_messages_state_check'||constraint==='crm_mail_import_messages_reason_check')await f.session.query('ALTER TABLE crm_mail_import_messages DROP CONSTRAINT crm_mail_import_messages_check');
 if(constraint==='crm_mail_import_allocations_user_limit_units_check')await f.session.query('ALTER TABLE crm_mail_import_allocations DROP CONSTRAINT crm_mail_import_allocations_check');
 if(constraint==='crm_mail_import_allocations_project_limit_units_check')await f.session.query('ALTER TABLE crm_mail_import_allocations DROP CONSTRAINT crm_mail_import_allocations_check1');
 await seed(f,table);
 if(table==='crm_mail_import_allocations')return f.session.query(`UPDATE ${table} SET ${Object.keys(changes).map((key,index)=>`${key}=$${index+2}`).join(',')} WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId,...Object.values(changes)]);
 const distinct:Record<string,unknown>=table==='crm_mail_import_slices'?{ordinal:1}:table==='crm_mail_sources'?{}:{id:missing};
 if(table==='crm_mail_imports')distinct['account_binding']='b'.repeat(64);
 if(table==='crm_mail_history_recoveries')distinct['epoch']=2;
 if(table==='crm_mail_import_messages')distinct['message_hash']='b'.repeat(64);
 if(table==='crm_mail_sources')distinct['source_id']=missing;
 return f.session.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(t)||$2::jsonb)).* FROM ${table} t WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId,JSON.stringify({...distinct,...changes})]);
}};}
const cases:Case[]=[];
function checks(table:string,fields:ReadonlyArray<readonly[string,unknown]>){for(const [field,value]of fields)cases.push(mutation(`${table}_${field}_check`,table,{[field]:value}));}
checks('crm_mail_imports',[['provider_account_id',''],['account_binding','bad'],['generation',0],['controls_revision',0],['policy_revision',0],['state','bad'],['reason','Bad']]);
cases.push(
 mutation('crm_mail_imports_history_anchor_check','crm_mail_imports',{history_anchor:'bad',history_cursor:'100'}),
 mutation('crm_mail_imports_history_cursor_check','crm_mail_imports',{history_anchor:'100',history_cursor:'bad'}),
 mutation('crm_mail_imports_history_page_token_check','crm_mail_imports',{history_anchor:'100',history_cursor:'100',history_page_token:''}),
 mutation('crm_mail_imports_check','crm_mail_imports',{from_at:'2026-10-09T00:00:00Z',to_at:'2026-10-08T00:00:00Z'}),
 mutation('crm_mail_imports_check1','crm_mail_imports',{history_anchor:'100'}),
 mutation('crm_mail_imports_check2','crm_mail_imports',{history_complete:true}),
 mutation('crm_mail_imports_check3','crm_mail_imports',{history_page_token:'page'}),
 mutation('crm_mail_imports_check4','crm_mail_imports',{completed_at:'2026-10-09T00:00:00Z'}),
 mutation('crm_mail_imports_check5','crm_mail_imports',{state:'complete',completed_at:'2026-10-09T00:00:00Z'}),
 mutation('crm_mail_reconciliation_counts','crm_mail_imports',{reconciliation_visited:0,reconciliation_refreshed:1}),
 mutation('crm_mail_imports_workspace_id_mailbox_id_fkey','crm_mail_imports',{mailbox_id:missing}),
 mutation('crm_mail_imports_workspace_id_owner_user_id_fkey','crm_mail_imports',{owner_user_id:missing}),
);
checks('crm_mail_import_slices',[['ordinal',90],['state','bad'],['next_page_token','']]);
cases.push(mutation('crm_mail_import_slices_check','crm_mail_import_slices',{to_epoch_seconds:1}),mutation('crm_mail_import_slices_workspace_id_import_id_fkey','crm_mail_import_slices',{import_id:missing}));
checks('crm_mail_import_allocations',[['revision',0],['account_binding','bad'],['generation',0],['project_hash','bad'],['user_hash','bad'],['user_limit_units',0],['project_limit_units',0],['profile_units',0],['list_units',0],['history_units',0],['metadata_units',0],['body_units',0],['verification_sha256','bad']]);
cases.push(mutation('crm_mail_import_allocations_check','crm_mail_import_allocations',{user_headroom_units:100}),mutation('crm_mail_import_allocations_check1','crm_mail_import_allocations',{project_headroom_units:100}),mutation('crm_mail_import_allocations_workspace_id_mailbox_id_fkey','crm_mail_import_allocations',{mailbox_id:missing}),mutation('crm_mail_import_allocations_workspace_id_owner_user_id_fkey','crm_mail_import_allocations',{owner_user_id:missing}));
checks('crm_mail_import_read_reservations',[['project_hash','bad'],['user_hash','bad'],['allocation_revision',0],['method','bad'],['units',0],['state','bad']]);
cases.push(mutation('crm_mail_import_read_reservations_check','crm_mail_import_read_reservations',{state:'observed'}),mutation('crm_mail_import_read_reservations_workspace_id_import_id_fkey','crm_mail_import_read_reservations',{import_id:missing}));
checks('crm_mail_import_messages',[['message_hash','bad'],['provider_message_id','!'],['provider_thread_id','!'],['scope','bad'],['state','bad'],['reason','bad'],['revision',0]]);
cases.push(mutation('crm_mail_import_messages_check','crm_mail_import_messages',{provider_at:null}),mutation('crm_mail_import_messages_workspace_id_import_id_fkey','crm_mail_import_messages',{import_id:missing}));
checks('crm_mail_history_recoveries',[['history_anchor','bad'],['history_cursor','bad'],['history_page_token',''],['epoch',5],['revision',0],['account_binding','bad'],['generation',0],['controls_revision',0],['policy_revision',0],['allocation_revision',0],['configuration_hash','bad'],['total_days',0],['next_day_ordinal',91],['next_day_page_token',''],['state','bad'],['reason','bad']]);
cases.push(mutation('crm_mail_recovery_scope_shape','crm_mail_history_recoveries',{from_at:null}),mutation('crm_mail_recovery_completion_shape','crm_mail_history_recoveries',{completed_at:'2026-10-09T00:00:00Z'}),mutation('crm_mail_recovery_reason_shape','crm_mail_history_recoveries',{reason:'history_coverage_expired'}),mutation('crm_mail_history_recoveries_workspace_id_import_id_fkey','crm_mail_history_recoveries',{import_id:missing}));
const verified={original_availability:'available',original_observation_revision:1,original_observed_at:'2026-10-09T00:00:00Z',original_observed_generation:1,original_observed_account_binding:hash,original_observation_reason:'verified_metadata'};
for(const [field,value]of [['original_availability','bad'],['original_observation_revision',-1],['original_observed_generation',0],['original_observed_account_binding','bad'],['original_observation_reason','bad']]as const)cases.push(mutation(`crm_mail_sources_${field}_check`,'crm_mail_sources',{...verified,[field]:value},true));
cases.push(mutation('crm_mail_original_observation_shape','crm_mail_sources',{original_availability:'available'}),mutation('crm_mail_deleted_original_observation','crm_mail_sources',{...verified,availability:'deleted'}));
for(const table of ['crm_mail_imports','crm_mail_import_slices','crm_mail_import_allocations','crm_mail_import_read_reservations','crm_mail_import_messages','crm_mail_history_recoveries'])cases.push({constraint:`${table}_pkey`,run:async f=>{await seed(f,table);return f.session.query(`INSERT INTO ${table} SELECT * FROM ${table} WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId]);}});
for(const [table,constraint,change]of [
 ['crm_mail_imports','crm_mail_imports_workspace_id_mailbox_id_account_binding_ge_key',{id:missing}],
 ['crm_mail_import_messages','crm_mail_import_messages_workspace_id_import_id_message_has_key',{id:missing}],
 ['crm_mail_history_recoveries','crm_mail_history_recoveries_workspace_id_import_id_epoch_key',{id:missing}],
]as const)cases.push({constraint,run:async f=>{await seed(f,table);return f.session.query(`INSERT INTO ${table} SELECT (jsonb_populate_record(NULL::${table},to_jsonb(t)||$2::jsonb)).* FROM ${table} t WHERE workspace_id=$1`,[f.seeded.alpha.workspaceId,JSON.stringify(change)]);}});
export const CRM_BACKFILL_CONSTRAINT_CASES:readonly Case[]=cases;
