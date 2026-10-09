import { createHash,randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNativeCrmMailEvidence } from '@fss/domain/crm/nativeMailEvidence.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { enqueueJob, claimJobs } from '@fss/domain/jobs/jobStore.ts';
import { businessAccountBinding } from '@fss/domain/business/acquisition.ts';
import { workspaceScope } from '@fss/domain/db/workspaceScope.ts';
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
  expect(processed.body).toMatchObject({state:'complete',claims:[{quote:'Could we',source:{kind:'mail',sourceId,revision:1,completeness:'partial',speaker:null},context:{personId:null,firmIds:[],relationships:[],review:'required',mailContexts:[]}}],financial:{dispatchState:'settled',settledCents:1}});
  await fixture.db.query("UPDATE mailboxes SET status='disconnected',disconnected_at=now(),generation=generation+1 WHERE workspace_id=$1 AND id=$2",[workspaceId,mailbox.id]);
  expect((await post({...source,locator:'text:0:8'})).body).toMatchObject({passage:{text:'Could we',locator:'text:0:8',speaker:null}});
  const health=()=>dispatch({method:'POST',path:'/crm/processing/health/read',body:{sourceId,kind:'mail'},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  expect((await health()).body).toMatchObject({sourceId,sourceRevision:1,availability:'available',unknownAcceptance:false});
  const deleted=await dispatch({method:'POST',path:'/crm/business/mail/delete',body:{commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,sourceId,expectedRevision:1},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  expect(deleted.status).toBe(200);
  expect((await health()).body).toMatchObject({sourceId,sourceRevision:2,availability:'deleted',generations:expect.arrayContaining([expect.objectContaining({state:'deleted'})]),unknownAcceptance:false});
  const deletedHealth=(await health()).body as {generations:{state:string}[]};
  expect(deletedHealth.generations.every(generation=>generation.state==='deleted')).toBe(true);
  expect(reads).toBe(1);
 } finally {await fixture.stop();}
});
