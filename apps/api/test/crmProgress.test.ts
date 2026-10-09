import {changeSelectedSource,recaptureSelectedSource} from '@fss/domain/crm/people.ts';
import {repositoryContext} from '@fss/domain/db/workspaceScope.ts';
import {setTimeout as delay} from 'node:timers/promises';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {recordingSuppressionJournal} from '@fss/domain/suppression/journal.ts';
import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {todayActionsResponseSchema,actionableNotificationsResponseSchema,crmProgressResponseSchema} from '@fss/contracts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runSchedulerPass} from '../../worker/src/scheduler/schedulerPass.ts';
import {workerDueWorkSources} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import {dispatch} from '../src/server.ts';

it.each(['unique','opt_out','fairness','terminal_delete','copy_delete','scheduled','replied','replied_prerequisite_delete','out_of_order','source_shared','source_race','source_correction','expired_lease','missing_dependency','replay','uncertain_preserve','all_context_acl','shared','partial','draft','forward_only','old_sent','newer_request','provider_newer_request','provider_older_request','other_thread','wrong_recipient','mixed_local_case'])('resolves only supported exact-conversation work (%s)',async(scenario)=>{
 const shared=scenario==='shared';
 const resolves=scenario==='unique'||scenario==='replay'||scenario==='uncertain_preserve'||scenario==='opt_out'||scenario==='terminal_delete'||scenario==='copy_delete'||scenario==='provider_older_request'||scenario==='scheduled';
 const fixture=await createAuthFixture();
 try{
  const {workspaceId}=fixture.alpha;const admin=scenario==='all_context_acl'?fixture.alpha.salesperson:fixture.alpha.admin;
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
  if(scenario==='fairness')for(let index=0;index<98;index++)records.push({providerId:`extra-${index}`,threadId:`extra-thread-${index}`,at:'2026-09-25T15:00:00Z',sent:true});
  if(scenario==='old_sent'||scenario==='replied'||scenario==='replied_prerequisite_delete'||scenario==='out_of_order')records[2]!.at='2026-09-23T14:00:00Z';
  if(scenario==='newer_request'||scenario==='provider_older_request')records[0]!.at='2026-09-26T14:00:00Z';
  if(scenario==='other_thread')records[2]!.threadId='thread-c';
  const ids=new Map<string,string>();
  const threadIds=new Map<string,string>();
  for(const record of records){
   let conversationId=threadIds.get(record.threadId);
   if(!conversationId){conversationId=(await fixture.db.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Request','[]',$6,'business','fixture','fixture',repeat('a',64)) RETURNING id",[workspaceId,mailbox.id,admin.userId,binding,record.threadId,record.at])).rows[0]!.id;threadIds.set(record.threadId,conversationId);}
   const id=(await fixture.db.query<{id:string}>('INSERT INTO mail_messages(id,workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,matched) VALUES($9,$1,$2,$3,$4,$5,$6,$7,$8,true) RETURNING id',[workspaceId,mailbox.id,record.providerId,record.threadId,record.sent?'outgoing':'incoming',record.at,record.sent?'owner@example.test':'morgan@example.test',[record.sent?'morgan@example.test':'owner@example.test'],scenario==='fairness'&&record.providerId==='extra-97'?'ffffffff-ffff-4fff-bfff-ffffffffffff':randomUUID()])).rows[0]!.id;
   ids.set(record.providerId,id);
   await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,contact_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",[workspaceId,id,firmId,opportunityId,contactId]);
   if(!record.sent)await fixture.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[workspaceId,id]);
   if(scenario==='out_of_order'&&record.sent)continue;
   await enqueueJob(fixture.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:`capture:${record.providerId}`,payload:{mailboxId:mailbox.id,providerMessageId:record.providerId,providerAccountId:'google-progress',generation:1,conversationId,controlsRevision:1,policyRevision:1,decisionRevision:0}});
  }
  const passage='Yes, let us discuss your request.';
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.accountBinding===binding},provider:{read:async input=>{const record=records.find(r=>r.providerId===input.providerMessageId);if(!record)throw new Error('unexpected controlled provider message');return {providerAccountId:'google-progress',messageId:record.providerId,threadId:record.threadId,labels:record.sent?(scenario==='draft'?['SENT','DRAFT']:['SENT']):['INBOX'],origin:record.sent?'sent':'received',providerAt:new Date(record.providerId==='request-a'&&scenario==='provider_newer_request'?'2026-09-26T14:00:00Z':record.providerId==='request-a'&&scenario==='provider_older_request'?'2026-09-24T14:00:00Z':record.at).toISOString(),rawSenderDate:null,from:record.sent?'owner@example.test':scenario==='mixed_local_case'?'Morgan@example.test':'morgan@example.test',to:[record.sent?(scenario==='wrong_recipient'?'someone-else@example.test':'morgan@example.test'):'owner@example.test'],cc:[],subject:'Request',body:passage,parserVersion:'controlled-authored-mime-v1',representation:'plain_text',completeness:record.sent&&scenario==='partial'?'partial':'complete',ranges:[{start:0,end:passage.length,kind:record.sent&&scenario==='forward_only'?'forwarded':'authored'}]};}}}});
  await runOnce(fixture.db,{registry,owner:'progress-capture-fixture',limit:100});
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const request=(path:string,body?:unknown)=>dispatch({method:body===undefined?'GET':'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  if(scenario==='all_context_acl'){
   const foreignFirmId=await seedFirm(fixture,{name:'Restricted source context',assignedUserId:fixture.alpha.admin.userId});
   const adminToken=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
   const associated=await dispatch({method:'POST',path:'/crm/business/mail/associate',body:{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId:ids.get('sent-a'),expectedRevision:1,firmId:foreignFirmId},query:new URLSearchParams(),headers:{authorization:`Bearer ${adminToken}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});expect(associated.status).toBe(200);
  }
  if(scenario==='out_of_order'){
   await runSchedulerPass(fixture.db,{sources:workerDueWorkSources(),now:'2026-10-09T15:00:00Z'});await runOnce(fixture.db,{registry,owner:'progress-before-prerequisite',limit:100});
   expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[]});
   await enqueueJob(fixture.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:'capture:sent-a',payload:{mailboxId:mailbox.id,providerMessageId:'sent-a',providerAccountId:'google-progress',generation:1,conversationId:threadIds.get('thread-a'),controlsRevision:1,policyRevision:1,decisionRevision:0}});
   await runOnce(fixture.db,{registry,owner:'progress-late-prerequisite',limit:100});
  }
  let claimEvidence:{personId:string;sourceId:string}|null=null;
  if(scenario==='source_race'||scenario==='source_correction'){
   const command=(fields:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
   const created=await request('/crm/people/create',command({fullName:'Supported endpoint fixture'}));expect(created.status).toBe(200);const personId=(created.body as {result:{personId:string}}).result.personId;
   await fixture.db.query('INSERT INTO crm_legacy_contact_people(workspace_id,contact_id,person_id) VALUES($1,$2,$3)',[workspaceId,contactId,personId]);
   expect((await request('/crm/people/source/add',command({personId,sourceKey:randomUUID(),excerpt:'Selected proof of this endpoint',occurredAt:'2026-09-15T14:00:00.000Z'}))).status).toBe(200);
   const source=((await request('/crm/people/read',{personId})).body as {sources:{sourceId:string;revision:number;contentHash:string}[]}).sources[0]!;
   expect((await request('/crm/endpoints/claim',command({personId,firmId:null,shared:false,kind:'email',value:'morgan@example.test',status:'current',startDate:'2026-09-15',endDate:null,evidence:{sourceId:source.sourceId,sourceRevision:source.revision,contentHash:source.contentHash}}))).status).toBe(200);
   claimEvidence={personId,sourceId:source.sourceId};
  }
  if(scenario==='source_shared'){
   const command=(fields:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
   const added=await request('/crm/firm-sources/add',command({firmId,sourceKey:randomUUID(),excerpt:'This is a shared office email endpoint',occurredAt:'2026-09-15T14:00:00.000Z'}));expect(added.status).toBe(200);
   const sourceId=(added.body as {result:{sourceId:string}}).result.sourceId;
   const sources=(await request('/crm/firm-sources/read',{firmId})).body as {sources:{sourceId:string;revision:number;contentHash:string}[]};const source=sources.sources.find(item=>item.sourceId===sourceId)!;
   const claimed=await request('/crm/endpoints/claim',command({personId:null,firmId,shared:true,kind:'email',value:'morgan@example.test',status:'current',startDate:null,endDate:null,evidence:{sourceId,sourceRevision:source.revision,contentHash:source.contentHash}}));expect(claimed.status).toBe(200);
  }
  if(scenario==='fairness'){
   await runOnce(fixture.db,{registry,owner:'progress-capture-final-fixture',limit:100});
   const created=await request('/crm/people/create',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,fullName:'Late scan fixture'});expect(created.status).toBe(200);
   const personId=(created.body as {result:{personId:string}}).result.personId;
   expect((await request('/crm/business/mail/associate',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId:ids.get('extra-97'),expectedRevision:1,personId})).status).toBe(200);
   for(let pass=0;pass<2;pass++){
    await runSchedulerPass(fixture.db,{sources:workerDueWorkSources(),now:'2026-10-09T15:00:00Z'});await runOnce(fixture.db,{registry,owner:'progress-fairness-fixture',limit:200});
    expect((await request('/crm/progress/read',{personId})).body).toMatchObject({events:pass===0?[]:[{kind:'contacted',source:{sourceId:ids.get('extra-97'),revision:2}}]});
   }
   return;
  }
  if(scenario==='uncertain_preserve'){
   await fixture.db.query("UPDATE mail_message_classifications SET class='uncertain',requires_confirmation=true WHERE workspace_id=$1 AND mail_message_id=$2",[workspaceId,ids.get('request-a')]);
   await fixture.db.query("INSERT INTO active_holds(workspace_id,scope_kind,scope_key,reason_code,blocked_action_kinds,source_event_kind,source_event_id,recovery_action) VALUES($1,'opportunity',$2,'uncertain_reply',ARRAY['email_send','enrollment_advance'],'mail_message',$3,'confirm_reply')",[workspaceId,opportunityId,ids.get('request-a')]);
  }
  const heldCard=scenario==='uncertain_preserve'?(await request('/replies/card',{messageId:ids.get('request-a')})).body:null;
  const before=todayActionsResponseSchema.parse((await request('/today/actions')).body);
  expect(before.actions.map(a=>a.actionId).sort()).toEqual([`reply-message:${ids.get('request-a')}`,`reply-message:${ids.get('request-b')}`].sort());
  const notifications=actionableNotificationsResponseSchema.parse((await request('/notifications/actions')).body);
  const first=notifications.items.find(item=>item.actionId===`reply-message:${ids.get('request-a')}`);if(!first)throw new Error('request reminder missing');
  const claimed=await request('/notifications/claim',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,eventKey:first.eventKey});expect(claimed.status).toBe(200);
  const progress=registry.get('crm.mail_progress');
  if(scenario==='scheduled'||scenario==='replied'||scenario==='replied_prerequisite_delete'||scenario==='out_of_order'){for(let pass=0;pass<(scenario==='out_of_order'?2:1);pass++){await runSchedulerPass(fixture.db,{sources:workerDueWorkSources(),now:'2026-10-09T15:00:00Z'});const ran=await runOnce(fixture.db,{registry,owner:'progress-scheduled-fixture',limit:100});expect(ran.failed).toBe(0);}}
  else if(progress){
   if(scenario==='missing_dependency')await enqueueJob(fixture.db,{workspaceId,kind:progress.kind,idempotencyKey:'project:malformed-missing-dependency',payload:{sourceId:ids.get('sent-a'),sourceRevision:1,contentHash:createHash('sha256').update(passage).digest('hex')}});
   else await runSchedulerPass(fixture.db,{sources:workerDueWorkSources(),now:'2026-10-09T15:00:00Z'});
   const job=(await claimJobs(fixture.db,{owner:'progress-projection-fixture',kinds:[progress.kind],limit:100,leaseSeconds:120})).find(job=>job.payload['sourceId']===ids.get('sent-a'))!;
   if(claimEvidence){
    const holder=await fixture.database.appRuntimeSession(),observer=await fixture.database.appRuntimeSession();
    const pid=(await holder.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    await holder.query('BEGIN');await holder.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[workspaceId,firmId]);
    const pending=progress.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
    try{await waitForBlock(observer,pid);const heldContext=repositoryContext(workspaceScope(workspaceId,{kind:'user',userId:admin.userId,role:'admin'}),holder);expect(await changeSelectedSource(heldContext,{personId:claimEvidence.personId,sourceId:claimEvidence.sourceId,expectedRevision:1},'delete')).toMatchObject({ok:true});if(scenario==='source_correction'){expect(await changeSelectedSource(heldContext,{personId:claimEvidence.personId,sourceId:claimEvidence.sourceId,expectedRevision:2},'restore')).toMatchObject({ok:true});expect(await recaptureSelectedSource(heldContext,{personId:claimEvidence.personId,sourceId:claimEvidence.sourceId,expectedRevision:3,excerpt:'Corrected endpoint evidence; old citation is invalid',occurredAt:'2026-09-20T14:00:00.000Z'})).toMatchObject({ok:true});}}finally{await holder.query('COMMIT');}
    await pending;expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[]});
   }else {if(scenario==='expired_lease')await fixture.db.query("UPDATE jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE workspace_id=$1 AND id=$2",[workspaceId,job.id]);await progress.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});if(scenario==='replay')await progress.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});}
  }
  expect(todayActionsResponseSchema.parse((await request('/today/actions')).body).actions.map(a=>a.actionId).sort()).toEqual(resolves?[`reply-message:${ids.get('request-b')}`]:[`reply-message:${ids.get('request-a')}`,`reply-message:${ids.get('request-b')}`].sort());
  if(['missing_dependency','expired_lease','all_context_acl','source_race','source_correction'].includes(scenario))expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[]});
  if(resolves){const progressRead=await request('/crm/progress/read',{firmId});expect(progressRead.status).toBe(200);expect(progressRead.body).toMatchObject({version:1,events:[{kind:'contacted',occurredAt:'2026-09-25T14:00:00.000Z',source:{sourceId:ids.get('sent-a'),kind:'mail',revision:1}}]});}
  if(scenario==='replied'||scenario==='replied_prerequisite_delete'||scenario==='out_of_order'){const read=await request('/crm/progress/read',{firmId});expect(read.status).toBe(200);expect(read.body).toMatchObject({events:[{kind:'contacted',occurredAt:'2026-09-23T14:00:00.000Z'},{kind:'replied',occurredAt:'2026-09-24T14:00:00.000Z',source:{sourceId:ids.get('request-a')}}]});}
  if(scenario==='uncertain_preserve'){expect((await request('/replies/card',{messageId:ids.get('request-a')})).body).toEqual(heldCard);expect(heldCard).toMatchObject({deterministicClass:'uncertain',impact:{controlMode:'automated',holds:[{reasonCode:'uncertain_reply'}]}});}
  const after=actionableNotificationsResponseSchema.parse((await request('/notifications/actions')).body);
  expect(after.items.some(item=>item.actionId===first.actionId)).toBe(!resolves);
  expect(after.recoveries.find(item=>item.actionId===first.actionId)).toMatchObject({current:!resolves});
  if(scenario==='opt_out'){
   const confirmed=await request('/replies/confirm',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,messageId:ids.get('request-a'),disposition:'opt_out',firmWideOptOut:false,grantFollowUp:false});expect(confirmed.status).toBe(200);
   const read=crmProgressResponseSchema.parse((await request('/crm/progress/read',{firmId})).body);expect(read.events).toEqual(expect.arrayContaining([expect.objectContaining({kind:'opted_out',dateBasis:'provider_event',occurredAt:'2026-09-24T14:00:00.000Z',source:expect.objectContaining({sourceId:ids.get('request-a')})})]));
  }
  if(scenario==='copy_delete'||scenario==='replied_prerequisite_delete'){
   const deleted=await request('/crm/business/mail/delete',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId:ids.get('sent-a'),expectedRevision:1});expect(deleted.status).toBe(200);
   expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[]});
   expect(todayActionsResponseSchema.parse((await request('/today/actions')).body).actions.some(action=>action.actionId===first.actionId)).toBe(!resolves);
   expect(actionableNotificationsResponseSchema.parse((await request('/notifications/actions')).body).recoveries.find(item=>item.actionId===first.actionId)).toMatchObject({current:!resolves});
  }
  if(scenario==='terminal_delete'){
   const command=(fields:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
   const preview=await request('/retention/deletions/preview',command({targetKind:'firm',firmId}));expect(preview.status).toBe(200);
   const shown=(preview.body as {result:{requestId:string;previewHash:string;removes:Record<string,number>;redacts:Record<string,number>;retains:Record<string,number>}}).result;
   expect(shown.removes['crm_mail_progress_receipts']).toBe(1);expect(shown.redacts['crm_mail_reply_resolutions']).toBe(1);expect(shown.retains['crm_mail_reply_resolutions']).toBe(1);
   const deleted=await request('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));expect(deleted.status).toBe(200);
   expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[]});
   // Restoration infrastructure recreates the old opaque message identity and a fresh one.
   // Assertions use Today: attribution erasure must not reopen completed work.
   const freshId=randomUUID();
   for(const id of [ids.get('request-a')!,freshId]){
    await fixture.db.query("INSERT INTO mail_messages(id,workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,header_from,header_to,matched) VALUES($1,$2,$3,$4,$5,'incoming','2026-09-24T14:00:00Z','morgan@example.test',ARRAY['owner@example.test'],true)",[id,workspaceId,mailbox.id,`restored-${id}`,`restored-thread-${id}`]);
    await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,contact_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",[workspaceId,id,firmId,opportunityId,contactId]);
    await fixture.db.query("INSERT INTO mail_message_classifications(workspace_id,mail_message_id,layer,class,requires_confirmation,rules_version) VALUES($1,$2,'deterministic','human',false,'fixture')",[workspaceId,id]);
   }
   const restored=todayActionsResponseSchema.parse((await request('/today/actions')).body).actions.map(action=>action.actionId);
   expect(restored).not.toContain(`reply-message:${ids.get('request-a')}`);expect(restored).toContain(`reply-message:${freshId}`);
  }

 }finally{await fixture.stop();}
},60000);

/** Real database barriers; product assertions stay on authenticated reads. */
async function waitForBlock(observer:SessionQueryable,pid:number){for(let attempt=0;attempt<200;attempt++){const result=await observer.query<{blocked:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid]);if(result.rows[0]?.blocked)return;await delay(5);}throw new Error('Registered worker did not reach the database barrier');}

it('keeps booking receipts distinct from confirmed attendance and preserves cancelled booking history',async()=>{
 const fixture=await createAuthFixture();const {startIntegrationServer}=await import('./support/integrationServer.ts');const server=await startIntegrationServer(fixture);
 try{
  const {workspaceId,admin}=fixture.alpha;const firmId=await seedFirm(fixture,{name:'Booking progress fixture',assignedUserId:admin.userId});const contactId=await seedContact(fixture,{firmId,fullName:'Meeting fixture'});
  await fixture.db.query("INSERT INTO email_addresses(workspace_id,firm_id,contact_id,address,source,retrieved_at,technical_validation,eligibility,association_confidence,eligibility_policy_version) VALUES($1,$2,$3,'booked@example.test','reply',now(),'passed','usable',1,'fixture')",[workspaceId,firmId,contactId]);
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const request=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect((await request('/settings/update',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,settingKey:'calendar_integration',value:{integration:'calcom'}})).status).toBe(200);
  const deliver=async(triggerEvent:string,createdAt:string,uid='progress-booking')=>{const body={triggerEvent,createdAt,payload:{uid,startTime:uid==='progress-booking'?'2026-09-24T14:00:00Z':'2026-09-26T14:00:00Z',endTime:uid==='progress-booking'?'2026-09-24T14:30:00Z':'2026-09-26T14:30:00Z',organizer:{email:'owner@example.test'},attendees:[{email:'booked@example.test',name:'Meeting fixture'}]}};const raw=JSON.stringify(body);const response=await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw});expect(response.status).toBe(200);return await response.json() as {meetingId:string};};
  await deliver('BOOKING_CREATED','2026-09-23T14:00:00Z');
  const bookedView=crmProgressResponseSchema.parse((await request('/crm/progress/read',{firmId})).body);expect(bookedView).toMatchObject({events:[{kind:'booked',dateBasis:'receipt_observed',bookingState:'booked'}]});
  const meetingId=bookedView.events[0]!.evidence.id;
  await deliver('MEETING_ENDED','2026-09-24T14:30:00Z');
  expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:[{kind:'booked',bookingState:'ended'}]});
  expect((await request('/meetings/attendance',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,meetingId,attendance:'attended'})).status).toBe(200);
  expect((await request('/crm/progress/read',{firmId})).body).toMatchObject({events:expect.arrayContaining([expect.objectContaining({kind:'attended',dateBasis:'meeting_scheduled_start',occurredAt:'2026-09-24T14:00:00.000Z'})])});
  await deliver('BOOKING_CREATED','2026-09-25T14:00:00Z','progress-cancelled');
  await deliver('BOOKING_CANCELLED','2026-09-26T14:00:00Z','progress-cancelled');
  const cancelled=(await request('/crm/progress/read',{firmId})).body as {events:{kind:string;bookingState:string|null}[]};expect(cancelled.events.some(event=>event.kind==='booked'&&event.bookingState==='cancelled')).toBe(true);
  await fixture.db.query('UPDATE firms SET assigned_user_id=$3 WHERE workspace_id=$1 AND id=$2',[workspaceId,firmId,fixture.alpha.salesperson.userId]);
  await fixture.db.query("CREATE FUNCTION test_refuse_progress_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.progress_admin_read' THEN RAISE EXCEPTION 'progress audit unavailable'; END IF; RETURN NEW; END $$");
  await fixture.db.query('CREATE TRIGGER test_refuse_progress_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_refuse_progress_audit()');
  await expect(request('/crm/progress/read',{firmId})).rejects.toThrow('progress audit unavailable');
 }finally{await server.close();await fixture.stop();}
});
