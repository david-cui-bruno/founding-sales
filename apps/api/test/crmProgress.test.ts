import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {todayActionsResponseSchema,actionableNotificationsResponseSchema} from '@fss/contracts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import {dispatch} from '../src/server.ts';

it.each(['unique','shared','partial','draft','forward_only','old_sent','newer_request','other_thread','wrong_recipient','mixed_local_case'])('resolves only supported exact-conversation work (%s)',async(scenario)=>{
 const shared=scenario==='shared';
 const resolves=scenario==='unique';
 const fixture=await createAuthFixture();
 try{
  const {workspaceId,admin}=fixture.alpha;
  const firmId=await seedFirm(fixture,{name:'Progress fixture firm',assignedUserId:admin.userId});
  const contactId=await seedContact(fixture,{firmId,fullName:'Morgan Taylor'});
  await fixture.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,technical_validation,eligibility,association_confidence,eligibility_policy_version) VALUES($1,$2,$3,'morgan@example.test','reply',now(),'passed','usable',1,'fixture')",[workspaceId,firmId,contactId]);
  if(shared)await fixture.db.query("INSERT INTO email_addresses(workspace_id,firm_id,address,source,retrieved_at,technical_validation,eligibility,association_confidence,eligibility_policy_version) VALUES($1,$2,'morgan@example.test','reply',now(),'passed','usable',1,'fixture')",[workspaceId,firmId]);
  const opportunityId=(await fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id',[workspaceId,firmId])).rows[0]!.id;
  const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'owner@example.test','google-progress','connected') RETURNING *",[workspaceId,admin.userId])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-progress',$4,1,1,false)",[workspaceId,mailbox.id,admin.userId,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-progress',$4,1,1,true,1,'controlled-full-capture',repeat('b',64),'fixture-grant','fixture-policy','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,admin.userId,binding]);
  const records=[{providerId:'request-a',threadId:'thread-a',at:'2026-09-24T14:00:00Z',sent:false},{providerId:'request-b',threadId:'thread-b',at:'2026-09-24T15:00:00Z',sent:false},{providerId:'sent-a',threadId:'thread-a',at:'2026-09-25T14:00:00Z',sent:true}];
  if(scenario==='old_sent')records[2]!.at='2026-09-23T14:00:00Z';
  if(scenario==='newer_request')records[0]!.at='2026-09-26T14:00:00Z';
  if(scenario==='other_thread')records[2]!.threadId='thread-c';
  const ids=new Map<string,string>();
  const threadIds=new Map<string,string>();
  for(const record of records){
   let conversationId=threadIds.get(record.threadId);
   if(!conversationId){conversationId=(await fixture.db.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Request','[]',$6,'business','fixture','fixture',repeat('a',64)) RETURNING id",[workspaceId,mailbox.id,admin.userId,binding,record.threadId,record.at])).rows[0]!.id;threadIds.set(record.threadId,conversationId);}
   const id=(await fixture.db.query<{id:string}>('INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,matched) VALUES($1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id',[workspaceId,mailbox.id,record.providerId,record.threadId,record.sent?'outgoing':'incoming',record.at,record.sent?'owner@example.test':'morgan@example.test',[record.sent?'morgan@example.test':'owner@example.test']])).rows[0]!.id;
   ids.set(record.providerId,id);
   await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,contact_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",[workspaceId,id,firmId,opportunityId,contactId]);
   if(!record.sent)await fixture.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[workspaceId,id]);
   await enqueueJob(fixture.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:`capture:${record.providerId}`,payload:{mailboxId:mailbox.id,providerMessageId:record.providerId,providerAccountId:'google-progress',generation:1,conversationId,controlsRevision:1,policyRevision:1,decisionRevision:0}});
  }
  const passage='Yes, let us discuss your request.';
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.accountBinding===binding},provider:{read:async input=>{const record=records.find(r=>r.providerId===input.providerMessageId);if(!record)throw new Error('unexpected controlled provider message');return {providerAccountId:'google-progress',messageId:record.providerId,threadId:record.threadId,labels:record.sent?(scenario==='draft'?['SENT','DRAFT']:['SENT']):['INBOX'],origin:record.sent?'sent':'received',providerAt:new Date(record.at).toISOString(),rawSenderDate:null,from:record.sent?'owner@example.test':scenario==='mixed_local_case'?'Morgan@example.test':'morgan@example.test',to:[record.sent?(scenario==='wrong_recipient'?'someone-else@example.test':'morgan@example.test'):'owner@example.test'],cc:[],subject:'Request',body:passage,parserVersion:'controlled-authored-mime-v1',representation:'plain_text',completeness:record.sent&&scenario==='partial'?'partial':'complete',ranges:[{start:0,end:passage.length,kind:record.sent&&scenario==='forward_only'?'forwarded':'authored'}]};}}}});
  await runOnce(fixture.db,{registry,owner:'progress-capture-fixture',limit:20});
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const request=(path:string,body?:unknown)=>dispatch({method:body===undefined?'GET':'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const before=todayActionsResponseSchema.parse((await request('/today/actions')).body);
  expect(before.actions.map(a=>a.actionId).sort()).toEqual([`reply-message:${ids.get('request-a')}`,`reply-message:${ids.get('request-b')}`].sort());
  const notifications=actionableNotificationsResponseSchema.parse((await request('/notifications/actions')).body);
  const first=notifications.items.find(item=>item.actionId===`reply-message:${ids.get('request-a')}`);if(!first)throw new Error('request reminder missing');
  const claimed=await request('/notifications/claim',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,eventKey:first.eventKey});expect(claimed.status).toBe(200);
  const progress=registry.get('crm.mail_progress');
  if(progress){
   await enqueueJob(fixture.db,{workspaceId,kind:progress.kind,idempotencyKey:'project:sent-a',payload:{sourceId:ids.get('sent-a'),sourceRevision:1,contentHash:createHash('sha256').update(passage).digest('hex')}});
   const job=(await claimJobs(fixture.db,{owner:'progress-projection-fixture',kinds:[progress.kind],limit:1,leaseSeconds:120}))[0]!;
   await progress.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  }
  expect(todayActionsResponseSchema.parse((await request('/today/actions')).body).actions.map(a=>a.actionId).sort()).toEqual(resolves?[`reply-message:${ids.get('request-b')}`]:[`reply-message:${ids.get('request-a')}`,`reply-message:${ids.get('request-b')}`].sort());
  if(resolves){const progressRead=await request('/crm/progress/read',{firmId});expect(progressRead.status).toBe(200);expect(progressRead.body).toMatchObject({version:1,events:[{kind:'contacted',occurredAt:'2026-09-25T14:00:00.000Z',source:{sourceId:ids.get('sent-a'),kind:'mail',revision:1}}]});}
  const after=actionableNotificationsResponseSchema.parse((await request('/notifications/actions')).body);
  expect(after.items.some(item=>item.actionId===first.actionId)).toBe(!resolves);
  expect(after.recoveries.find(item=>item.actionId===first.actionId)).toMatchObject({current:!resolves});
 }finally{await fixture.stop();}
});
