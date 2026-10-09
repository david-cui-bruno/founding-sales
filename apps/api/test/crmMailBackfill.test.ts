import {GmailClientError} from '@fss/domain/mail/gmailClient.ts';
import {createHistoricalGmailMailCaptureProvider} from '@fss/domain/mail/crmBackfillCapture.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { createApprovedBusinessMailObserver } from '@fss/domain/mail/crmSources.ts';
import { recordingSuppressionJournal } from '@fss/domain/suppression/journal.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import { createHash,randomUUID } from 'node:crypto';
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
    expect(requested.body).toMatchObject({result:{importId:expect.any(String),status:'queued'}});
    expect(Object.keys((requested.body as {result:Record<string,unknown>}).result).sort()).toEqual(['importId','status']);
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
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({copyCoverage:{coverage:'partial',unresolvedMetadata:'1'}});
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
  expect(historyRequests).toEqual([{startHistoryId:'100',maxResults:25,includeLifecycleChanges:true},{startHistoryId:'100',maxResults:25,includeLifecycleChanges:true}]);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',completedSlices:90,historyComplete:false,metadataCoverage:{retainedUniqueMessages:'3',availableMetadataMessages:'2'}});
  expect(await runSchedulerPass(scheduler,{sources:[source!],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  const historyTail=(await claimJobs(scheduler,{owner:'history-tail',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(scheduler,{registry:historyRegistry,job:historyTail})).toBe('completed');
  expect(historyRequests).toEqual([{startHistoryId:'100',maxResults:25,includeLifecycleChanges:true},{startHistoryId:'100',maxResults:25,includeLifecycleChanges:true},{startHistoryId:'100',maxResults:25,includeLifecycleChanges:true,pageToken:'history-page-two'}]);
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

it.each(['copy','body_quota','changed_generation','changed_account','disconnected','excluded_after_metadata'])('reserves actual historical metadata and body reads through the native capture boundary (%s)',async(scenario)=>{
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
  if(scenario==='body_quota')await fixture.db.query('UPDATE crm_mail_import_allocations SET user_limit_units=4,user_headroom_units=0 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  const gmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[{id:'historical-business',threadId:'historical-business-thread',historyId:'50',internalDateEpochMilliseconds:Date.now()-89.5*86400000,headers:{From:'person@example.test',To:'business@example.test',Subject:'Historical business'},body:'Permitted historical business text'}]});
  const access={resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true}};
  let originalMode:'unchanged'|'trashed'|'missing'|'denied'='unchanged';
  const backfillGmail={...gmail,listMessageIds:async(...args:Parameters<typeof gmail.listMessageIds>)=>originalMode==='unchanged'?await gmail.listMessageIds(...args):{ok:true as const,messageIds:['historical-business'],nextPageToken:null},getMetadata:async(...args:Parameters<typeof gmail.getMetadata>)=>{
   const metadata=await gmail.getMetadata(...args);
   if(originalMode==='denied')throw new GmailClientError('unexpected_status','Controlled metadata denial',403);
   return originalMode==='missing'?null:originalMode==='trashed'&&metadata!==null?{...metadata,labelIds:['TRASH']}:metadata;
  }};
  const captureGmail={...gmail,getMetadata:async(...args:Parameters<typeof gmail.getMetadata>)=>{
   const metadata=await gmail.getMetadata(...args);
   if(scenario==='disconnected')await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
   if(scenario==='changed_account')await fixture.db.query("UPDATE mailboxes SET provider_account_id='google-replacement' WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
   if(scenario==='changed_generation')await fixture.db.query('UPDATE mailboxes SET generation=2 WHERE workspace_id=$1 AND id=$2',[workspaceId,mailbox.id]);
   if(scenario==='excluded_after_metadata'){
    const review=(await post('/crm/business/review/read',{mailboxId:mailbox.id})).body as {conversations:{conversationId:string;metadataRevision:number;decisionRevision:number}[]};
    const conversation=review.conversations[0]!;
    expect((await post('/crm/business/review/decide',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id,conversationId:conversation.conversationId,expectedGeneration:1,expectedAccountBinding:binding,expectedPolicyRevision:1,expectedMetadataRevision:conversation.metadataRevision,expectedDecisionRevision:conversation.decisionRevision,decision:'exclude'})).body).toMatchObject({status:'accepted'});
   }
   return metadata;
  }};
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,
   crmMailBackfill:{...access,gmail:backfillGmail,observer:createApprovedBusinessMailObserver({categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'fixture-metadata-v1'})})},
   crmMailCapture:{proofVerifier:access.proofVerifier,provider:{read:async()=>{throw new Error('unmetered live provider must not be called');}},historicalProvider:createHistoricalGmailMailCaptureProvider({...access,gmail:captureGmail})},
  });
  const runtime=await fixture.database.appRuntimeSession();
  const backfill=(await claimJobs(runtime,{owner:'historical-copy-import',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:backfill})).toBe('completed');
  expect(gmail.bodyReads).toEqual([]);
  const capture=(await claimJobs(runtime,{owner:'historical-copy-capture',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
  expect(capture.payload).toMatchObject({acquisitionOrigin:{importId:expect.any(String)}});
  if(scenario!=='copy'){
   expect(await runClaimedJob(runtime,{registry,job:capture,backoff:{baseSeconds:0,factor:1,maximumSeconds:0,jitterFraction:0}})).toBe('retryable');
   expect(gmail.bodyReads).toEqual([]);
   expect(gmail.metadataReads).toEqual(['historical-business','historical-business']);
   expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({connectionState:scenario==='disconnected'?'disconnected':scenario==='changed_generation'||scenario==='changed_account'?'changed':'current',quotaAccounting:{reservedUnits:'4',observedUnits:'4',unknownUnits:'0'}});
   return;
  }
  const copied=await registry.get('crm.mail_capture')!.handle({session:runtime,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job:capture});
  expect(copied).toMatchObject({progress:{outcome:'captured',sourceRevision:1}});
  expect((await post('/crm/business/mail/read',{sourceId:copied?.progress['sourceId'],sourceRevision:1,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{passage:'Permitted historical business text',completeness:'partial',ownerUserId:admin.userId,mailboxId:mailbox.id,accountBinding:binding}});
  const originalPreview=await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:1,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')});
  expect(originalPreview.status).toBe(200);
  expect(originalPreview.body).toMatchObject({state:'available',source:{originalObservation:{state:'unknown',revision:'0',observedAt:null,observedGeneration:null,observedAccountBinding:null,reason:null,connectionState:'current'}}});
  expect(await runClaimedJob(runtime,{registry,job:capture})).toBe('completed');
  expect(gmail.bodyReads).toEqual(['historical-business']);
  expect(gmail.metadataReads).toEqual(['historical-business','historical-business']);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({connectionState:'current',quotaAccounting:{reservedUnits:'5',observedUnits:'5',unknownUnits:'0'}});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({copyCoverage:{scope:'permitted_import_corpus',coverage:'complete',retainedCopiedBodies:'1',unavailableCopies:'0',pendingCaptures:'0',reviewRequiredMetadata:'0',uncapturedMetadata:'0',unresolvedMetadata:'0'}});
  originalMode='trashed';
  expect(await runSchedulerPass(runtime,{sources:[workerDueWorkSources({crmMailBackfill:true}).find(source=>source.name==='crm-mail-backfill')!],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  const refresh=(await claimJobs(runtime,{owner:'original-state-refresh',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:refresh})).toBe('completed');
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:1,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{sourceRevision:1,passage:'Permitted historical business text',originalObservation:{state:'trashed',revision:'1',observedAt:expect.any(String),observedGeneration:1,observedAccountBinding:binding,reason:'verified_trash_label',connectionState:'current'}}});
  originalMode='missing';
  expect(await runSchedulerPass(runtime,{sources:[workerDueWorkSources({crmMailBackfill:true}).find(source=>source.name==='crm-mail-backfill')!],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  const missingRefresh=(await claimJobs(runtime,{owner:'original-missing-refresh',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:missingRefresh})).toBe('completed');
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:1,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{sourceRevision:1,passage:'Permitted historical business text',originalObservation:{state:'confirmed_missing',revision:'2',observedGeneration:1,observedAccountBinding:binding,reason:'verified_message_not_found'}}});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({metadataCoverage:{retainedUniqueMessages:'1',confirmedMissingMessages:'1'},copyCoverage:{retainedCopiedBodies:'1',coverage:'complete'}});
  originalMode='denied';
  expect(await runSchedulerPass(runtime,{sources:[workerDueWorkSources({crmMailBackfill:true}).find(source=>source.name==='crm-mail-backfill')!],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  const deniedRefresh=(await claimJobs(runtime,{owner:'original-denied-refresh',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:deniedRefresh})).toBe('retryable');
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:1,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{passage:'Permitted historical business text',originalObservation:{state:'transient_unavailable',revision:'3',reason:'grant_unavailable'}}});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({quotaAccounting:{reservedUnits:'11',observedUnits:'10',unknownUnits:'1'},copyCoverage:{retainedCopiedBodies:'1'}});
  const outsideFirm=await seedFirm(fixture,{name:'Other assigned context',regionCode:'RI',postalCode:'02903',assignedUserId:fixture.alpha.salesperson.userId});
  expect((await post('/crm/business/mail/associate',{commandId:randomUUID(),clientVersion:'1.4.0',sourceId:copied?.progress['sourceId'],expectedRevision:1,firmId:outsideFirm})).body).toMatchObject({status:'accepted'});
  await fixture.db.query("CREATE FUNCTION test_refuse_backfill_coverage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.mail_source_admin_read' THEN RAISE EXCEPTION 'coverage audit unavailable'; END IF; RETURN NEW; END $$");
  await fixture.db.query('CREATE TRIGGER test_refuse_backfill_coverage_audit BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_refuse_backfill_coverage_audit()');
  await expect(post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).rejects.toThrow('coverage audit unavailable');
  await fixture.db.query('DROP TRIGGER test_refuse_backfill_coverage_audit ON audit_events');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({copyCoverage:{coverage:'complete',retainedCopiedBodies:'1',unresolvedMetadata:'0'}});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({connectionState:'disconnected',copyCoverage:{coverage:'complete',retainedCopiedBodies:'1'}});
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:2,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{originalObservation:{state:'transient_unavailable',revision:'3',connectionState:'disconnected'}}});
  await fixture.db.query("UPDATE mailboxes SET status='connected',disconnected_at=NULL,provider_account_id='replacement-provider-account',generation=2 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({connectionState:'changed',copyCoverage:{coverage:'complete',retainedCopiedBodies:'1'}});
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:2,contentHash:createHash('sha256').update('Permitted historical business text').digest('hex')})).body).toMatchObject({state:'available',source:{originalObservation:{state:'transient_unavailable',revision:'3',connectionState:'changed'}}});
  await fixture.db.query("UPDATE mailboxes SET provider_account_id='google-business',generation=1 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  // Separate runtime sessions exercise the read/delete lock boundary through real commands.
  const coverageSession=await fixture.database.appRuntimeSession();
  const deletionSession=await fixture.database.appRuntimeSession();
  const coveragePid=(await coverageSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const deletionPid=(await deletionSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const sessionPost=(session:typeof coverageSession,path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session,auth:{...fixture.deps,db:session},supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  await fixture.db.query('SELECT pg_advisory_lock(4842201)');
  await fixture.db.query("CREATE FUNCTION test_pause_backfill_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='crm.mail_source_admin_read' THEN PERFORM pg_advisory_xact_lock(4842201); END IF; RETURN NEW; END $$");
  await fixture.db.query('CREATE TRIGGER test_pause_backfill_coverage BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION test_pause_backfill_coverage()');
  async function awaitBlocked(pid:number,blockingPid?:number){
   for(let n=0;n<100;n++){
    const row=(await fixture.db.query<{event:string|null;blocking:number[]}>('SELECT wait_event AS event,pg_blocking_pids(pid) AS blocking FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0];
    if(blockingPid===undefined?row?.event==='advisory':row?.blocking.includes(blockingPid))return;
    await new Promise(resolve=>setTimeout(resolve,20));
   }
   throw new Error('Controlled PostgreSQL coverage barrier was not reached');
  }
  const coverageRun=sessionPost(coverageSession,'/crm/business/mail/import/read',{mailboxId:mailbox.id});
  let deletionRun:ReturnType<typeof sessionPost>|undefined;
  try{
   await awaitBlocked(coveragePid);
   deletionRun=sessionPost(deletionSession,'/crm/business/mail/delete',{commandId:randomUUID(),clientVersion:'1.4.0',sourceId:copied?.progress['sourceId'],expectedRevision:2});
   await awaitBlocked(deletionPid,coveragePid);
  }finally{await fixture.db.query('SELECT pg_advisory_unlock(4842201)');}
  expect((await coverageRun).body).toMatchObject({copyCoverage:{retainedCopiedBodies:'1',coverage:'complete'}});
  expect((await deletionRun!).body).toMatchObject({status:'accepted',result:{availability:'deleted'}});
  expect((await post('/crm/business/mail/read/v2',{sourceId:copied?.progress['sourceId'],sourceRevision:3,contentHash:null})).body).toEqual({state:'unavailable',reason:'deleted',source:null});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({copyCoverage:{retainedCopiedBodies:'0',unresolvedMetadata:'1',coverage:'partial'}});
  expect(gmail.bodyReads).toEqual(['historical-business']);
  expect(gmail.sends).toEqual([]);
 }finally{await fixture.db.query('SELECT pg_advisory_unlock_all()');await fixture.stop();}
});

it.each(['unchanged','changed','exhausted','disconnected_profile','changed_profile'])('persists bounded recovery after actual cursor expiry without moving the original window (%s)',async scenario=>{
 const changedConfiguration=scenario==='changed'||scenario==='exhausted';
 const fixture=await createAuthFixture();
 try{
  const {workspaceId,admin}=fixture.alpha;
  const token=(await issueSessionFor(fixture,fixture.alpha,admin)).accessToken;
  const mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status,history_id,history_id_updated_at,sync_state,baseline_from_at,baseline_completed_at) VALUES($1,$2,'recovery@example.test','recovery-account','connected','900',clock_timestamp(),'ready',clock_timestamp()-interval '30 days',clock_timestamp()) RETURNING *",[workspaceId,admin.userId])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'recovery-account',$4,1,1,true)",[workspaceId,mailbox.id,admin.userId,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'recovery-account',$4,1,1,true,1,'fixture',repeat('b',64),'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",[workspaceId,mailbox.id,admin.userId,binding]);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,suppressionJournal:recordingSuppressionJournal()});
  expect((await post('/crm/business/mail/import/request',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id})).status).toBe(200);
  await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,mailbox.id,admin.userId,binding]);
  const gmail=recordedGmailClient({emailAddress:'recovery@example.test',historyId:'100',messages:[]});
  let profiles=0;
  let gapMessageAt:number|null=null;
  let gapMetadataReads=0;
  const source=workerDueWorkSources({crmMailBackfill:true}).find(value=>value.name==='crm-mail-backfill')!;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail:{...gmail,getProfile:async()=>{
 profiles++;
 if(profiles===2&&scenario==='disconnected_profile')await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
 if(profiles===2&&scenario==='changed_profile')await fixture.db.query("UPDATE mailboxes SET provider_account_id='replacement-account',generation=2 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
 return {emailAddress:'recovery@example.test',historyId:profiles===1?'100':'500'};
} ,listMessageIds:async(...args)=>gapMessageAt===null?await gmail.listMessageIds(...args):{ok:true as const,messageIds:['during-gap'],nextPageToken:null},getMetadata:async()=>{gapMetadataReads++;return {id:'during-gap',threadId:'gap-thread',internalDateEpochMilliseconds:gapMessageAt!,labelIds:['INBOX'],headers:{From:'new-business@example.test',To:'recovery@example.test',Subject:'Business during gap'},attachments:[],sizeEstimate:10};},listHistory:async(_access,request)=>request.startHistoryId==='100'?{ok:false as const,reason:'history_expired' as const}:{ok:true as const,records:[{id:'501',changes:[{messageId:'during-gap',threadId:'gap-thread',kind:'message_added' as const,labelIds:['INBOX']}]}],nextPageToken:null,historyId:'501'}},resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'recovery-account',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver({categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'fixture-recovery-v1'})})}});
  const runtime=await fixture.database.appRuntimeSession();
  const first=(await claimJobs(runtime,{owner:'initial-recovery-import',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:first})).toBe('completed');
  const original=(await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body as {importId:string;fromAt:string;toAt:string};
  gapMessageAt=Date.parse(original.toAt)+1;
  await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  // The already enumerated original scope is fixture state; this test measures cursor recovery.
  await fixture.db.query("UPDATE crm_mail_import_slices SET state='complete' WHERE workspace_id=$1 AND import_id=$2",[workspaceId,original.importId]);
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1});
  const expired=(await claimJobs(runtime,{owner:'expired-original-cursor',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:expired})).toBe('completed');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({historyAnchor:'100',historyComplete:false,gapCoverage:{state:'pending_profile',originalCursor:'unavailable',windowFrozen:false,toAt:null}});
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  if(changedConfiguration){
   await fixture.db.query("UPDATE crm_mail_import_allocations SET revision=2,verification_sha256=repeat('f',64) WHERE workspace_id=$1 AND mailbox_id=$2",[workspaceId,mailbox.id]);
   const changed=(await claimJobs(runtime,{owner:'changed-recovery-allocation',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
   expect(await runClaimedJob(runtime,{registry,job:changed})).toBe('completed');
   expect(profiles).toBe(1);
   expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({gapCoverage:{epoch:2,state:'pending_profile',windowFrozen:false,toAt:null},quotaAccounting:{reservedUnits:'3',observedUnits:'3',unknownUnits:'0'}});
   expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1,externalActions:0});
  }
  if(scenario==='exhausted'){
   for(const revision of [3,4,5]){
    await fixture.db.query('UPDATE crm_mail_import_allocations SET revision=$3 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,revision]);
    const rotation=(await claimJobs(runtime,{owner:`rotation-${revision}`,kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
    expect(await runClaimedJob(runtime,{registry,job:rotation})).toBe('completed');
    expect(profiles).toBe(1);
    expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:revision===5?0:1});
   }
   expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({historyComplete:false,gapCoverage:{epoch:4,state:'blocked',reason:'configuration_changed',windowFrozen:false},quotaAccounting:{reservedUnits:'3',observedUnits:'3',unknownUnits:'0'}});
   await fixture.db.query('UPDATE crm_mail_import_allocations SET revision=6 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
   expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
   return;
  }
  const epoch=changedConfiguration?2:1;
  const recovery=(await claimJobs(runtime,{owner:'fresh-recovery-anchor',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:recovery})).toBe('completed');
  expect(profiles).toBe(2);
  if(scenario==='disconnected_profile'||scenario==='changed_profile'){
   expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({connectionState:scenario==='disconnected_profile'?'disconnected':'changed',historyComplete:false,gapCoverage:{epoch:1,state:'pending_profile',windowFrozen:false,toAt:null},quotaAccounting:{reservedUnits:'4',observedUnits:'4',unknownUnits:'0'}});
   expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
   expect(gapMetadataReads).toBe(0);
   expect(gmail.bodyReads).toEqual([]);
   expect(gmail.sends).toEqual([]);
   return;
  }
  const recovered=(await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body as {fromAt:string;toAt:string;gapCoverage:{fromAt:string;toAt:string}};
  expect(recovered).toMatchObject({fromAt:original.fromAt,toAt:original.toAt,historyAnchor:'100',historyComplete:false,gapCoverage:{state:'enumerating',epoch,originalCursor:'unavailable',windowFrozen:true,historyComplete:false,completedDays:0}});
  expect(recovered.gapCoverage.fromAt).toBe(original.toAt);
  expect(Date.parse(recovered.gapCoverage.toAt)).toBeGreaterThanOrEqual(Date.parse(recovered.gapCoverage.fromAt));
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1});
  const gapEnumeration=(await claimJobs(runtime,{owner:'recovery-gap-enumeration',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:gapEnumeration})).toBe('completed');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({historyComplete:false,gapCoverage:{state:'draining',epoch,totalDays:1,completedDays:1,historyComplete:false},metadataCoverage:{retainedUniqueMessages:'1',availableMetadataMessages:'1'}});
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:1});
  const freshHistory=(await claimJobs(runtime,{owner:'recovery-fresh-history',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  expect(await runClaimedJob(runtime,{registry,job:freshHistory})).toBe('completed');
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({fromAt:original.fromAt,toAt:original.toAt,historyAnchor:'100',historyComplete:false,gapCoverage:{state:'complete',epoch,totalDays:1,completedDays:1,historyComplete:true},metadataCoverage:{retainedUniqueMessages:'1',availableMetadataMessages:'1'},copyCoverage:{retainedCopiedBodies:'0',uncapturedMetadata:'1'},quotaAccounting:{reservedUnits:'8',observedUnits:'8',unknownUnits:'0'}});
  expect(gapMetadataReads).toBe(2);
  expect(await runSchedulerPass(runtime,{sources:[source],now:new Date().toISOString()})).toMatchObject({inserted:0,externalActions:0});
  expect(gmail.bodyReads).toEqual([]);

  expect(gmail.sends).toEqual([]);
 }finally{await fixture.stop();}
});
