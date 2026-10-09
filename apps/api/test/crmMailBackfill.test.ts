import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { createApprovedBusinessMailObserver } from '@fss/domain/mail/crmSources.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import {runClaimedJob} from '../../worker/src/runner/jobRunner.ts';
import {runSchedulerPass} from '../../worker/src/scheduler/schedulerPass.ts';
import { registerHandlers,workerDueWorkSources } from '../../worker/src/bootstrap/main.ts';
import { METADATA_REVIEW_DISCLOSURE,businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { createAuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { dispatch } from '../src/server.ts';

it('starts a separate exact ninety-day CRM import without claiming an operational watermark is complete history', async () => {
  const fixture = await createAuthFixture();
  try {
    const { workspaceId, admin } = fixture.alpha;
    const token = (await issueSessionFor(fixture, fixture.alpha, admin)).accessToken;
    const mailbox = (await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,history_id,history_id_updated_at,sync_state,baseline_from_at,baseline_completed_at) VALUES($1,$2,'business@example.test','google-business','connected','100',now(),'ready',now()-interval '30 days',now()) RETURNING *", [workspaceId, admin.userId])).rows[0]!;
    const binding = businessAccountBinding(workspaceId, mailbox)!;
    await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,true)", [workspaceId,mailbox.id,admin.userId,binding]);
    await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'fixture',repeat('b',64),'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')", [workspaceId,mailbox.id,admin.userId,binding]);
    const post = (path:string,body:unknown) => dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}}, {session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
    const requested = await post('/crm/business/mail/import/request', {commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id});
    expect(requested.status).toBe(200);
    const health = await post('/crm/business/mail/import/read', {mailboxId:mailbox.id});
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({state:'pending',generation:1,historyAnchor:null,historyComplete:false,completedSlices:0,totalSlices:90});
    const interval = health.body as {fromAt:string;toAt:string};
    expect(Date.parse(interval.toAt)-Date.parse(interval.fromAt)).toBe(90*24*60*60*1000);
    const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined});
    const handler=registry.get('crm.mail_backfill');
    expect(handler,'A registered worker must explain missing configuration without treating the import as complete').toBeDefined();
    const job=(await claimJobs(fixture.db,{owner:'backfill-fixture',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
    await handler!.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
    expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'backfill_configuration_required',historyAnchor:null,historyComplete:false,completedSlices:0});
  } finally {await fixture.stop();}
});


it('configured acquisition without a verified read allocation calls no Gmail method and keeps enumeration incomplete', async()=>{
 const fixture=await createAuthFixture();
 try{
  const {workspaceId,admin}=fixture.alpha;
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",[workspaceId,admin.userId])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,true)",[workspaceId,mailbox.id,admin.userId,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'fixture',repeat('b',64),'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,admin.userId,binding]);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  expect((await post('/crm/business/mail/import/request',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id})).status).toBe(200);
  const gmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[{id:'historical-inquiry',threadId:'historical-thread',historyId:'99',internalDateEpochMilliseconds:Date.now()-89*86400000+3600000,headers:{From:'prospect@example.test',To:'business@example.test',Subject:'Historical inquiry'},body:'Must remain unfetched'}]});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  const workerRuntime=await fixture.database.appRuntimeSession();
  const job=(await claimJobs(fixture.db,{owner:'configured-backfill',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  await registry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'quota_configuration_required',historyAnchor:null,historyComplete:false,completedSlices:0});
  expect(gmail.calls).toEqual([]);
  await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,mailbox.id,admin.userId,binding]);
  await registry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',historyAnchor:'100',windowFrozen:true,historyComplete:false,completedSlices:1});
  await registry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/review/read',{mailboxId:mailbox.id})).body).toMatchObject({conversations:[{subject:'Historical inquiry',category:'uncertain',effectiveDecision:'needs_review'}]});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',completedSlices:2,historyComplete:false});
  expect(gmail.metadataReads).toEqual(['historical-inquiry']);
  expect(gmail.bodyReads).toEqual([]);
  const frozen=(await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body as {fromAt:string;historyAnchor:string};
  const resumedGmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'200',messages:[{id:'interrupted-inquiry',threadId:'interrupted-thread',historyId:'150',internalDateEpochMilliseconds:Date.parse(frozen.fromAt)+2*86400000+3600000,headers:{From:'second@example.test',To:'business@example.test',Subject:'Interrupted inquiry'}}]});
  let interrupted=true;
  const resumedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:{...resumedGmail,getMetadata:async(...args)=>{if(interrupted){interrupted=false;throw new Error('simulated transport');}return resumedGmail.getMetadata(...args);}},resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  await expect(resumedRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job})).rejects.toThrow('provider_read_unavailable');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'provider_read_unavailable',quotaAccounting:{scope:'callie_backfill_allocation',reservedUnits:'6',observedUnits:'5',unknownUnits:'1'},completedSlices:2,historyAnchor:frozen.historyAnchor,fromAt:frozen.fromAt});
  await resumedRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',metadataCoverage:{retainedUniqueMessages:'2',availableMetadataMessages:'2',refusedMetadataMessages:'0',confirmedMissingMessages:'0',deletedMetadataMessages:'0'},quotaAccounting:{scope:'callie_backfill_allocation',reservedUnits:'8',observedUnits:'7',unknownUnits:'1'},completedSlices:3,historyAnchor:frozen.historyAnchor,fromAt:frozen.fromAt});
  expect((await post('/crm/business/review/read',{mailboxId:mailbox.id})).body).toMatchObject({conversations:expect.arrayContaining([{subject:'Interrupted inquiry',category:'uncertain',effectiveDecision:'needs_review',captureAllowed:false}].map(row=>expect.objectContaining(row)))});
  expect(resumedGmail.calls.filter(call=>call.method==='getProfile')).toEqual([]);
  expect(resumedGmail.bodyReads).toEqual([]);
  const callsBeforeRevision=resumedGmail.calls.length;
  await fixture.db.query('UPDATE crm_mail_import_allocations SET revision=2,user_limit_units=9,user_headroom_units=1 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  await expect(resumedRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job})).rejects.toThrow('quota_or_authority_unavailable');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'quota_or_authority_unavailable',completedSlices:3,quotaAccounting:{reservedUnits:'8',observedUnits:'7',unknownUnits:'1'}});
  expect(resumedGmail.calls).toHaveLength(callsBeforeRevision);
  await fixture.db.query('UPDATE crm_mail_import_allocations SET revision=3,user_limit_units=1000,user_headroom_units=100 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  const privateFailureRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:{...resumedGmail,listMessageIds:async()=>{throw new Error('private_provider_response');}},resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  await expect(privateFailureRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job})).rejects.toThrow('provider_read_unavailable');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({reason:'provider_read_unavailable',quotaAccounting:{reservedUnits:'9',observedUnits:'7',unknownUnits:'2'}});
  const firmId=await seedFirm(fixture,{name:'Historical contact firm',regionCode:'RI',postalCode:'02903',assignedUserId:admin.userId});
  const contactId=await seedContact(fixture,{firmId,fullName:'Historical contact'});
  const command=(fields:Record<string,unknown>)=>({commandId:randomUUID(),clientVersion:'1.4.0',...fields});
  expect((await post('/contacts/routes/add',command({firmId,contactId,routeKind:'email',value:'prospect@example.test',source:'salesperson',technicalValidation:'passed',associationConfidence:0.95}))).status).toBe(200);
  const preview=await post('/retention/deletions/preview',command({targetKind:'contact',firmId,contactId}));
  expect(preview.status).toBe(200);
  const shown=(preview.body as {result:{requestId:string;previewHash:string;redacts:Record<string,number>}}).result;
  expect(shown.redacts['crm_mail_import_messages']).toBe(1);
  const committed=await post('/retention/deletions/commit',command({requestId:shown.requestId,previewHash:shown.previewHash}));
  expect(committed.status).toBe(200);
  expect(committed.body).toMatchObject({result:{redacted:{crm_mail_import_messages:1}}});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({metadataCoverage:{retainedUniqueMessages:'2',availableMetadataMessages:'1',deletedMetadataMessages:'1'},quotaAccounting:{reservedUnits:'9',observedUnits:'7',unknownUnits:'2'}});
  const refusedGmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'200',messages:[{id:'refused-inquiry',threadId:'refused-thread',historyId:'160',internalDateEpochMilliseconds:Date.parse(frozen.fromAt)+3*86400000+3600000,headers:{From:'refused@example.test',To:'business@example.test',Subject:'Refused inquiry'}}]});
  const refusedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:refusedGmail,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:{observe:async()=>{}}}});
  await refusedRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({metadataCoverage:{retainedUniqueMessages:'3',availableMetadataMessages:'1',refusedMetadataMessages:'1',deletedMetadataMessages:'1'},quotaAccounting:{reservedUnits:'11',observedUnits:'9',unknownUnits:'2'}});
  // Age unavailable fixture metadata past the review horizon without waiting ninety days.
  await fixture.db.query("UPDATE crm_mail_import_messages SET observed_at=clock_timestamp()-interval '91 days' WHERE workspace_id=$1 AND state='refused'",[workspaceId]);
  const retention=refusedRegistry.get('retention.batch')!;
  const now=new Date().toISOString();
  await withTransaction(workerRuntime,()=>retention.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job:{id:randomUUID(),workspaceId,kind:'retention.batch',idempotencyKey:'causal-expiry-fixture',payload:{dataKind:'unmatched_gmail_metadata',period:now.slice(0,10)},attempt:1,maxAttempts:6,fencingToken:'1',leaseOwner:'causal-retention',leaseExpiresAt:now}}));
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({metadataCoverage:{retainedUniqueMessages:'3',availableMetadataMessages:'1',refusedMetadataMessages:'0',deletedMetadataMessages:'2'},quotaAccounting:{reservedUnits:'11',observedUnits:'9',unknownUnits:'2'}});
  const disappearedGmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'200',messages:[{id:'disappeared-inquiry',threadId:'disappeared-thread',historyId:'170',internalDateEpochMilliseconds:Date.parse(frozen.fromAt)+4*86400000+3600000,headers:{From:'gone@example.test',To:'business@example.test',Subject:'Gone inquiry'}}],vanishedMessageIds:['disappeared-inquiry']});
  const disappearedRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:disappearedGmail,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  await disappearedRegistry.get('crm.mail_backfill')!.handle({session:workerRuntime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({completedSlices:5,metadataCoverage:{retainedUniqueMessages:'4',availableMetadataMessages:'1',refusedMetadataMessages:'0',deletedMetadataMessages:'2',confirmedMissingMessages:'1'},quotaAccounting:{reservedUnits:'13',observedUnits:'11',unknownUnits:'2'}});
  expect(disappearedGmail.metadataReads).toEqual(['disappeared-inquiry']);
  expect(disappearedGmail.bodyReads).toEqual([]);
  expect(disappearedGmail.sends).toEqual([]);
  // Infrastructure contract: runtime may mark observations, but cannot erase conserved units or time.
  const runtime=await fixture.database.appRuntimeSession();
  const privileges=(await runtime.query<{table_update:boolean;marker_update:boolean}>("SELECT has_table_privilege(current_user,'crm_mail_import_read_reservations','UPDATE') AS table_update,has_column_privilege(current_user,'crm_mail_import_read_reservations','state','UPDATE') AS marker_update")).rows[0]!;
  expect(privileges).toEqual({table_update:false,marker_update:true});
  const observedReservation=(await runtime.query<{id:string}>("SELECT id FROM crm_mail_import_read_reservations WHERE workspace_id=$1 AND state='observed' LIMIT 1",[workspaceId])).rows[0]!;
  await expect(runtime.query('UPDATE crm_mail_import_read_reservations SET units=units+1 WHERE workspace_id=$1 AND id=$2',[workspaceId,observedReservation.id])).rejects.toMatchObject({code:'42501'});
  await expect(runtime.query("UPDATE crm_mail_import_read_reservations SET reserved_at=clock_timestamp()-interval '1 hour' WHERE workspace_id=$1 AND id=$2",[workspaceId,observedReservation.id])).rejects.toMatchObject({code:'42501'});
  await expect(runtime.query("UPDATE crm_mail_import_read_reservations SET state='unknown',observed_at=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,observedReservation.id])).rejects.toMatchObject({code:'23514'});
  await expect(runtime.query('UPDATE crm_mail_import_read_reservations SET observed_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',[workspaceId,observedReservation.id])).rejects.toMatchObject({code:'23514'});
 }finally{await fixture.stop();}
});

it('uses exact frozen microseconds for provider millisecond timestamps at the admission edges',async()=>{
 const fixture=await createAuthFixture();
 try{
  const {workspaceId,admin}=fixture.alpha;
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",[workspaceId,admin.userId])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,true)",[workspaceId,mailbox.id,admin.userId,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'fixture',repeat('b',64),'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,admin.userId,binding]);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  expect((await post('/crm/business/mail/import/request',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id})).status).toBe(200);
  await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,mailbox.id,admin.userId,binding]);
  const empty=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[]});
  const deps={resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()};
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{...deps,gmail:empty}});
  const job=(await claimJobs(fixture.db,{owner:'precision-backfill',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  const scope=workspaceScope(workspaceId,{kind:'system',component:'worker'});
  await registry.get('crm.mail_backfill')!.handle({session:fixture.db,scope,job});
  // Fixture puts exact scope edges halfway between provider milliseconds, without shifting its ninety-day duration.
  await fixture.db.query("UPDATE crm_mail_imports SET from_at=date_trunc('milliseconds',from_at)+interval '0.0005 seconds',to_at=date_trunc('milliseconds',to_at)+interval '0.0005 seconds' WHERE workspace_id=$1",[workspaceId]);
  await fixture.db.query("UPDATE crm_mail_import_slices SET state='pending' WHERE workspace_id=$1 AND ordinal=0",[workspaceId]);
  const frozen=(await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body as {fromAt:string;toAt:string};
  const startMs=Date.parse(frozen.fromAt);
  const edges=recordedGmailClient({emailAddress:'business@example.test',historyId:'200',messages:[
   {id:'before-exact-from',threadId:'before-thread',historyId:'99',internalDateEpochMilliseconds:startMs,headers:{From:'outside@example.test',To:'business@example.test',Subject:'Outside frozen scope'}},
   {id:'inside-exact-from',threadId:'inside-thread',historyId:'99',internalDateEpochMilliseconds:startMs+1,headers:{From:'inside@example.test',To:'business@example.test',Subject:'Inside frozen scope'}},
  ]});
  const bounded=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{...deps,gmail:edges}});
  await bounded.get('crm.mail_backfill')!.handle({session:fixture.db,scope,job});
  expect((await post('/crm/business/review/read',{mailboxId:mailbox.id})).body).toMatchObject({conversations:[]});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({metadataCoverage:{retainedUniqueMessages:'1',availableMetadataMessages:'0',refusedMetadataMessages:'1'}});
  expect(edges.metadataReads).toEqual(['before-exact-from','inside-exact-from']);
  expect(edges.bodyReads).toEqual([]);
  await fixture.db.query("UPDATE crm_mail_import_slices SET state='complete' WHERE workspace_id=$1 AND ordinal<>89",[workspaceId]);
  const endMs=Date.parse(frozen.toAt);
  const endEdges=recordedGmailClient({emailAddress:'business@example.test',historyId:'200',messages:[
   {id:'inside-exact-to',threadId:'inside-end-thread',historyId:'101',internalDateEpochMilliseconds:endMs,headers:{From:'end-inside@example.test',To:'business@example.test',Subject:'Just inside end'}},
   {id:'after-exact-to',threadId:'after-end-thread',historyId:'101',internalDateEpochMilliseconds:endMs+1,headers:{From:'end-outside@example.test',To:'business@example.test',Subject:'Outside end'}},
  ]});
  const endBounded=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{...deps,gmail:endEdges}});
  expect(await runClaimedJob(fixture.db,{registry:endBounded,job})).toBe('completed');
  expect((await post('/crm/business/review/read',{mailboxId:mailbox.id})).body).toMatchObject({conversations:[{subject:'Just inside end'}]});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',completedSlices:90,historyComplete:false,metadataCoverage:{retainedUniqueMessages:'2',availableMetadataMessages:'1',refusedMetadataMessages:'1'}});
  expect(endEdges.metadataReads).toEqual(['inside-exact-to','after-exact-to']);
  expect(endEdges.bodyReads).toEqual([]);
  // Actual runner completion and scheduler continuation must not confuse finished enumeration with history coverage.
  const source=workerDueWorkSources({crmMailBackfill:true}).find(value=>value.name==='crm-mail-backfill');
  expect(source).toBeDefined();
  const scheduler=await fixture.database.appRuntimeSession();
  const callsBeforeSchedule=endEdges.calls.length;
  const pass=await runSchedulerPass(scheduler,{sources:[source!],now:new Date().toISOString()});
  expect(pass).toMatchObject({outcome:'ran',inserted:1,externalActions:0});
  expect(await runSchedulerPass(scheduler,{sources:[source!],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  expect(endEdges.calls).toHaveLength(callsBeforeSchedule);
  const continuation=(await claimJobs(scheduler,{owner:'history-continuation',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(continuation.payload).toMatchObject({importId:expect.any(String),accountBinding:binding,generation:1,controlsRevision:1,policyRevision:1});
  const overlap=recordedGmailClient({emailAddress:'business@example.test',historyId:'300',messages:[
   {id:'handoff-overlap',threadId:'handoff-thread',historyId:'201',internalDateEpochMilliseconds:endMs+1,headers:{From:'handoff@example.test',To:'business@example.test',Subject:'Arrived during enumeration'}},
   {id:'inside-exact-to',threadId:'inside-end-thread',historyId:'101',internalDateEpochMilliseconds:endMs,headers:{From:'end-inside@example.test',To:'business@example.test',Subject:'Just inside end'}},
  ]});
  const historyRequests:{startHistoryId:string;pageToken?:string|undefined}[]=[];
  let interruptHistoryMetadata=true;
  const historyRegistry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{...deps,gmail:{...overlap,getMetadata:async(access,messageId,headers)=>{
   if(messageId==='inside-exact-to'&&interruptHistoryMetadata){interruptHistoryMetadata=false;throw new Error('private_history_interruption');}
   return overlap.getMetadata(access,messageId,headers);
  },listHistory:async(_access,request)=>{
   historyRequests.push(request);
   return request.pageToken===undefined?{ok:true,historyId:'300',nextPageToken:'history-page-two',records:[{id:'201',changes:[{messageId:'handoff-overlap',threadId:'handoff-thread',kind:'message_added',labelIds:[]},{messageId:'inside-exact-to',threadId:'inside-end-thread',kind:'label_added',labelIds:['INBOX']}]}]}:{ok:true,historyId:'300',nextPageToken:null,records:[{id:'202',changes:[{messageId:'inside-exact-to',threadId:'inside-end-thread',kind:'label_added',labelIds:['INBOX']}]}]};
  }}}});
  const historyBackoff={baseSeconds:0,factor:1,maximumSeconds:0,jitterFraction:0};
  expect(await runClaimedJob(scheduler,{registry:historyRegistry,job:continuation,backoff:historyBackoff})).toBe('retryable');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'provider_read_unavailable',historyComplete:false,metadataCoverage:{retainedUniqueMessages:'3'}});
  const samePage=(await claimJobs(scheduler,{owner:'history-page-replay',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(scheduler,{registry:historyRegistry,job:samePage})).toBe('completed');
  expect(historyRequests).toEqual([{startHistoryId:'100',maxResults:25},{startHistoryId:'100',maxResults:25}]);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',completedSlices:90,historyComplete:false,metadataCoverage:{retainedUniqueMessages:'3',availableMetadataMessages:'2'}});
  expect(await runSchedulerPass(scheduler,{sources:[source!],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  const historyTail=(await claimJobs(scheduler,{owner:'history-tail',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(scheduler,{registry:historyRegistry,job:historyTail})).toBe('completed');
  expect(historyRequests).toEqual([{startHistoryId:'100',maxResults:25},{startHistoryId:'100',maxResults:25},{startHistoryId:'100',maxResults:25,pageToken:'history-page-two'}]);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'complete',completedSlices:90,historyComplete:true,metadataCoverage:{retainedUniqueMessages:'3',availableMetadataMessages:'2'}});
  expect(await runSchedulerPass(scheduler,{sources:[source!],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  expect(overlap.bodyReads).toEqual([]);
  expect(overlap.sends).toEqual([]);
 }finally{await fixture.stop();}
});

it('uses bounded real runner retries and never rematerializes exhausted unchanged import work',async()=>{
 const fixture=await createAuthFixture();
 try{
  const {workspaceId,admin}=fixture.alpha;
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",[workspaceId,admin.userId])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,true)",[workspaceId,mailbox.id,admin.userId,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'fixture',repeat('b',64),'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,admin.userId,binding]);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  expect((await post('/crm/business/mail/import/request',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id})).status).toBe(200);
  await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,mailbox.id,admin.userId,binding]);
  const gmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[]});
  let listAttempts=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:{...gmail,listMessageIds:async()=>{listAttempts++;throw new Error('private_provider_failure');}},resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  const runtime=await fixture.database.appRuntimeSession();
  const source=workerDueWorkSources({crmMailBackfill:true}).find(value=>value.name==='crm-mail-backfill')!;
  const backoff={baseSeconds:0,factor:1,maximumSeconds:0,jitterFraction:0};
  for(let attempt=1;attempt<=4;attempt++){
   const job=(await claimJobs(runtime,{owner:'bounded-backfill-retry',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
   expect(job).toBeDefined();
   expect(await runClaimedJob(runtime,{registry,job,backoff})).toBe(attempt===4?'dead':'retryable');
   expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  }
  expect(listAttempts).toBe(4);
  expect(gmail.calls.filter(call=>call.method==='getProfile')).toHaveLength(1);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'provider_read_unavailable',completedSlices:0,historyAnchor:'100',quotaAccounting:{reservedUnits:'5',observedUnits:'1',unknownUnits:'4'}});
  // Operator fixture changes the verified configuration; this creates one new exact key, never refunds prior unknown usage.
  await fixture.db.query('UPDATE crm_mail_import_allocations SET revision=2 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  expect(listAttempts).toBe(4);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({quotaAccounting:{reservedUnits:'5',observedUnits:'1',unknownUnits:'4'}});
 }finally{await fixture.stop();}
});
