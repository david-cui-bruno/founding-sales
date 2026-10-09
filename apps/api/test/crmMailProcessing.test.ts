import {seedFirm} from './support/crmSeed.ts';
import { createHash,randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNativeCrmMailEvidence } from '@fss/domain/crm/nativeMailEvidence.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding,METADATA_REVIEW_DISCLOSURE } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import {workerDueWorkSources} from '../../worker/src/bootstrap/main.ts';
import {runSchedulerPass} from '../../worker/src/scheduler/schedulerPass.ts';
import { runOnce } from '../../worker/src/runner/jobRunner.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { createAuthFixture,CURRENT_CLIENT_VERSION } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { dispatch } from '../src/server.ts';
async function approveCaptureFixture(
  fixture: Awaited<ReturnType<typeof createAuthFixture>>,
  ownerUserId = fixture.alpha.admin.userId,
) {
  const workspaceId = fixture.alpha.workspaceId;
  const mailbox = (
    await fixture.db.query<{
      id: string;
      owner_user_id: string;
      email_address: string;
      provider_account_id: string;
      generation: number;
      status: string;
    }>(
      "INSERT INTO mailboxes(workspace_id,owner_user_id,email_address,provider_account_id,status) VALUES($1,$2,'business@example.test','google-business','connected') RETURNING *",
      [workspaceId, ownerUserId],
    )
  ).rows[0]!;
  const binding = businessAccountBinding(workspaceId, mailbox)!;
  await fixture.db.query(
    "INSERT INTO crm_business_policies(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled) VALUES($1,$2,$3,'google-business',$4,1,1,false)",
    [workspaceId, mailbox.id, ownerUserId, binding],
  );
  const conversationId = (
    await fixture.db.query<{ id: string }>(
      "INSERT INTO crm_business_conversations(workspace_id,mailbox_id,owner_user_id,account_binding,provider_thread_id,subject,participants,latest_provider_at,category,reason,classifier_version,metadata_hash) VALUES($1,$2,$3,$4,'approved-thread','Business','[]',now(),'business','fixture','fixture',$5) RETURNING id",
      [workspaceId, mailbox.id, ownerUserId, binding, 'a'.repeat(64)],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO crm_mail_capture_controls(workspace_id,mailbox_id,owner_user_id,provider_account_id,account_binding,generation,revision,enabled,policy_revision,disclosure_version,disclosure_sha256,grant_receipt,provider_policy_receipt,evaluation_receipt,release_receipt) VALUES($1,$2,$3,'google-business',$4,1,1,true,1,'full-body-fixture',$5,'fixture-grant','fixture-provider','fixture-evaluation','fixture-release')",
    [workspaceId, mailbox.id, ownerUserId, binding, 'b'.repeat(64)],
  );
  await enqueueJob(fixture.db, {
    workspaceId,
    kind: 'crm.mail_capture',
    idempotencyKey: 'approved-fixture',
    payload: {
      mailboxId: mailbox.id,
      providerMessageId: 'approved-message',
      providerAccountId: 'google-business',
      generation: 1,
      conversationId,
      controlsRevision: 1,
      policyRevision: 1,
      decisionRevision: 0,
    },
  });
  const job = (
    await claimJobs(fixture.db, {
      owner: 'capture-fixture',
      kinds: ['crm.mail_capture'],
      limit: 1,
      leaseSeconds: 120,
    })
  )[0]!;
  return { workspaceId, ownerUserId, mailbox, binding, conversationId, job };
}

it('reads exact native copied mail evidence after disconnect without granting processing or fetching again', async () => {
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,mailbox,binding,job}=await approveCaptureFixture(fixture);
  const originalFirmId=await seedFirm(fixture,{name:'Acquired firm A',assignedUserId:fixture.alpha.admin.userId});
  const reviewedFirmId=await seedFirm(fixture,{name:'Explicit firm B',assignedUserId:fixture.alpha.admin.userId});
  const opportunityId=(await fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id',[workspaceId,originalFirmId])).rows[0]!.id;
  const canonicalId=(await fixture.db.query<{id:string}>("INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,'approved-message','approved-thread','incoming','2026-10-08T15:00:00Z',true) RETURNING id",[workspaceId,mailbox.id])).rows[0]!.id;
  await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,'thread')",[workspaceId,canonicalId,originalFirmId,opportunityId]);
  const passage='Could we discuss maintenance next week?';let reads=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding},provider:{read:async()=>{reads++;return {providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]};}}}});
  const handler=registry.get('crm.mail_capture');if(!handler)throw new Error('capture handler absent');
  const captured=await handler.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native capture failed');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const port=createNativeCrmMailEvidence();
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(body:unknown)=>dispatch({method:'POST',path:'/crm/processing/source/read',body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const metadata=await post(source);
  expect(metadata.status).toBe(200);
  expect(metadata.body).toMatchObject({source:{sourceId,kind:'mail',revision:1,completeness:'partial',speaker:null},extent:{unit:'utf16',length:39},passage:null});
  expect(JSON.stringify(metadata.body)).not.toContain(passage);
  const requested=await dispatch({method:'POST',path:'/crm/processing/request',body:{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  expect(requested.status).toBe(200);
  expect(requested.body).toMatchObject({result:{state:'unavailable',reason:'mail_processing_authority_unavailable',claims:[]}});
  const verifiedPort=createNativeCrmMailEvidence({verify:async proof=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding});
  const authorized=await dispatch({method:'POST',path:'/crm/processing/request',body:{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:verifiedPort});
  expect(authorized.status).toBe(200);
  expect(authorized.body).toMatchObject({result:{state:'unavailable',reason:'purpose_not_configured',claims:[]}});
  const first=requested.body as {result:{generationId:string;authorizationHash:string}};
  const next=authorized.body as {result:{generationId:string;authorizationHash:string}};
  expect(next.result.generationId).not.toBe(first.result.generationId);
  expect(next.result.authorizationHash).not.toBe(first.result.authorizationHash);
  const commandPost=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:verifiedPort});
  expect((await commandPost('/crm/processing/purpose/save',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1})).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  expect((await commandPost('/crm/processing/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source})).status).toBe(200);
  let modelCalls=0;
  const extraction=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:verifiedPort,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async input=>{modelCalls++;expect(input.text).toContain('"completeness":"partial"');return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion requested',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  await runOnce(fixture.db,{registry:extraction,owner:'mail-extraction-evaluation',limit:20});
  expect(modelCalls).toBe(1);
  const processed=await commandPost('/crm/processing/read',{source});
  expect(processed.body).toMatchObject({state:'complete',claims:[{quote:'Could we',source:{kind:'mail',sourceId,revision:1,completeness:'partial',speaker:null},context:{personId:null,firmIds:[originalFirmId],relationships:[],mailContexts:expect.arrayContaining([expect.objectContaining({kind:'acquired',firmId:originalFirmId,opportunityId})])}}],financial:{dispatchState:'settled',settledCents:1}});
  expect((await commandPost('/crm/business/mail/associate',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId,expectedRevision:1,firmId:reviewedFirmId})).status).toBe(200);
  source.revision=2;
  expect((await commandPost('/crm/processing/request',{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,source})).status).toBe(200);
  await runOnce(fixture.db,{registry:extraction,owner:'mail-reviewed-context-evaluation',limit:20});
  expect(modelCalls).toBe(2);
  expect((await commandPost('/crm/processing/read',{source})).body).toMatchObject({state:'complete',claims:[{context:{personId:null,relationships:[],mailContexts:expect.arrayContaining([expect.objectContaining({kind:'acquired',firmId:originalFirmId,sourceRevision:1}),expect.objectContaining({kind:'reviewed',firmId:reviewedFirmId,sourceRevision:2})])}}]});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post({...source,locator:'text:0:8'})).body).toMatchObject({passage:{text:'Could we',locator:'text:0:8',speaker:null}});
  const health=()=>dispatch({method:'POST',path:'/crm/processing/health/read',body:{sourceId,kind:'mail'},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  expect((await health()).body).toMatchObject({sourceId,sourceRevision:2,availability:'available',unknownAcceptance:false});
  const deleted=await dispatch({method:'POST',path:'/crm/business/mail/delete',body:{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId,expectedRevision:2},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect(deleted.status).toBe(200);
  expect((await health()).body).toMatchObject({sourceId,sourceRevision:3,availability:'deleted',generations:expect.arrayContaining([expect.objectContaining({state:'deleted'})]),unknownAcceptance:false});
  const deletedHealth=(await health()).body as {generations:{state:string}[]};
  expect(deletedHealth.generations.every(generation=>generation.state==='deleted')).toBe(true);
  expect(reads).toBe(1);
 } finally {await fixture.stop();}
});


it('conserves unknown native mail spend across disconnect, reconnect and explicit copy deletion without repeating the model',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,mailbox,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'unknown',usage:null,claims:[]};}}}});
  await runOnce(fixture.db,{registry,owner:'mail-unknown-evaluation',limit:20});
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',financial:{dispatchState:'unknown_acceptance',settlementState:'estimated'}});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post('/crm/processing/source/read',source)).status).toBe(200);
  await fixture.db.query("UPDATE mailboxes SET status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  await fixture.db.query('UPDATE crm_mail_capture_controls SET generation=2,revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  await fixture.db.query('UPDATE crm_business_policies SET generation=2 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  const fresh=await post('/crm/processing/request',command({source}));expect(fresh.status).toBe(200);
  await runOnce(fixture.db,{registry,owner:'mail-reconnected-evaluation',limit:20});
  expect(calls).toBe(1);
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',reason:'prior_acceptance_unknown'});
  expect((await post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}))).status).toBe(200);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',unknownAcceptance:true,generations:expect.arrayContaining([expect.objectContaining({state:'deleted',financial:expect.objectContaining({dispatchState:'unknown_acceptance',settlementState:'estimated'})})])});
 }finally{await fixture.stop();}
});

it('releases native CRM locks during model wait and discards deleted-source output while settling payment',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;let release!:()=>void;let started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;started();await waiting;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry,owner:'mail-provider-wait-evaluation',limit:20});
  await entered;
  try {
   expect((await post('/crm/people/create',command({fullName:'Unrelated during native model wait'}))).status).toBe(200);
   expect((await post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}))).status).toBe(200);
  } finally {release();}
  await running;
  expect(calls).toBe(1);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',unknownAcceptance:false,generations:[{state:'deleted',claims:[],financial:{dispatchState:'settled',settledCents:1}}]});
  expect((await post('/crm/processing/source/read',source)).status).toBe(404);
 }finally{await fixture.stop();}
});

it('holds no copy locks during native proof verification and refuses paid reserve after deletion',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  let checking=false;let releaseProof!:()=>void;let proofStarted!:()=>void;
  const proofWait=new Promise<void>(resolve=>{releaseProof=resolve;}),proofEntered=new Promise<void>(resolve=>{proofStarted=resolve;});
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence({verify:async proof=>{if(checking){proofStarted();await proofWait;}return verifier.verify(proof);}});
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  checking=true;
  const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry,owner:'mail-proof-wait-evaluation',limit:20});
  await proofEntered;
  const deleted=post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}));
  let observedStatus:number|undefined;
  try {
   const result=await Promise.race([deleted,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);
   observedStatus=result?.status;
  }finally{releaseProof();}
  await deleted;await running;
  expect(observedStatus).toBe(200);
  expect(calls).toBe(0);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',unknownAcceptance:false,generations:[{state:'deleted',claims:[],financial:null}]});
 }finally{await fixture.stop();}
});

it('discards native model output after explicit business exclusion during the provider wait while retaining the permitted copy',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,mailbox,binding,conversationId,job}=await approveCaptureFixture(fixture);
  await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;let release!:()=>void;let started!:()=>void;const waiting=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{started=resolve;});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;started();await waiting;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry,owner:'mail-provider-wait-evaluation',limit:20});
  await entered;
  const statuses:number[]=[];
  try {
   statuses.push((await post('/crm/people/create',command({fullName:'Unrelated during native model wait'}))).status);
   statuses.push((await post('/crm/business/review/decide',command({mailboxId:mailbox.id,conversationId,expectedGeneration:1,expectedAccountBinding:binding,expectedPolicyRevision:1,expectedMetadataRevision:1,expectedDecisionRevision:0,decision:'exclude'}))).status);
  } finally {release();}
  await running;
  expect(statuses).toEqual([200,200]);
  expect(calls).toBe(1);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'available',unknownAcceptance:false,generations:[{state:'stale',claims:[],financial:{dispatchState:'settled',settledCents:1}}]});
  expect((await post('/crm/processing/source/read',source)).status).toBe(200);
 }finally{await fixture.stop();}
});


it('rechecks proof outside the publication transaction and settles accepted native output after concurrent deletion',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  let checking=false;let proofChecks=0;let releaseProof!:()=>void;let proofStarted!:()=>void;
  const proofWait=new Promise<void>(resolve=>{releaseProof=resolve;}),proofEntered=new Promise<void>(resolve=>{proofStarted=resolve;});
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence({verify:async proof=>{if(checking&&++proofChecks===3){proofStarted();await proofWait;}return verifier.verify(proof);}});
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  checking=true;
  const worker=await fixture.database.appRuntimeSession();const running=runOnce(worker,{registry,owner:'mail-proof-wait-evaluation',limit:20});
  await proofEntered;
  const deleted=post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}));
  let observedStatus:number|undefined;
  try {
   const result=await Promise.race([deleted,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);
   observedStatus=result?.status;
  }finally{releaseProof();}
  await deleted;await running;
  expect(observedStatus).toBe(200);
  expect(calls).toBe(1);expect(proofChecks).toBe(3);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',unknownAcceptance:false,generations:[{state:'deleted',claims:[],financial:{dispatchState:'settled',settledCents:1}}]});
 }finally{await fixture.stop();}
});


it('materializes configured native mail intents through registered fenced work without duplicating the paid generation',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  let proofChecks=0;
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>{proofChecks++;return proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding;}};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  const proofChecksBeforeScheduler=proofChecks;
  const scheduled=await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:30:00Z'});
  expect(scheduled.outcome).toBe('ran');
  expect(proofChecks).toBe(proofChecksBeforeScheduler);
  await runOnce(fixture.db,{registry,owner:'mail-intent-materialization',limit:100});
  await runOnce(fixture.db,{registry,owner:'mail-intent-extraction',limit:100});
  expect(calls).toBe(1);
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'complete',claims:[{quote:'Could we'}]});
  await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:31:00Z'});
  await runOnce(fixture.db,{registry,owner:'mail-intent-replay',limit:100});
  expect(calls).toBe(1);
 }finally{await fixture.stop();}
});


it('refuses an old scheduler intent after the public purpose revision changes',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  let proofChecks=0;
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>{proofChecks++;return proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding;}};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  const proofChecksBeforeScheduler=proofChecks;
  const scheduled=await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:30:00Z'});
  expect(scheduled.outcome).toBe('ran');
  expect(proofChecks).toBe(proofChecksBeforeScheduler);
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:1,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await runOnce(fixture.db,{registry,owner:'stale-mail-intent',limit:100});
  await runOnce(fixture.db,{registry,owner:'no-stale-mail-extraction',limit:100});
  expect(calls).toBe(0);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'available',generations:[]});
 }finally{await fixture.stop();}
});

it('discards a scheduled intent when source deletion completes during its external proof wait',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  let proofChecks=0,pauseProof=false;let releaseProof!:()=>void,enteredProof!:()=>void;
  const proofEntered=new Promise<void>(resolve=>{enteredProof=resolve;}),proofRelease=new Promise<void>(resolve=>{releaseProof=resolve;});
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>{proofChecks++;if(pauseProof){enteredProof();await proofRelease;}return proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding;}};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  const proofChecksBeforeScheduler=proofChecks;
  const scheduled=await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:30:00Z'});
  expect(scheduled.outcome).toBe('ran');
  expect(proofChecks).toBe(proofChecksBeforeScheduler);
  pauseProof=true;
  const worker=await fixture.database.appRuntimeSession();
  const running=runOnce(worker,{registry,owner:'scheduled-mail-proof-wait',limit:100});
  await proofEntered;
  const deleting=post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}));
  let deletionStatus:number|undefined;
  try{const result=await Promise.race([deleting,new Promise<null>(resolve=>setTimeout(()=>resolve(null),500))]);deletionStatus=result?.status;}finally{releaseProof();}
  await deleting;await running;
  expect(deletionStatus).toBe(200);expect(calls).toBe(0);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',generations:[],unknownAcceptance:false});
 }finally{await fixture.stop();}
});

it('fairly reaches a fresh eligible source after more than one bounded page of refused intents',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  let proofChecks=0;
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>{proofChecks++;return proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding;}};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'accepted',usage:{inputTokens:20,outputTokens:30},claims:[{kind:'need',interpretation:'Maintenance discussion',status:'stated',locator:'text:0:8',quote:'Could we'}]};}}}});
  // Historical copies with no current account binding are valid refused work.
  // Their IDs precede the fresh source; no body or verifier may be loaded for them.
  for(let n=1;n<=101;n++){
   const staleId=`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
   await fixture.db.query(`INSERT INTO mail_messages(workspace_id,id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) SELECT workspace_id,$2,mailbox_id,$3,provider_thread_id,direction,internal_date,matched FROM mail_messages WHERE workspace_id=$1 AND id=$4`,[workspaceId,staleId,`old-proof-${n}`,sourceId]);
   await fixture.db.query(`INSERT INTO crm_mail_sources SELECT (jsonb_populate_record(NULL::crm_mail_sources,to_jsonb(s)||jsonb_build_object('source_id',$3::text,'account_binding',repeat('f',64)))).* FROM crm_mail_sources s WHERE workspace_id=$1 AND source_id=$2`,[workspaceId,sourceId,staleId]);
   await fixture.db.query(`INSERT INTO crm_mail_source_intents(workspace_id,id,source_kind,source_id,source_revision,content_hash) VALUES($1,$2,'mail',$2,1,$3)`,[workspaceId,staleId,source.contentHash]);
  }
  const checksBefore=proofChecks;
  await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:30:00Z'});
  await runSchedulerPass(fixture.db,{sources:workerDueWorkSources({crmMailProcessing:port}),now:'2026-10-09T08:31:00Z'});
  expect(proofChecks).toBe(checksBefore);
  await runOnce(fixture.db,{registry,owner:'fair-mail-intent',limit:100});
  await runOnce(fixture.db,{registry,owner:'fair-mail-extraction',limit:100});
  expect(calls).toBe(1);
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'complete',claims:[{quote:'Could we'}]});
 }finally{await fixture.stop();}
});

it('retains the conservative charge and replay blocker when unknown acceptance reports zero usage',async()=>{
 const fixture=await createAuthFixture();
 try {
  const {workspaceId,mailbox,binding,job}=await approveCaptureFixture(fixture);
  const passage='Could we discuss maintenance next week?';
  const verifier={verify:async (proof:{grantReceipt:string;accountBinding:string})=>proof.grantReceipt==='fixture-grant'&&proof.accountBinding===binding};
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:verifier,provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:['INBOX'],providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:'Unknown@business.test',to:['business@example.test'],cc:[],subject:'Business',body:passage,parserVersion:'fixture-mime-v1',representation:'plain_text',completeness:'partial',ranges:[{start:0,end:passage.length,kind:'unknown'}]})}}}).get('crm.mail_capture');
  if(!capture)throw new Error('capture unavailable');
  const captured=await capture.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  const sourceId=captured?.progress['sourceId'];if(typeof sourceId!=='string')throw new Error('native source unavailable');
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken,port=createNativeCrmMailEvidence(verifier);
  const source={workspaceId,sourceId,kind:'mail' as const,revision:1,contentHash:createHash('sha256').update(passage).digest('hex'),locator:null};
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=(fields:object)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  await post('/crm/processing/request',command({source}));
  let calls=0;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{mailEvidence:port,adapter:{endpointId:'mail-evaluation',modelVersion:'fixture-mail-v1',accessGrantVersion:'fixture-mail-grant',dataHandlingVersion:'fixture-mail-partial-policy',providerKey:'fixture.crm_extraction',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>{calls++;return {acceptance:'unknown',usage:{inputTokens:0,outputTokens:0},claims:[]};}}}});
  await runOnce(fixture.db,{registry,owner:'mail-unknown-evaluation',limit:20});
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',financial:{dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:1}});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post('/crm/processing/source/read',source)).status).toBe(200);
  await fixture.db.query("UPDATE mailboxes SET status='connected',disconnected_at=NULL WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  await fixture.db.query('UPDATE crm_mail_capture_controls SET generation=2,revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  await fixture.db.query('UPDATE crm_business_policies SET generation=2 WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,mailbox.id]);
  const fresh=await post('/crm/processing/request',command({source}));expect(fresh.status).toBe(200);
  await runOnce(fixture.db,{registry,owner:'mail-reconnected-evaluation',limit:20});
  expect(calls).toBe(1);
  expect((await post('/crm/processing/read',{source})).body).toMatchObject({state:'unknown_acceptance',reason:'prior_acceptance_unknown'});
  expect((await post('/crm/business/mail/delete',command({sourceId,expectedRevision:1}))).status).toBe(200);
  expect((await post('/crm/processing/health/read',{sourceId,kind:'mail'})).body).toMatchObject({availability:'deleted',unknownAcceptance:true,generations:expect.arrayContaining([expect.objectContaining({state:'deleted',financial:expect.objectContaining({dispatchState:'unknown_acceptance',settlementState:'estimated',settledCents:1})})])});
 }finally{await fixture.stop();}
});
