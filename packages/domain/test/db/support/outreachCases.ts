import type {SessionQueryable} from '../../../db/queryable.ts';
import type {TwoWorkspaces} from './fixtures.ts';
import type {SeededCrm} from './crmFixtures.ts';
import type {SeededMail} from './mailFixtures.ts';
import type {SeededOutbound} from './outboundFixtures.ts';
type Fixture={session:SessionQueryable;seeded:TwoWorkspaces;crm:SeededCrm;mail:SeededMail;outbound:SeededOutbound};
type Case={constraint:string;run:(f:Fixture)=>Promise<unknown>};
const missing='99999999-9999-4999-8999-999999999999',id='77777777-2222-4222-8222-222222222222',runId='77777777-3333-4333-8333-333333333333';
const insert=(f:Fixture,table:string,row:Record<string,unknown>)=>f.session.query(`INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES(${Object.keys(row).map((_,i)=>`$${i+1}`).join(',')})`,Object.values(row));
const auth=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'gmail_prospecting_authorizations',{workspace_id:f.seeded.alpha.workspaceId,mailbox_id:f.mail.alpha.mailboxId,owner_user_id:f.seeded.alpha.salesperson.userId,provider_account_id:'fixture-google',email_address:'owner@example.test',revision:1,enabled:false,basis:'owner_reported_google_permission',reported_by:f.seeded.alpha.admin.userId,revoked_at:new Date(),...change});
const fence=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_fence_authorizations',{workspace_id:f.seeded.alpha.workspaceId,fence_id:f.outbound.alpha.preparedFenceId,mailbox_id:f.mail.alpha.mailboxId,authorization_revision:1,...change});
const parent=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_answer_blocks',{workspace_id:f.seeded.alpha.workspaceId,id,current_version:1,...change});
const block=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_answer_block_versions',{workspace_id:f.seeded.alpha.workspaceId,block_id:id,version:1,kind:'product',text:'Approved product fact',created_by:f.seeded.alpha.admin.userId,...change});
async function sourceFixture(f:Fixture){
 await insert(f,'sourcing_candidates',{workspace_id:f.seeded.alpha.workspaceId,id,identity_key:'f'.repeat(64),payload:'{}',status:'needs_review',revision:1});
 await insert(f,'sourcing_qualification_runs',{workspace_id:f.seeded.alpha.workspaceId,id:runId,candidate_id:id,candidate_revision:1,fingerprint:'e'.repeat(64),prompt_version:'fixture',policy_version:'fixture',model_name:'fixture'});
}
const source=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_email_sources',{workspace_id:f.seeded.alpha.workspaceId,candidate_id:id,run_id:runId,firm_id:f.crm.alpha.firmId,contact_id:f.crm.alpha.contactId,route_id:f.outbound.alpha.routeId,observation_id:id,block_id:'contact',identity_kind:'role',reviewed:true,...change});
export const OUTREACH_CONSTRAINT_CASES:Case[]=[];
function bad(table:string,rows:[string,Record<string,unknown>][],write:(f:Fixture,c:Record<string,unknown>)=>Promise<unknown>,prepare?:(f:Fixture)=>Promise<unknown>){for(const [suffix,change] of rows)OUTREACH_CONSTRAINT_CASES.push({constraint:`${table}_${suffix}`,run:async f=>{await prepare?.(f);return write(f,change);}});}
bad('gmail_prospecting_authorizations',[
 ['provider_account_id_check',{provider_account_id:''}],['email_address_check',{email_address:''}],['revision_check',{revision:0}],['basis_check',{basis:'unverified'}],['workspace_id_mailbox_id_fkey',{mailbox_id:missing}],['workspace_id_reported_by_fkey',{reported_by:missing}],
],auth);
OUTREACH_CONSTRAINT_CASES.push({constraint:'prospecting_authorization_state',run:f=>auth(f,{enabled:true})},{constraint:'gmail_prospecting_authorizations_pkey',run:async f=>{await auth(f);return auth(f);}});
bad('outreach_fence_authorizations', [['authorization_revision_check',{authorization_revision:0}],['workspace_id_fence_id_fkey',{fence_id:missing}],['workspace_id_mailbox_id_fkey',{mailbox_id:missing}]],fence,auth);
OUTREACH_CONSTRAINT_CASES.push({constraint:'outreach_fence_authorizations_pkey',run:async f=>{await auth(f);await fence(f);return fence(f);}});
bad('outreach_answer_blocks',[['workspace_id_fkey',{workspace_id:missing}],['current_version_check',{current_version:0}]],parent);
OUTREACH_CONSTRAINT_CASES.push({constraint:'outreach_answer_blocks_pkey',run:async f=>{await parent(f);return parent(f);}});
bad('outreach_answer_block_versions', [['version_check',{version:0}],['kind_check',{kind:'discount'}],['text_check',{text:''}],['workspace_id_block_id_fkey',{block_id:missing}],['workspace_id_created_by_fkey',{created_by:missing}],['workspace_id_approved_by_fkey',{approved_by:missing,approved_at:new Date()}]],block,parent);
OUTREACH_CONSTRAINT_CASES.push({constraint:'answer_block_approval_pair',run:async f=>{await parent(f);return block(f,{approved_at:new Date()});}},{constraint:'outreach_answer_block_versions_pkey',run:async f=>{await parent(f);await block(f);return block(f);}});
bad('outreach_email_sources', [['block_id_check',{block_id:''}],['identity_kind_check',{identity_kind:'guessed'}],['workspace_id_candidate_id_run_id_fkey',{run_id:missing}],['workspace_id_firm_id_fkey',{firm_id:missing}],['workspace_id_contact_id_fkey',{contact_id:missing}],['workspace_id_route_id_fkey',{route_id:missing}]],source,sourceFixture);
OUTREACH_CONSTRAINT_CASES.push({constraint:'outreach_email_sources_pkey',run:async f=>{await sourceFixture(f);await source(f);return source(f);}});

OUTREACH_CONSTRAINT_CASES.push({constraint:'gmail_prospecting_authorization_workspace_id_owner_user_id_fkey',run:f=>auth(f,{owner_user_id:missing})});

const planId='77777777-4444-4444-8444-444444444444';
const plan=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_plans',{workspace_id:f.seeded.alpha.workspaceId,id:planId,firm_id:f.crm.alpha.firmId,contact_id:f.crm.alpha.contactId,owner_user_id:f.seeded.alpha.salesperson.userId,mailbox_id:f.mail.alpha.mailboxId,candidate_id:id,qualification_run_id:runId,lane:'email_first',state:'stopped',...change});
bad('outreach_plans',[
 ['lane_check',{lane:'social'}],['state_check',{state:'sending'}],['revision_check',{revision:0}],
 ['workspace_id_firm_id_fkey',{firm_id:missing}],['workspace_id_contact_id_firm_id_fkey',{contact_id:missing}],
 ['workspace_id_owner_user_id_fkey',{owner_user_id:missing}],['workspace_id_mailbox_id_fkey',{mailbox_id:missing}],
 ['workspace_id_candidate_id_qualification_run_fkey',{qualification_run_id:missing}],
],plan,sourceFixture);
OUTREACH_CONSTRAINT_CASES.push(
 {constraint:'outreach_plans_pkey',run:async f=>{await sourceFixture(f);await plan(f);return plan(f);}},
 {constraint:'outreach_plans_workspace_id_id_firm_id_key',run:async f=>{await sourceFixture(f);await plan(f);await f.session.query('ALTER TABLE outreach_plans DROP CONSTRAINT outreach_plans_pkey CASCADE');return plan(f);}},
 {constraint:'outreach_plans_one_active_firm',run:async f=>{await sourceFixture(f);await plan(f,{state:'active'});return plan(f,{id:missing,state:'active'});}},
 {constraint:'enrollment_one_authority',run:f=>f.session.query('UPDATE sequence_enrollments SET opportunity_id=NULL WHERE workspace_id=$1',[f.seeded.alpha.workspaceId])},
 {constraint:'enrollment_outreach_firm',run:f=>f.session.query('UPDATE sequence_enrollments SET opportunity_id=NULL,outreach_plan_id=$2 WHERE workspace_id=$1',[f.seeded.alpha.workspaceId,missing])},
 {constraint:'mail_match_one_authority',run:f=>f.session.query('UPDATE mail_message_matches SET opportunity_id=NULL WHERE workspace_id=$1',[f.seeded.alpha.workspaceId])},
 {constraint:'mail_match_outreach_firm',run:f=>f.session.query('UPDATE mail_message_matches SET opportunity_id=NULL,outreach_plan_id=$2 WHERE workspace_id=$1',[f.seeded.alpha.workspaceId,missing])},
 {constraint:'mail_message_matches_one_per_outreach',run:async f=>{await sourceFixture(f);await plan(f);const row={workspace_id:f.seeded.alpha.workspaceId,mail_message_id:f.mail.alpha.messageId,firm_id:f.crm.alpha.firmId,outreach_plan_id:planId,contact_id:f.crm.alpha.contactId,match_rule:'participant',ambiguous:false};await insert(f,'mail_message_matches',row);return insert(f,'mail_message_matches',row);}},
);
for(const [constraint,outreachPlanId] of [['reply_confirmation_one_authority',null],['reply_confirmation_outreach_firm',missing]] as const){
 OUTREACH_CONSTRAINT_CASES.push({constraint,run:f=>insert(f,'mail_reply_confirmations',{workspace_id:f.seeded.alpha.workspaceId,mail_message_id:f.mail.alpha.messageId,firm_id:f.crm.alpha.firmId,opportunity_id:null,outreach_plan_id:outreachPlanId,disposition:'interested',suggested_by:'none',corrected:true,confirmed_by_user_id:f.seeded.alpha.admin.userId})});
}
const reservationId='77777777-5555-4555-8555-555555555555';
const touch=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_touch_reservations',{workspace_id:f.seeded.alpha.workspaceId,id:reservationId,plan_id:planId,firm_id:f.crm.alpha.firmId,action_id:'fixture',channel:'email',ordinal:1,local_date:'2026-10-05',claimed_at:'2026-10-05T14:00:00Z',...change});
const touchFixture=async(f:Fixture)=>{await sourceFixture(f);await plan(f);};
bad('outreach_touch_reservations',[
 ['action_id_check',{action_id:''}],['channel_check',{channel:'linkedin'}],['ordinal_check',{ordinal:9}],['skipped_ordinals_check',{skipped_ordinals:[9]}],['state_check',{state:'queued'}],['workspace_id_plan_id_fkey',{plan_id:missing}],['workspace_id_firm_id_fkey',{firm_id:missing}],
],touch,touchFixture);
OUTREACH_CONSTRAINT_CASES.push(
 {constraint:'outreach_cadence_pair',run:async f=>{await sourceFixture(f);return plan(f,{expires_at:new Date()});}},
 {constraint:'outreach_cadence_shape',run:async f=>{await sourceFixture(f);return plan(f,{cadence:'{"version":"wrong"}',expires_at:new Date()});}},
 {constraint:'outreach_touch_settlement',run:async f=>{await touchFixture(f);return touch(f,{state:'accepted'});}},
 {constraint:'outreach_touch_reservations_pkey',run:async f=>{await touchFixture(f);await touch(f);return touch(f);}},
 {constraint:'outreach_touch_reservations_workspace_id_channel_action_id_key',run:async f=>{await touchFixture(f);await touch(f);return touch(f,{id:missing,ordinal:2,local_date:'2026-10-06'});}},
 {constraint:'outreach_touch_one_day',run:async f=>{await touchFixture(f);await touch(f);return touch(f,{id:missing,action_id:'second',ordinal:2});}},
 {constraint:'outreach_touch_one_ordinal',run:async f=>{await touchFixture(f);await touch(f);return touch(f,{id:missing,action_id:'second',local_date:'2026-10-06'});}},
);
const requestId='77777777-6666-4666-8666-666666666666';
const reply=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_reply_requests',{workspace_id:f.seeded.alpha.workspaceId,id:requestId,plan_id:planId,message_id:f.mail.alpha.messageId,original_message_id:f.mail.alpha.messageId,source_hash:'a'.repeat(64),prompt_version:'fixture',model_name:'claude-haiku-4-5',...change});
bad('outreach_reply_requests',[
 ['source_hash_check',{source_hash:'bad'}],['state_check',{state:'sent'}],['revision_check',{revision:0}],['paid_attempts_check',{paid_attempts:3}],['reason_check',{reason:'x'.repeat(201)}],['workspace_id_plan_id_fkey',{plan_id:missing}],['workspace_id_message_id_fkey',{message_id:missing}],
],reply,touchFixture);
OUTREACH_CONSTRAINT_CASES.push(
 {constraint:'outreach_reply_deadline',run:async f=>{await touchFixture(f);return reply(f,{deadline_at:'2000-01-01'});}},
 {constraint:'outreach_reply_decision',run:async f=>{await touchFixture(f);return reply(f,{state:'ready'});}},
 {constraint:'outreach_reply_requests_pkey',run:async f=>{await touchFixture(f);await reply(f);return reply(f);}},
 {constraint:'outreach_reply_requests_workspace_id_original_message_id_key',run:async f=>{await touchFixture(f);await reply(f);return reply(f,{id:missing});}},
 {constraint:'outreach_settings_pkey',run:async f=>{await insert(f,'outreach_settings',{workspace_id:f.seeded.alpha.workspaceId});return insert(f,'outreach_settings',{workspace_id:f.seeded.alpha.workspaceId});}},
 {constraint:'outreach_settings_workspace_id_fkey',run:f=>insert(f,'outreach_settings',{workspace_id:missing})},
 {constraint:'outreach_settings_revision_check',run:f=>insert(f,'outreach_settings',{workspace_id:f.seeded.alpha.workspaceId,revision:0})},
);
const deliveryPermission='77777777-8888-4888-8888-888888888888',deliveryVersion='77777777-9999-4999-8999-999999999999';
async function deliveryFixture(f:Fixture){
 await touchFixture(f);await reply(f);
 const seq=(await f.session.query<{id:string}>('INSERT INTO sequences(workspace_id,name,created_by_user_id) VALUES($1,$2,$3) RETURNING id',[f.seeded.alpha.workspaceId,'Reply constraint fixture',f.seeded.alpha.admin.userId])).rows[0]!.id;
 await insert(f,'sequence_versions',{workspace_id:f.seeded.alpha.workspaceId,id:deliveryVersion,sequence_id:seq,version:1});
 await deliveryPermissionRow(f);
}
const deliveryPermissionRow=(f:Fixture,permissionId=deliveryPermission)=>insert(f,'follow_up_permissions',{workspace_id:f.seeded.alpha.workspaceId,id:permissionId,firm_id:f.crm.alpha.firmId,contact_id:f.crm.alpha.contactId,kind:'request',scope:'routine_reply',mail_message_id:f.mail.alpha.messageId,template_version_id:f.outbound.alpha.templateVersionId,max_steps:1,granted_at:new Date(),expires_at:new Date(Date.now()+3600000),granted_by_user_id:f.seeded.alpha.admin.userId});
const deliveryRow=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_reply_deliveries',{workspace_id:f.seeded.alpha.workspaceId,request_id:requestId,permission_id:deliveryPermission,sequence_version_id:deliveryVersion,template_version_id:f.outbound.alpha.templateVersionId,template_hash:'a'.repeat(64),draft_hash:'b'.repeat(64),thread_id:'thread',reply_to:'message@example.test',reference_ids:[],...change});
bad('outreach_reply_deliveries',[
 ['template_hash_check',{template_hash:'wrong'}],['draft_hash_check',{draft_hash:'wrong'}],['thread_id_check',{thread_id:''}],['reply_to_check',{reply_to:''}],
 ['workspace_id_request_id_fkey',{request_id:missing}],['workspace_id_permission_id_fkey',{permission_id:missing}],['workspace_id_sequence_version_id_fkey',{sequence_version_id:missing}],['workspace_id_template_version_id_fkey',{template_version_id:missing}],['workspace_id_execution_id_fkey',{execution_id:missing}],['workspace_id_fence_id_fkey',{fence_id:missing}],
],deliveryRow,deliveryFixture);
OUTREACH_CONSTRAINT_CASES.push(
 {constraint:'outreach_reply_deliveries_pkey',run:async f=>{await deliveryFixture(f);await deliveryRow(f);return deliveryRow(f);}},
 {constraint:'outreach_reply_deliveries_workspace_id_permission_id_key',run:async f=>{await deliveryFixture(f);await deliveryRow(f);await reply(f,{id:missing,original_message_id:missing});return deliveryRow(f,{request_id:missing});}},
 {constraint:'outreach_reply_sequence',run:f=>insert(f,'outreach_settings',{workspace_id:f.seeded.alpha.workspaceId,reply_sequence_version_id:missing})},
 {constraint:'outreach_settings_booking_url_check',run:f=>insert(f,'outreach_settings',{workspace_id:f.seeded.alpha.workspaceId,booking_url:'http://example.test'})},
);
for(const column of ['execution_id','fence_id'])OUTREACH_CONSTRAINT_CASES.push({constraint:`outreach_reply_deliveries_workspace_id_${column}_key`,run:async f=>{
 await deliveryFixture(f);
 const value=column==='fence_id'?f.outbound.alpha.preparedFenceId:(await f.session.query<{step_execution_id:string}>('SELECT step_execution_id FROM outbound_messages WHERE workspace_id=$1 AND id=$2',[f.seeded.alpha.workspaceId,f.outbound.alpha.preparedFenceId])).rows[0]!.step_execution_id;
 await deliveryRow(f,{[column]:value});await reply(f,{id:missing,original_message_id:missing});await deliveryPermissionRow(f,missing);
 return deliveryRow(f,{request_id:missing,permission_id:missing,[column]:value});
}});

const emailControlVersion='77777777-4444-4444-8444-444444444444';
async function emailControlFixture(f:Fixture){
 await insert(f,'sequences',{workspace_id:f.seeded.alpha.workspaceId,id:emailControlVersion,name:'Email control fixture',created_by_user_id:f.seeded.alpha.admin.userId});
 await insert(f,'sequence_versions',{workspace_id:f.seeded.alpha.workspaceId,id:emailControlVersion,sequence_id:emailControlVersion,version:1});
}
const emailControl=(f:Fixture,change:Record<string,unknown>={})=>insert(f,'outreach_email_admission_settings',{workspace_id:f.seeded.alpha.workspaceId,revision:1,owner_user_id:f.seeded.alpha.salesperson.userId,mailbox_id:f.mail.alpha.mailboxId,sequence_version_id:emailControlVersion,mailbox_binding:'a'.repeat(64),sequence_binding:'b'.repeat(64),...change});
bad('outreach_email_admission_settings',[
 ['revision_check',{revision:0}],['evaluation_check',{evaluation:JSON.stringify({report:'x'.repeat(4097)})}],['mailbox_binding_check',{mailbox_binding:'bad'}],['sequence_binding_check',{sequence_binding:'bad'}],['check',{owner_user_id:null}],['workspace_id_mailbox_id_fkey',{mailbox_id:missing}],
],emailControl,emailControlFixture);
OUTREACH_CONSTRAINT_CASES.push(
 {constraint:'outreach_email_admission_settin_workspace_id_owner_user_id_fkey',run:async f=>{await emailControlFixture(f);return emailControl(f,{owner_user_id:missing});}},
 {constraint:'outreach_email_admission_sett_workspace_id_sequence_versio_fkey',run:async f=>{await emailControlFixture(f);return emailControl(f,{sequence_version_id:missing});}},
 {constraint:'outreach_email_admission_settings_workspace_id_fkey',run:f=>insert(f,'outreach_email_admission_settings',{workspace_id:missing,revision:1})},
 {constraint:'outreach_email_admission_settings_pkey',run:async f=>{await emailControlFixture(f);await emailControl(f);return emailControl(f);}},
);

OUTREACH_CONSTRAINT_CASES.push({constraint:'outreach_admission_enabled_receipt',run:async f=>{
 await emailControlFixture(f);
 const receipt=(await f.session.query<{id:string}>("INSERT INTO outreach_email_admission_activation_receipts(workspace_id,owner_user_id,control_revision,configuration_sha256,proof,proof_sha256) VALUES($1,$2,1,$3,'{}',$4) RETURNING id",[f.seeded.alpha.workspaceId,f.seeded.alpha.admin.userId,'a'.repeat(64),'b'.repeat(64)])).rows[0]!.id;
 // A normal enabled row with a receipt now passes; dropping its receipt must fail.
 await emailControl(f,{enabled:true,activation_receipt_id:receipt});
 return f.session.query('UPDATE outreach_email_admission_settings SET activation_receipt_id=NULL WHERE workspace_id=$1',[f.seeded.alpha.workspaceId]);
}});
