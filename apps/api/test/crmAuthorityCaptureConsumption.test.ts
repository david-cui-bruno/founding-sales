import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createAuthFixture} from './support/authFixture.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {enqueueJob,claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {businessAccountBinding,METADATA_REVIEW_DISCLOSURE} from '@fss/domain/business/acquisition.ts';
import {CRM_MAIL_CAPTURE_DISCLOSURE,activateCrmCapability,readCrmCapability,disableCrmCapability} from '@fss/domain/crm/capabilityAuthority.ts';
import {createCrmCapabilityVerifiers,crmBackfillScopeFingerprint,crmBackfillAllocationFingerprint} from '@fss/domain/crm/capabilityVerifiers.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {createGmailHttpClient} from '@fss/domain/mail/gmailClientHttp.ts';
import {createGmailMailCaptureProvider} from '@fss/domain/mail/crmGmailProvider.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {storeFixtureCiGateRecord,FIXTURE_CI_COMMIT,FIXTURE_WORKER_DIGEST} from '@fss/domain/test/release/support/releaseRecords.ts';
import {CRM_OWNER_SCOPE_VERSION,type CrmCapabilityConfiguration} from '@fss/contracts';
async function revokeOwnerApproval(session:SessionQueryable,input:{workspaceId:string;authorityReceiptId:string;reference:string}){
 for(const [table,capability] of [['crm_business_policies','metadata_review'],['crm_mail_capture_controls','mail_capture'],['crm_extraction_purposes','crm_extraction'],['crm_ask_purposes','ask_answer']] as const){
  const row=(await session.query<{owner:string;mailbox_id?:string;purpose?:'answer'|'embedding';revision:number}>(`SELECT *,${table==='crm_business_policies'||table==='crm_mail_capture_controls'?'owner_user_id':'approved_by'} AS owner FROM ${table} WHERE workspace_id=$1 AND owner_approval_id=$2`,[input.workspaceId,input.authorityReceiptId])).rows[0];
  if(row)return withTransaction(session,()=>disableCrmCapability(repositoryContext(workspaceScope(input.workspaceId,{kind:'user',userId:row.owner,role:'admin'}),session),{capability,expectedRevision:row.revision,...row.mailbox_id?{mailboxId:row.mailbox_id}:{},...row.purpose?{purpose:row.purpose}:{}}));
 }
 // Explicit bounded-import cancellation leaves the immutable owner decision in history.
 await session.query('UPDATE crm_mail_imports SET owner_approval_id=NULL WHERE workspace_id=$1 AND owner_approval_id=$2',[input.workspaceId,input.authorityReceiptId]);
 return {ok:true};
}
async function seedCapture(
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
    idempotencyKey: randomUUID(),
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

async function authorize(fixture:Awaited<ReturnType<typeof createAuthFixture>>,seeded:Awaited<ReturnType<typeof seedCapture>>){
 const runtime={implementationCommit:FIXTURE_CI_COMMIT,imageDigest:FIXTURE_WORKER_DIGEST,side:'worker' as const,schemaVersion:119,adapterAvailable:()=>true};
 const releaseReference=await storeFixtureCiGateRecord(fixture.db,'98811');
 const session=await fixture.database.appRuntimeSession(),verifierSession=await fixture.database.appRuntimeSession();
 const context=repositoryContext(workspaceScope(seeded.workspaceId,{kind:'user',userId:seeded.ownerUserId,role:'admin'}),session);
 const _observed=(await fixture.db.query<{id:string}>("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,'google-business',1,$4) RETURNING id",[seeded.workspaceId,seeded.mailbox.id,seeded.ownerUserId,['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.send']])).rows[0]!.id;
 const approval={consentAcknowledged:true as const,qualityTier:'acquisition' as const,limitations:[]};
 async function provision(configuration:CrmCapabilityConfiguration){
  if(configuration.capability==='mail_backfill')return (await session.query<{owner_approval_id:string}>('SELECT owner_approval_id FROM crm_mail_imports WHERE workspace_id=$1 AND mailbox_id=$2',[configuration.workspaceId,configuration.mailboxId])).rows[0]!.owner_approval_id;
  const result=await withTransaction(session,()=>activateCrmCapability(context,{capability:configuration.capability,...'mailboxId' in configuration?{mailboxId:configuration.mailboxId}:{},...configuration.capability==='ask_answer'?{purpose:configuration.purpose}:{},expectedRevision:configuration.revision-1,scopeVersion:CRM_OWNER_SCOPE_VERSION,approval:configuration.capability==='ask_answer'||configuration.capability==='crm_extraction'?{consentAcknowledged:true,qualityTier:'provisional_owner',criticalControlsPassed:true,modelIntegrationVerified:true,reviewedEvaluationReference:'reviewed-synthetic-controls',limitations:['representative_quality_unverified']}:approval},runtime));
  if(!result.ok||!result.value.ownerApprovalId)throw new Error('owner approval failed');return result.value.ownerApprovalId;
 }

 await fixture.db.query('UPDATE crm_business_policies SET disclosure_version=$3,disclosure_sha256=$4 WHERE workspace_id=$1 AND mailbox_id=$2',[seeded.workspaceId,seeded.mailbox.id,METADATA_REVIEW_DISCLOSURE.version,METADATA_REVIEW_DISCLOSURE.sha256]);
 const metadata=(await readCrmCapability(context,{capability:'metadata_review',mailboxId:seeded.mailbox.id},runtime))!.configuration!;
 const metadataAuthority=await provision({...metadata,revision:2});
 await fixture.db.query('UPDATE crm_mail_capture_controls SET enabled=false,policy_revision=2,disclosure_version=$3,disclosure_sha256=$4,release_receipt=$5 WHERE workspace_id=$1 AND mailbox_id=$2',[seeded.workspaceId,seeded.mailbox.id,CRM_MAIL_CAPTURE_DISCLOSURE.version,CRM_MAIL_CAPTURE_DISCLOSURE.sha256,releaseReference]);
 const capture=(await readCrmCapability(context,{capability:'mail_capture',mailboxId:seeded.mailbox.id},runtime))!.configuration!;
 const captureAuthority=await provision({...capture,revision:2});
 await fixture.db.query("UPDATE jobs SET payload=payload||'{\"controlsRevision\":2,\"policyRevision\":2}'::jsonb WHERE workspace_id=$1 AND id=$2",[seeded.workspaceId,seeded.job.id]);
 const job={...seeded.job,payload:{...seeded.job.payload,controlsRevision:2,policyRevision:2}};
 const verifiers=createCrmCapabilityVerifiers({runtime,openSession:async()=>({session:verifierSession,close:async()=>{}})});
 return {runtime,context,session,job,metadataAuthority,captureAuthority,verifiers,provision};
}
for(const revoked of [false,true])it(`registered actual-registry Gmail capture ${revoked?'refuses publication after revocation':'publishes current owner original'}`,async()=>{
 const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const authority=await authorize(fixture,seeded);let calls=0;
 const gmail=createGmailHttpClient({apiBaseUrl:'https://gmail.example.test',fetch:async url=>{calls++;const full=new URL(url).searchParams.get('format')==='full';if(full&&revoked){await fixture.db.query('SET ROLE migration');try{await revokeOwnerApproval(fixture.db,{workspaceId:seeded.workspaceId,authorityReceiptId:authority.captureAuthority,reference:'synthetic revoke after body read'});}finally{await fixture.db.query('RESET ROLE');}}return {status:200,headers:{},body:JSON.stringify({id:'approved-message',threadId:'approved-thread',internalDate:String(Date.now()),labelIds:['SENT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'business@example.test'},{name:'To',value:'person@example.test'}],...full?{body:{data:Buffer.from('Original business reply').toString('base64url')}}:{}}})};}});
 const handler=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{proofVerifier:authority.verifiers.captureVerifier,provider:createGmailMailCaptureProvider({gmail,resolveAccess:async()=>({mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:'synthetic-only',expiresAtEpochSeconds:Date.now()/1000+3600}})})}}).get('crm.mail_capture')!;
 await handler.handle({session:authority.session,scope:workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),job:authority.job});expect(calls).toBe(2);
 const rows=(await fixture.db.query('SELECT * FROM crm_mail_sources WHERE workspace_id=$1',[seeded.workspaceId])).rows;expect(rows).toHaveLength(revoked?0:1);if(!revoked){expect((await fixture.db.query('SELECT direction FROM mail_messages WHERE id=$1',[rows[0]!['source_id']])).rows[0]).toMatchObject({direction:'outgoing'});expect(rows[0]).toMatchObject({sent_proof:false,owner_user_id:seeded.ownerUserId});}
 }finally{await fixture.stop();}
});
it('revoked metadata authority vetoes new CRM observation while operational metadata is separate',async()=>{const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const a=await authorize(fixture,seeded);const observer=createApprovedBusinessMailObserver({revalidateAuthority:a.verifiers.revalidateMetadata});await fixture.db.query('SET ROLE migration');try{await revokeOwnerApproval(fixture.db,{workspaceId:seeded.workspaceId,authorityReceiptId:a.metadataAuthority,reference:'synthetic metadata revoke'});}finally{await fixture.db.query('RESET ROLE');}const result=await withTransaction(a.session,()=>observer.observe(repositoryContext(workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),a.session),{mailboxId:seeded.mailbox.id,ownerUserId:seeded.ownerUserId,providerAccountId:'google-business',generation:1,metadata:{id:'new-message',threadId:'new-thread',internalDateEpochMilliseconds:Date.now(),attachments:[],sizeEstimate:100,labelIds:['INBOX'],headers:{}}}));expect(result).toMatchObject({ok:false,reason:'metadata_observation_unavailable'});expect((await fixture.db.query("SELECT id FROM crm_business_conversations WHERE provider_thread_id='new-thread'")).rows).toHaveLength(0);}finally{await fixture.stop();}});

for(const revoked of [false,true])it(`bounded historical owner approval ${revoked?'revocation conserves observed quota and refuses progress':'preserves the explicitly approved frozen interval'}`,async()=>{
 const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const a=await authorize(fixture,seeded);
 const {requestCrmMailImport}=await import('@fss/domain/mail/crmBackfill.ts');const {readBackfillAuthority}=await import('@fss/domain/mail/crmBackfillAuthority.ts');const {readBackfillAllocation}=await import('@fss/domain/mail/crmBackfillBudget.ts');const {recordedGmailClient}=await import('@fss/domain/mail/gmailClientFake.ts');
 await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[seeded.workspaceId,seeded.mailbox.id,seeded.ownerUserId,seeded.binding]);
 const imported=await withTransaction(a.session,()=>requestCrmMailImport(a.context,{mailboxId:seeded.mailbox.id}));if(!imported.ok)throw new Error('synthetic import unavailable');const importId=imported.value.importId;
 const system=repositoryContext(workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),a.session);const authority=await readBackfillAuthority(system,importId),allocation=await readBackfillAllocation(system,seeded.mailbox.id);if(!authority||!allocation)throw new Error('synthetic bounded configuration absent');
 const backfillId=await a.provision({capability:'mail_backfill',workspaceId:seeded.workspaceId,ownerUserId:seeded.ownerUserId,revision:allocation.revision,mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,accountBinding:seeded.binding,scopeFingerprint:crmBackfillScopeFingerprint(authority),allocationFingerprint:crmBackfillAllocationFingerprint(allocation)});
 expect(await a.verifiers.allocationVerifier.verify(allocation,authority)).toBe(true);expect(await a.verifiers.allocationVerifier.verify({...allocation,body_units:2},authority)).toBe(false);
 let profiles=0;let lists=0;const original=recordedGmailClient({emailAddress:'business@example.test',historyId:'100',messages:[]});const gmail={...original,getProfile:async(access:Parameters<typeof original.getProfile>[0])=>{profiles++;if(revoked){await fixture.db.query('SET ROLE migration');try{await revokeOwnerApproval(fixture.db,{workspaceId:seeded.workspaceId,authorityReceiptId:backfillId,reference:'synthetic bounded revoke during provider'});}finally{await fixture.db.query('RESET ROLE');}}return original.getProfile(access);},listMessageIds:async(...args:Parameters<typeof original.listMessageIds>)=>{lists++;return original.listMessageIds(...args);}};
 const job=(await claimJobs(a.session,{owner:'synthetic-history',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
 const handler=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail,resolveAccess:async()=>({mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:'synthetic-only',expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:a.verifiers.captureVerifier,allocationVerifier:a.verifiers.allocationVerifier,observer:createApprovedBusinessMailObserver({revalidateAuthority:a.verifiers.revalidateMetadata})}}).get('crm.mail_backfill')!;
 if(revoked)await expect(handler.handle({session:a.session,scope:system.scope,job})).rejects.toThrow('quota_or_authority_unavailable');else await handler.handle({session:a.session,scope:system.scope,job});
 expect(profiles).toBe(1);expect(lists).toBe(revoked?0:1);const after=await readBackfillAuthority(system,importId);expect(after?.fromEpochMicroseconds).toBe(authority.fromEpochMicroseconds);expect(after?.toEpochMicroseconds).toBe(authority.toEpochMicroseconds);expect(after?.historyAnchor).toBe(revoked?null:'100');
 expect((await fixture.db.query("SELECT method,state FROM crm_mail_import_read_reservations WHERE workspace_id=$1 AND import_id=$2 ORDER BY reserved_at",[seeded.workspaceId,importId])).rows).toEqual(revoked?[{method:'profile',state:'observed'}]:[{method:'profile',state:'observed'},{method:'list',state:'observed'}]);
 }finally{await fixture.stop();}
});
for(const mutation of ['revoke','disable']as const)it(`holds authority/control publication locks against concurrent ${mutation}`,async()=>{const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const a=await authorize(fixture,seeded);const competing=mutation==='revoke'?fixture.db:await fixture.database.appRuntimeSession();if(mutation==='revoke')await competing.query('SET ROLE migration');await competing.query("SET statement_timeout='150ms'");let release=()=>{};const held=new Promise<void>(resolve=>{release=resolve;});let ready=()=>{};const acquired=new Promise<void>(resolve=>{ready=resolve;});const observer=createApprovedBusinessMailObserver({revalidateAuthority:async(context,input)=>{const valid=await a.verifiers.revalidateMetadata(context,input);ready();await held;return valid;}});const work=withTransaction(a.session,()=>observer.observe(repositoryContext(workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),a.session),{mailboxId:seeded.mailbox.id,ownerUserId:seeded.ownerUserId,providerAccountId:'google-business',generation:1,metadata:{id:'locked-message',threadId:'locked-thread',internalDateEpochMilliseconds:Date.now(),attachments:[],sizeEstimate:100,labelIds:['INBOX'],headers:{From:'prospect@example.test',To:'business@example.test'}}}));await acquired;
 try{const action=mutation==='revoke'?revokeOwnerApproval(competing,{workspaceId:seeded.workspaceId,authorityReceiptId:a.metadataAuthority,reference:'concurrent synthetic revoke'}):competing.query('UPDATE crm_business_policies SET enabled=false,revision=revision+1 WHERE workspace_id=$1 AND mailbox_id=$2',[seeded.workspaceId,seeded.mailbox.id]);await expect(action).rejects.toMatchObject({code:'57014'});}finally{release();}await work;expect((await fixture.db.query("SELECT id FROM crm_business_conversations WHERE provider_thread_id='locked-thread'")).rows).toHaveLength(1);
 }finally{await fixture.stop();}});
it('normal Gmail capture revocation during metadata prevents the next body request',async()=>{const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const a=await authorize(fixture,seeded);let metadataReads=0,bodyReads=0;const gmail=createGmailHttpClient({apiBaseUrl:'https://gmail.example.test',fetch:async url=>{const full=new URL(url).searchParams.get('format')==='full';if(full)bodyReads++;else{metadataReads++;await fixture.db.query('SET ROLE migration');try{await revokeOwnerApproval(fixture.db,{workspaceId:seeded.workspaceId,authorityReceiptId:a.captureAuthority,reference:'synthetic revoke during metadata read'});}finally{await fixture.db.query('RESET ROLE');}}return {status:200,headers:{},body:JSON.stringify({id:'approved-message',threadId:'approved-thread',internalDate:String(Date.now()),labelIds:['INBOX'],payload:{headers:[{name:'From',value:'prospect@example.test'},{name:'To',value:'business@example.test'}]}})};}});const {composeCrmGmail}=await import('../../worker/src/bootstrap/crmGmail.ts');const composition=composeCrmGmail({gmail,resolveAccess:async()=>({mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:'synthetic-only',expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:a.verifiers.captureVerifier,allocationVerifier:a.verifiers.allocationVerifier,observer:createApprovedBusinessMailObserver({revalidateAuthority:a.verifiers.revalidateMetadata})});const handler=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composition}).get('crm.mail_capture')!;await expect(handler.handle({session:a.session,scope:workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),job:a.job})).rejects.toThrow('CRM mail capture authority unavailable');expect(metadataReads).toBe(1);expect(bodyReads).toBe(0);expect((await fixture.db.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1',[seeded.workspaceId])).rows).toHaveLength(0);}finally{await fixture.stop();}});

for(const revoked of [false,true])it(`historical original body ${revoked?'revocation blocks publication with both reads observed':'uses independently scoped allocation'}`,async()=>{const fixture=await createAuthFixture();try{const seeded=await seedCapture(fixture);const a=await authorize(fixture,seeded);const {requestCrmMailImport}=await import('@fss/domain/mail/crmBackfill.ts');const {readBackfillAuthority}=await import('@fss/domain/mail/crmBackfillAuthority.ts');const {readBackfillAllocation}=await import('@fss/domain/mail/crmBackfillBudget.ts');const {createHistoricalGmailMailCaptureProvider}=await import('@fss/domain/mail/crmBackfillCapture.ts');
 await fixture.db.query("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[seeded.workspaceId,seeded.mailbox.id,seeded.ownerUserId,seeded.binding]);
 const imported=await withTransaction(a.session,()=>requestCrmMailImport(a.context,{mailboxId:seeded.mailbox.id}));if(!imported.ok)throw new Error('synthetic import missing');const importId=imported.value.importId;
 const system=repositoryContext(workspaceScope(seeded.workspaceId,{kind:'system',component:'worker'}),a.session),scope=await readBackfillAuthority(system,importId),allocation=await readBackfillAllocation(system,seeded.mailbox.id);if(!scope||!allocation)throw new Error('synthetic scope missing');const receiptId=await a.provision({capability:'mail_backfill',workspaceId:seeded.workspaceId,ownerUserId:seeded.ownerUserId,revision:allocation.revision,mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,accountBinding:seeded.binding,scopeFingerprint:crmBackfillScopeFingerprint(scope),allocationFingerprint:crmBackfillAllocationFingerprint(allocation)});
 const internalDate=Date.now()-1000;const {createHash}=await import('node:crypto');const messageHash=createHash('sha256').update(JSON.stringify({accountBinding:seeded.binding,providerMessageId:'approved-message'})).digest('hex');await fixture.db.query("INSERT INTO crm_mail_import_messages(workspace_id,import_id,message_hash,provider_message_id,provider_thread_id,provider_at,scope,state) VALUES($1,$2,$3,'approved-message','approved-thread',to_timestamp($4::double precision/1000),'historical','available')",[seeded.workspaceId,importId,messageHash,internalDate]);const job={...a.job,payload:{...a.job.payload,acquisitionOrigin:{importId}}};await fixture.db.query('UPDATE jobs SET payload=$3::jsonb WHERE workspace_id=$1 AND id=$2',[seeded.workspaceId,job.id,JSON.stringify(job.payload)]);
 const gmail=createGmailHttpClient({apiBaseUrl:'https://gmail.example.test',fetch:async url=>{const full=new URL(url).searchParams.get('format')==='full';if(full&&revoked){await fixture.db.query('SET ROLE migration');try{await revokeOwnerApproval(fixture.db,{workspaceId:seeded.workspaceId,authorityReceiptId:receiptId,reference:'synthetic bounded body revoke'});}finally{await fixture.db.query('RESET ROLE');}}return {status:200,headers:{},body:JSON.stringify({id:'approved-message',threadId:'approved-thread',internalDate:String(internalDate),labelIds:['SENT'],payload:{mimeType:'text/plain',headers:[{name:'From',value:'business@example.test'},{name:'To',value:'person@example.test'}],...full?{body:{data:Buffer.from('Historical business reply').toString('base64url')}}:{}}})};}});const deps={gmail,resolveAccess:async()=>({mailboxId:seeded.mailbox.id,providerAccountId:'google-business',generation:1,access:{accessToken:'synthetic-only',expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:a.verifiers.captureVerifier,allocationVerifier:a.verifiers.allocationVerifier};const handler=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailCapture:{provider:createGmailMailCaptureProvider(deps),proofVerifier:deps.proofVerifier,historicalProvider:createHistoricalGmailMailCaptureProvider(deps)}}).get('crm.mail_capture')!;const run=()=>handler.handle({session:a.session,scope:system.scope,job});if(revoked)await expect(run()).rejects.toThrow('historical_capture_authority_changed');else await run();expect((await fixture.db.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1',[seeded.workspaceId])).rows).toHaveLength(revoked?0:1);expect((await fixture.db.query('SELECT method,state FROM crm_mail_import_read_reservations WHERE import_id=$1 ORDER BY reserved_at',[importId])).rows).toEqual([{method:'metadata',state:'observed'},{method:'body',state:'observed'}]);
 }finally{await fixture.stop();}});
