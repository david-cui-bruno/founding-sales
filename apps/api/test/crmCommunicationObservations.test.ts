import {z} from 'zod';
import {historicalMailFixtureRegistry} from './support/crmForwardScopeFixture.ts';
import {crmProgressEventSchema} from '@fss/contracts';
import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {enqueueJob} from '@fss/domain/jobs/jobStore.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm} from './support/crmSeed.ts';
import {dispatch} from '../src/server.ts';

async function observationFixture(){
 const fixture=await createAuthFixture();
 const {workspaceId}=fixture.alpha,owner=fixture.alpha.admin;
 const firmId=await seedFirm(fixture,{name:'Observed correspondence',assignedUserId:owner.userId});
 const token=(await issueSessionFor(fixture,fixture.alpha,owner)).accessToken;
 const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
 const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
 const mailboxCache=new Map<string,{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>();
 const capture=async(providerId:string,origin:'sent'|'received'|'imported'|'unknown',captureOwner=owner.userId)=>{
  let mailbox=mailboxCache.get(captureOwner);
  if(mailbox===undefined){
  mailbox=(await fixture.db.query<{id:string;owner_user_id:string;email_address:string;provider_account_id:string;generation:number;status:string}>("INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,$3,$4,'connected') RETURNING *",[workspaceId,captureOwner,`${providerId}@business.test`,`account-${providerId}`])).rows[0]!;
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  await fixture.db.query("INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,$4,$5,1,1,false)",[workspaceId,mailbox.id,captureOwner,mailbox.provider_account_id,binding]);
  await fixture.db.query("INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,$4,$5,1,1,true,1,'controlled',repeat('b',64),'grant','policy','evaluation','release')",[workspaceId,mailbox.id,captureOwner,mailbox.provider_account_id,binding]);
  mailboxCache.set(captureOwner,mailbox);
  }
  const binding=businessAccountBinding(workspaceId,mailbox)!;
  const conversationId=(await fixture.db.query<{id:string}>("INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,$5,'Business','[]','2026-10-08T15:00:00Z','business','fixture','fixture',repeat('a',64)) RETURNING id",[workspaceId,mailbox.id,captureOwner,binding,providerId])).rows[0]!.id;
  await enqueueJob(fixture.db,{workspaceId,kind:'crm.mail_capture',idempotencyKey:providerId,payload:{mailboxId:mailbox.id,providerMessageId:providerId,providerAccountId:mailbox.provider_account_id,generation:1,conversationId,controlsRevision:1,policyRevision:1,decisionRevision:0}});
  const outgoing=origin==='sent';
  const registry=historicalMailFixtureRegistry({classifier:undefined,mail:undefined,send:undefined,research:undefined,retainedMailFixture: { original:{read:async()=>({providerAccountId:mailbox.provider_account_id,messageId:providerId,threadId:providerId,origin,labels:outgoing?['SENT']:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:outgoing?mailbox.email_address:'shared@customer.test',to:[outgoing?'shared@customer.test':mailbox.email_address],cc:[],subject:'Business',body:'Can we discuss repairs?',parserVersion:'controlled-unknown-authorship',representation:'plain_text',completeness:'complete',ranges:[{start:0,end:23,kind:'unknown'}]})}}});
  await runOnce(fixture.db,{registry,owner:'observed-capture',limit:20});
  const sourceId=(await fixture.db.query<{source_id:string}>('SELECT s.source_id FROM crm_mail_sources s JOIN mail_messages m ON m.workspace_id=s.workspace_id AND m.id=s.source_id WHERE s.workspace_id=$1 AND s.mailbox_id=$2 AND m.provider_message_id=$3',[workspaceId,mailbox.id,providerId])).rows[0]!.source_id;
  expect((await post('/crm/business/mail/associate',command({sourceId,expectedRevision:1,firmId}))).status).toBe(200);
  return sourceId;
 };
 return {fixture,workspaceId,firmId,post,command,capture};
}

it('shows ordinary observed correspondence without inventing authorship, verified progress or reply relation',async()=>{
 const f=await observationFixture();
 try{
  const sent=await f.capture('sent','sent'),received=await f.capture('received','received');
  await f.capture('unknown','unknown');await f.capture('imported','imported');
  const read=await f.post('/crm/progress/read',{includeCommunicationObservations:true,firmId:f.firmId});
  expect(read.status).toBe(200);
  expect(read.body).toMatchObject({events:[],coverage:'partial',communicationObservationsTruncated:false,communicationObservations:expect.arrayContaining([
   {id:sent,kind:'message_sent',occurredAt:'2026-10-08T15:00:00.000Z',dateBasis:'provider_event',observedAt:expect.any(String),firmIds:[f.firmId],personIds:[],source:expect.objectContaining({sourceId:sent,revision:2,speaker:null}),attribution:'observed_correspondence',humanAuthorship:'not_verified',replyRelation:'not_established'},
   {id:received,kind:'message_received',occurredAt:'2026-10-08T15:00:00.000Z',dateBasis:'provider_event',observedAt:expect.any(String),firmIds:[f.firmId],personIds:[],source:expect.objectContaining({sourceId:received,revision:2,speaker:null}),attribution:'observed_correspondence',humanAuthorship:'not_verified',replyRelation:'not_established'},
  ])});
  expect((read.body as {communicationObservations:unknown[]}).communicationObservations).toHaveLength(2);
  const sentSource=(read.body as {communicationObservations:{source:{sourceId:string;contentHash:string}}[]}).communicationObservations.find(row=>row.source.sourceId===sent)!.source;
  expect((await f.post('/crm/business/mail/read',{sourceId:sent,sourceRevision:2,contentHash:sentSource.contentHash})).body).toMatchObject({source:{sentProof:false,ranges:[{start:0,end:23,kind:'unknown'}]}});
 }finally{await f.fixture.stop();}
});

it('removes erased originals from observed correspondence and preserves bounded partial coverage',async()=>{
 const f=await observationFixture();
 try{
  const first=await f.capture('first','sent');await f.capture('second','received');
  expect((await f.post('/crm/progress/read',{includeCommunicationObservations:true,firmId:f.firmId,limit:1})).body).toMatchObject({events:[],coverage:'partial',communicationObservations:[expect.any(Object)],communicationObservationsTruncated:true});
  expect((await f.post('/crm/business/mail/delete',f.command({sourceId:first,expectedRevision:2}))).status).toBe(200);
  const after=(await f.post('/crm/progress/read',{includeCommunicationObservations:true,firmId:f.firmId})).body as {communicationObservations:{id:string}[]};
  expect(after.communicationObservations).toHaveLength(1);
  expect(after.communicationObservations.some(row=>row.id===first)).toBe(false);
 }finally{await f.fixture.stop();}
});

it('does not expand an administrator record read into another owner mailbox or admit inconsistent direction',async()=>{
 const f=await observationFixture();
 try{
  await f.capture('other-owner','received',f.fixture.alpha.salesperson.userId);
  const sourceId=await f.capture('inconsistent','sent');
  await f.fixture.db.query("UPDATE mail_messages SET direction='incoming' WHERE workspace_id=$1 AND id=$2",[f.workspaceId,sourceId]);
  expect((await f.post('/crm/progress/read',{includeCommunicationObservations:true,firmId:f.firmId})).body).toMatchObject({events:[],communicationObservations:[],communicationObservationsTruncated:false});
 }finally{await f.fixture.stop();}
});

it('uses explicitly associated source person context without asserting that person authored a shared-endpoint message',async()=>{
 const f=await observationFixture();
 try{
  const sourceId=await f.capture('shared-endpoint','received');
  const created=await f.post('/crm/people/create',f.command({fullName:'Explicit business correspondent'}));
  expect(created.status).toBe(200);
  const personId=(created.body as {result:{personId:string}}).result.personId;
  expect((await f.post('/crm/business/mail/associate',f.command({sourceId,expectedRevision:2,personId,firmId:f.firmId}))).status).toBe(200);
  expect((await f.post('/crm/progress/read',{includeCommunicationObservations:true,personId})).body).toMatchObject({events:[],communicationObservations:[{id:sourceId,personIds:[personId],firmIds:[f.firmId],humanAuthorship:'not_verified',replyRelation:'not_established',source:{revision:3,speaker:null}}]});
 }finally{await f.fixture.stop();}
});

it('excludes diagnostic-only copied sources even when their provider origin and direction look ordinary',async()=>{
 const f=await observationFixture();
 try{
  const sourceId=await f.capture('diagnostic-only','received');
  const source=(await f.fixture.db.query<{owner_user_id:string;mailbox_id:string}>('SELECT owner_user_id,mailbox_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',[f.workspaceId,sourceId])).rows[0]!;
  const id=randomUUID();
  const document={id,purpose:'acquisition_acceptance',workspaceId:f.workspaceId,ownerUserId:source.owner_user_id,mailboxId:source.mailbox_id};
  await f.fixture.db.query("INSERT INTO crm_acquisition_diagnostic_authorizations(workspace_id,id,owner_user_id,mailbox_id,authorization_sha256,authorization_document,verified_at,valid_until) VALUES($1,$2,$3,$4,repeat('a',64),$5::jsonb,'2026-10-01T00:00:00Z','2026-11-01T00:00:00Z')",[f.workspaceId,id,source.owner_user_id,source.mailbox_id,JSON.stringify(document)]);
  await f.fixture.db.query('UPDATE crm_mail_sources SET conversation_id=NULL,diagnostic_authorization_id=$3 WHERE workspace_id=$1 AND source_id=$2',[f.workspaceId,sourceId,id]);
  expect((await f.post('/crm/progress/read',{includeCommunicationObservations:true,firmId:f.firmId})).body).toMatchObject({events:[],communicationObservations:[],communicationObservationsTruncated:false});
 }finally{await f.fixture.stop();}
});


it('preserves the admitted legacy progress response unless observations are explicitly requested',async()=>{
 const f=await observationFixture();
 try{
  await f.capture('legacy-compatible','received');
  // Exact previously released wire shape: olddesktop rejects unknown keys.
  const legacy=z.strictObject({version:z.literal(1),events:z.array(crmProgressEventSchema).max(50),truncated:z.boolean(),coverage:z.literal('partial')});
  for(const body of [{firmId:f.firmId},{firmId:f.firmId,includeCommunicationObservations:false}]){
   const read=await f.post('/crm/progress/read',body);
   expect(read.status).toBe(200);
   expect(legacy.parse(read.body)).toEqual({version:1,events:[],truncated:false,coverage:'partial'});
  }
  expect((await f.post('/crm/progress/read',{firmId:f.firmId,includeCommunicationObservations:true})).body).toMatchObject({communicationObservations:[{kind:'message_received'}]});
 }finally{await f.fixture.stop();}
});
