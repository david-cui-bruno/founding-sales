import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { createApprovedBusinessMailObserver } from '@fss/domain/mail/crmSources.ts';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
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
    const post = (path:string,body:unknown) => dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}}, {session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
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
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect((await post('/crm/business/mail/import/request',{commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:mailbox.id})).status).toBe(200);
  const gmail=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[]});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail,resolveAccess:async()=>({mailboxId:mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:randomUUID(),expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  const job=(await claimJobs(fixture.db,{owner:'configured-backfill',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  await registry.get('crm.mail_backfill')!.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'blocked',reason:'quota_configuration_required',historyAnchor:null,historyComplete:false,completedSlices:0});
  expect(gmail.calls).toEqual([]);
  await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,mailbox.id,admin.userId,binding]);
  await registry.get('crm.mail_backfill')!.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect((await post('/crm/business/mail/import/read',{mailboxId:mailbox.id})).body).toMatchObject({state:'partial',historyAnchor:'100',windowFrozen:true,historyComplete:false,completedSlices:1});
 }finally{await fixture.stop();}
});
