import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {crmProcessingResultSchema} from '@fss/contracts';
import {createNativeCrmMailEvidence} from '@fss/domain/crm/nativeMailEvidence.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {businessAccountBinding} from '@fss/domain/business/acquisition.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import {dispatch} from '../src/server.ts';
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


it.each([
 {name:'unknown native context',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'multiple native people',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'review required recaptured native context',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'human review veto',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'dated human dismissal veto',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'old dated promise',quote:'I will prepare the repair summary by 2020-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:true},
 {name:'other sender',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'forwarded passage',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'forwarded' as const,eligible:false},
 {name:'same verified action after completed rerun',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:true},
 {name:'lost exact intent lease',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'complete authored Sent',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:true},
 {name:'quoted passage',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'quoted' as const,eligible:false},
 {name:'actual parser partial body',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'partial' as const,rangeKind:'authored' as const,eligible:false},
 {name:'unknown origin',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'unknown' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'draft label',quote:'I will prepare the repair summary by 2026-10-12 UTC.',origin:'unknown' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'conditional',quote:'I will prepare the repair summary by 2026-10-12 UTC if approved.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'relative date without source zone',quote:'I will prepare the repair summary by tomorrow.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'commercial promise',quote:'I will prepare the contract by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
 {name:'unknown actor',quote:'They will prepare the repair summary by 2026-10-12 UTC.',origin:'sent' as const,completeness:'complete' as const,rangeKind:'authored' as const,eligible:false},
])('uses actual registered native capture/extraction/intent: $name',async({name,quote,origin,completeness,rangeKind,eligible})=>{
 const fixture=await createAuthFixture();try{
  const {workspaceId,mailbox,binding,job}=await approveCaptureFixture(fixture);
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const port=createNativeCrmMailEvidence({verify:async proof=>proof.accountBinding===binding});
  const post=(path:string,body:unknown)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false,crmMailEvidence:port});
  const command=<T extends object>(fields:T)=>({commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION,...fields});
  const firmId=await seedFirm(fixture,{name:'Verified promise firm',assignedUserId:fixture.alpha.admin.userId});
  const contactId=await seedContact(fixture,{firmId,fullName:'Known promise correspondent'});
  expect((await post('/crm/people/bridge',command({contactIds:[contactId]}))).status).toBe(200);
  const message=(await fixture.db.query<{id:string}>("INSERT INTO mail_messages(workspace_id,mailbox_id,provider_message_id,provider_thread_id,direction,internal_date,matched) VALUES($1,$2,'approved-message','approved-thread','outgoing','2026-10-08T15:00:00Z',true) RETURNING id",[workspaceId,mailbox.id])).rows[0]!;
  const opportunityId=(await fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id',[workspaceId,firmId])).rows[0]!.id;
  if(name!=='unknown native context'&&name!=='review required recaptured native context')await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,contact_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",[workspaceId,message.id,firmId,contactId,opportunityId]);
  let secondPersonId:string|null=null;
  if(name==='multiple native people'){
   const otherId=await seedContact(fixture,{firmId,fullName:'Second distinct correspondent'});
   expect((await post('/crm/people/bridge',command({contactIds:[otherId]}))).status).toBe(200);
   secondPersonId=otherId;
   const otherOpportunity=(await fixture.db.query<{id:string}>('INSERT INTO opportunities(workspace_id,firm_id,stage_id,control_mode_changed_at) VALUES($1,$2,(SELECT id FROM pipeline_stages WHERE workspace_id=$1 ORDER BY position LIMIT 1),now()) RETURNING id',[workspaceId,firmId])).rows[0]!.id;
   await fixture.db.query("INSERT INTO mail_message_matches(workspace_id,mail_message_id,firm_id,contact_id,opportunity_id,match_rule) VALUES($1,$2,$3,$4,$5,'thread')",[workspaceId,message.id,firmId,otherId,otherOpportunity]);
  }
  const capture=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:{verify:async proof=>proof.accountBinding===binding},provider:{read:async()=>({providerAccountId:'google-business',messageId:'approved-message',threadId:'approved-thread',labels:name==='draft label'?['DRAFT']:['SENT'],origin,providerAt:'2026-10-08T15:00:00.000Z',rawSenderDate:null,from:name==='other sender'?'someoneelse@example.test':'business@example.test',to:['known@example.test'],cc:[],subject:'Repair summary',body:quote,parserVersion:'controlled-authored-mime-v1',representation:'plain_text',completeness,ranges:[{start:0,end:quote.length,kind:rangeKind}]})}}});
  const handler=capture.get('crm.mail_capture');if(!handler)throw new Error('capture registration missing');
  const captured=await handler.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});
  expect(captured?.progress['sourceId']).toBe(message.id);
  let revision=1;
  if(name!=='unknown native context'&&name!=='review required recaptured native context'){
   expect((await post('/crm/business/mail/associate',command({sourceId:message.id,expectedRevision:1,personId:contactId,firmId}))).status).toBe(200);
   revision=2;
   if(secondPersonId!==null){
    // Controlled native-copy context fixture; the native adapter resolves both real rows.
    await fixture.db.query("INSERT INTO crm_mail_source_contexts(workspace_id,source_id,source_revision,person_id,firm_id,context_kind,review) VALUES($1,$2,$3,$4,$5,'reviewed','current')",[workspaceId,message.id,revision,secondPersonId,firmId]);
   }
  }
  if(name==='review required recaptured native context'){
   expect((await post('/crm/business/mail/associate',command({sourceId:message.id,expectedRevision:1,personId:contactId,firmId}))).status).toBe(200);
   expect((await post('/crm/business/mail/delete',command({sourceId:message.id,expectedRevision:2}))).status).toBe(200);
   expect((await post('/crm/business/mail/restore',command({sourceId:message.id,expectedRevision:3}))).status).toBe(200);
   expect((await post('/crm/business/mail/recapture',command({sourceId:message.id,expectedRevision:4}))).status).toBe(200);
   const next=(await claimJobs(fixture.db,{owner:'required-context-recapture',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
   expect(await handler.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job:next})).toMatchObject({progress:{outcome:'captured',sourceRevision:5}});
   revision=5;
  }
  const source={workspaceId,sourceId:message.id,kind:'mail' as const,revision,contentHash:createHash('sha256').update(quote).digest('hex'),locator:null};
  if(name==='unknown native context'||name==='multiple native people'||name==='review required recaptured native context'){
   const nativeContext=await port.readContext({db:fixture.db,scope:workspaceScope(workspaceId,{kind:'user',userId:fixture.alpha.admin.userId,role:'admin'})},source);
   expect(nativeContext).toMatchObject({review:'required'});
   if(name==='review required recaptured native context')expect(nativeContext?.personId).not.toBeNull();
   else expect(nativeContext?.personId).toBeNull();
   if(name==='multiple native people')expect(new Set(nativeContext?.mailContexts?.flatMap(cx=>cx.personId===null?[]:[cx.personId])).size).toBe(2);
  }

  expect((await post('/crm/processing/purpose/save',command({expectedRevision:0,enabled:false,endpointId:'promise-evaluation',modelVersion:'fixture-promises-v1',accessGrantVersion:'fixture',dataHandlingVersion:'fixture',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
  await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
  expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
  const extractionRegistry=(modelVersion:string)=>registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmExtraction:{ allowControlledEvaluation:true,mailEvidence:port,adapter:{endpointId:'promise-evaluation',modelVersion,accessGrantVersion:'fixture',dataHandlingVersion:'fixture',providerKey:'fixture.promise_intent',fundingVerifiedUntil:'2099-01-01T00:00:00Z',run:async()=>({acceptance:'accepted',usage:{inputTokens:1,outputTokens:1},claims:[{kind:'commitment',status:'stated',interpretation:'Untrusted date/actor interpretation deliberately ignored',locator:`text:0:${quote.length}`,quote}]})}}});
  const registry=extractionRegistry('fixture-promises-v1');
  await runOnce(fixture.db,{registry,owner:'promise-extraction',limit:20});
  const processed=await post('/crm/processing/read',{source});expect(processed.body).toMatchObject({state:'complete'});
  if(name==='human review veto'||name==='dated human dismissal veto'){
   const result=crmProcessingResultSchema.parse(processed.body);if(result?.state!=='complete')throw new Error('complete processing missing');
   const claim=result.claims[0]!;
   const target={source,claimId:claim.claimId,claimRevision:1,claimHash:claim.claimHash,contextHash:result.contextHash,expectedDecisionRevision:0};
   const response=name==='human review veto'?await post('/crm/commitments/review',command({...target,expectedCommitmentRevision:0,classification:'ambiguous',actor:'unknown',actionLabel:'Human chose a suggestion',due:null})):await post('/crm/evidence/decide',command({...target,action:'dismiss'}));
   expect(response.status).toBe(200);
  }
  if(name==='lost exact intent lease'){
   const intent=(await claimJobs(fixture.db,{owner:'stolen-intent',kinds:['crm.commitments_intent'],limit:1,leaseSeconds:120}))[0]!;
   await fixture.db.query('UPDATE jobs SET fencing_token=fencing_token+1 WHERE workspace_id=$1 AND id=$2',[workspaceId,intent.id]);
   const intentHandler=registry.get('crm.commitments_intent');if(!intentHandler)throw new Error('intent registration missing');
   await intentHandler.handle({session:fixture.db,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job:intent});
  }
  await runOnce(fixture.db,{registry,owner:'promise-intent',limit:20});
  await runOnce(fixture.db,{registry,owner:'promise-projector',limit:20});
  const page=await post('/crm/commitments/read',{scope:{kind:'source',sourceId:source.sourceId,sourceKind:'mail'},limit:50});expect(page.status).toBe(200);
  if(!eligible){expect(page.body).toMatchObject({items:name==='human review veto'?[{basis:'human',state:'suggestion',task:null}]:[]});return;}
  expect(page.body).toMatchObject({items:[{basis:'verified_original',actor:'self',actionLabel:'Prepare the repair summary',due:{kind:'date',date:name==='old dated promise'?'2020-10-12':'2026-10-12',zone:'UTC'},quote,task:{status:'open'}}]});
  if(name==='same verified action after completed rerun'){
   const first=(page.body as {items:{task:{taskId:string;version:number}}[]}).items[0]!.task;
   const originalReceipt=(await fixture.db.query<{activation_receipt:unknown}>('SELECT activation_receipt FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2',[workspaceId,first.taskId])).rows[0]!.activation_receipt;
   expect((await post('/crm/commitments/complete',command({taskId:first.taskId,expectedVersion:first.version}))).status).toBe(200);
   expect((await post('/crm/processing/purpose/save',command({expectedRevision:1,enabled:false,endpointId:'promise-evaluation',modelVersion:'fixture-promises-v2',accessGrantVersion:'fixture',dataHandlingVersion:'fixture',dailyCeilingCents:100,monthlyCeilingCents:1000,inputTokenPriceMicros:1,outputTokenPriceMicros:1}))).status).toBe(200);
   await fixture.db.query('UPDATE crm_extraction_purposes SET enabled=true WHERE workspace_id=$1',[workspaceId]);
   expect((await post('/crm/processing/request',command({source}))).status).toBe(200);
   const nextRegistry=extractionRegistry('fixture-promises-v2');
   for(let pass=0;pass<3;pass++)await runOnce(fixture.db,{registry:nextRegistry,owner:'promise-rerun',limit:20});
   expect((await post('/crm/commitments/read',{scope:{kind:'firm',firmId},limit:50})).body).toMatchObject({items:[{basis:'verified_original',task:{taskId:first.taskId,status:'done',version:2}}]});
   expect((await post('/crm/commitments/read',{scope:{kind:'today'},limit:50})).body).toEqual({items:[],nextAfterId:null});
   expect((await fixture.db.query<{activation_receipt:unknown}>('SELECT activation_receipt FROM crm_internal_tasks WHERE workspace_id=$1 AND id=$2',[workspaceId,first.taskId])).rows[0]!.activation_receipt).toEqual(originalReceipt);
  }
  if(name==='old dated promise'){expect(page.body).toMatchObject({items:[{todayEligibility:'historical'}]});expect((await post('/crm/commitments/read',{scope:{kind:'today'},limit:50})).body).toMatchObject({items:[]});}
 }finally{await fixture.stop();}
});
