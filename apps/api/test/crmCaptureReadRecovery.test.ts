import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { captureRecoveryFixture } from './support/captureReadRecoveryFixture.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext, workspaceScope } from '@fss/domain/db/workspaceScope.ts';
import { captureReadAuthority } from '@fss/domain/mail/crmCaptureReadAuthority.ts';
import { readCaptureReadRecovery, requestCaptureReadRecovery } from '@fss/domain/mail/crmCaptureReadRecovery.ts';
import { accessForMailbox } from '@fss/domain/mail/sync.ts';
import { openHold } from '@fss/domain/policy/holds.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';
import { enqueueJob } from '@fss/domain/jobs/jobStore.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { apiRouteModules } from '../src/routes/modules.ts';
import { crmCaptureReadRecoveryStatusSchema, clientVersionPolicySchema } from '@fss/contracts';
import { localNoopSuppressionJournal } from '../src/journal/index.ts';

it('registered capture probe is once-only, body-free, independently authorized while owner OFF and every incident/hold stays unchanged',async()=>{
 const f=await captureRecoveryFixture();try{
  await f.db.query("INSERT INTO sending_domains(workspace_id,domain,automated_sending_enabled) VALUES($1,'example.test',false)",[f.w]);
  const hold=await openHold(f.context,{scopeKind:'mailbox',scopeKey:f.m.id,reasonCode:'provider_refusal',blockedActionKinds:['email_send'],sourceEventKind:'provider_incident',sourceEventId:f.incident,recoveryAction:'resume_after_review'});
  await f.db.query('UPDATE mailbox_provider_incidents SET hold_id=$2 WHERE id=$1',[f.incident,hold]);
  const before=await f.db.query('SELECT to_jsonb(i) AS snapshot FROM mailbox_provider_incidents i WHERE workspace_id=$1',[f.w]);
  const holds=await f.db.query('SELECT to_jsonb(h) AS snapshot FROM active_holds h WHERE workspace_id=$1 ORDER BY id',[f.w]);
  expect(await accessForMailbox(f.system,{gmail:f.fake,oauth:f.oauth,cipher:f.cipher},f.m.id)).toEqual({ok:false,reason:'provider_incident'});
  expect(f.fake.calls).toHaveLength(0);
  const requested=await f.request();expect(requested.ok).toBe(true);if(!requested.ok)throw new Error('request');
  expect(await f.request()).toEqual(requested);
  await f.run('crm.capture_read_recovery');
  expect(f.fake.calls.map(c=>c.method)).toEqual(['refreshAccessToken','getProfile']);
  const status=await withTransaction(f.session,()=>readCaptureReadRecovery(f.context,{mailboxId:f.m.id},f.runtime));
  expect(status).toMatchObject({eligible:false,attempt:{state:'verified'},sendingUnchanged:true,holdsUnchanged:true,providerCoverage:'unproven'});
  await enqueueJob(f.db,{workspaceId:f.w,kind:'crm.capture_read_recovery',idempotencyKey:randomUUID(),payload:{recoveryId:requested.value.attemptId}});
  await f.run('crm.capture_read_recovery');expect(f.fake.calls).toHaveLength(2);
  expect(await accessForMailbox(f.system,{gmail:f.fake,oauth:f.oauth,cipher:f.cipher},f.m.id)).toEqual({ok:false,reason:'provider_incident'});
  expect((await f.db.query('SELECT to_jsonb(i) AS snapshot FROM mailbox_provider_incidents i WHERE workspace_id=$1',[f.w])).rows).toEqual(before.rows);
  expect((await f.db.query('SELECT to_jsonb(h) AS snapshot FROM active_holds h WHERE workspace_id=$1 ORDER BY id',[f.w])).rows).toEqual(holds.rows);
  expect((await f.db.query('SELECT automated_sending_enabled FROM sending_domains WHERE workspace_id=$1',[f.w])).rows[0]).toEqual({automated_sending_enabled:false});
  expect((await f.db.query('SELECT history_id FROM mailboxes WHERE id=$1',[f.m.id])).rows[0]).toEqual({history_id:null});
 }finally{await f.stop();}
});

for(const mutation of ['generation','account','owner','rotation','consent','policy','new-incident','changed-incident','requester-departed'] as const)it(`probe completion fences ${mutation} without publishing clearance`,async()=>{
 const f=await captureRecoveryFixture();try{
  await f.request();
  const gmail={...f.fake,getProfile:async()=>{
   if(mutation==='generation')await f.db.query('UPDATE mailboxes SET generation=generation+1 WHERE id=$1',[f.m.id]);
   if(mutation==='account')await f.db.query("UPDATE mailboxes SET provider_account_id='changed-provider' WHERE id=$1",[f.m.id]);
   if(mutation==='owner')await f.db.query('UPDATE mailboxes SET owner_user_id=$2 WHERE id=$1',[f.m.id,f.fixture.alpha.salesperson.userId]);
   if(mutation==='rotation')await storeRefreshToken(repositoryContext(f.context.scope,f.db),{mailboxId:f.m.id,cipher:f.cipher,plaintext:randomUUID()});
   if(mutation==='consent')await f.db.query('UPDATE crm_mail_capture_controls SET enabled=false,owner_approval_id=NULL WHERE mailbox_id=$1',[f.m.id]);
   if(mutation==='policy')await f.db.query('UPDATE crm_business_policies SET enabled=false WHERE mailbox_id=$1',[f.m.id]);
   if(mutation==='new-incident')await f.db.query("INSERT INTO mailbox_provider_incidents(workspace_id,mailbox_id,source_kind,source_id,classification,reason,observed_at) VALUES($1,$2,'mail_read','new-stop','unknown','unknown_provider_failure',clock_timestamp())",[f.w,f.m.id]);
   if(mutation==='changed-incident')await f.db.query("UPDATE mailbox_provider_incidents SET reason='service_unavailable' WHERE id=$1",[f.incident]);
   if(mutation==='requester-departed'){
    await f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[f.w,f.fixture.alpha.salesperson.userId]);
    await f.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[f.w,f.owner]);
   }
   return {emailAddress:f.m.email_address,historyId:'100'};
  }};
  await f.run('crm.capture_read_recovery',gmail);
  expect((await f.db.query('SELECT state,coded_outcome FROM crm_capture_read_recoveries')).rows).toEqual([{state:'stale',coded_outcome:'recovery_binding_changed'}]);
  expect((await f.db.query('SELECT * FROM crm_capture_read_progress')).rows).toHaveLength(0);
 }finally{await f.stop();}
});

for(const outcome of ['refused','unknown','identity'] as const)it(`probe records coded ${outcome} and never retries under a new command ID`,async()=>{
 const f=await captureRecoveryFixture();try{
  await f.request();
  const refresh=vi.fn(f.fake.refreshAccessToken);
  const gmail={...f.fake,refreshAccessToken:outcome==='refused'?vi.fn(async()=>({ok:false as const,reason:'rate_limited' as const})):refresh,getProfile:async()=>{if(outcome==='unknown')throw new Error('private provider detail must not be retained');return {emailAddress:outcome==='identity'?'different@example.test':f.m.email_address,historyId:'100'};}};
  await f.run('crm.capture_read_recovery',gmail);
  const rows=(await f.db.query('SELECT state,coded_outcome FROM crm_capture_read_recoveries')).rows;
  expect(rows).toEqual([{state:outcome==='unknown'?'uncertain':'refused',coded_outcome:outcome==='unknown'?'provider_uncertain':outcome==='identity'?'profile_identity_mismatch':'provider_refused'}]);
  const before=gmail.refreshAccessToken.mock.calls.length;expect((await f.request()).ok).toBe(true);
  expect(gmail.refreshAccessToken.mock.calls.length).toBe(before);
  expect((await f.db.query("SELECT resolved_at,retry_at FROM mailbox_provider_incidents WHERE id=$1",[f.incident])).rows[0]).toEqual({resolved_at:null,retry_at:null});
 }finally{await f.stop();}
});

it('durable probing survives a crash and a reclaimed/new job never calls the provider',async()=>{
 const f=await captureRecoveryFixture();try{
  const requested=await f.request();if(!requested.ok)throw new Error('request');
  await f.db.query("UPDATE crm_capture_read_recoveries SET state='probing',probe_started_at=clock_timestamp() WHERE id=$1",[requested.value.attemptId]);
  await f.run('crm.capture_read_recovery');
  expect(f.fake.calls).toHaveLength(0);
  expect((await f.db.query('SELECT state,coded_outcome FROM crm_capture_read_recoveries')).rows).toEqual([{state:'uncertain',coded_outcome:'provider_uncertain'}]);
  await enqueueJob(f.db,{workspaceId:f.w,kind:'crm.capture_read_recovery',idempotencyKey:randomUUID(),payload:{recoveryId:requested.value.attemptId}});
  await f.run('crm.capture_read_recovery');expect(f.fake.calls).toHaveLength(0);
 }finally{await f.stop();}
});

it('lost lease after external call cannot publish success or repeat the probing dispatch',async()=>{
 const f=await captureRecoveryFixture();try{
  await f.request();
  await f.run('crm.capture_read_recovery',{...f.fake,getProfile:async()=>{await f.db.query("UPDATE jobs SET fencing_token=fencing_token+1 WHERE kind='crm.capture_read_recovery'");return {emailAddress:f.m.email_address,historyId:'100'};}});
  expect((await f.db.query('SELECT state FROM crm_capture_read_recoveries')).rows[0]).toEqual({state:'probing'});
  const recovery=(await f.db.query<{id:string}>('SELECT id FROM crm_capture_read_recoveries')).rows[0]!;
  await enqueueJob(f.db,{workspaceId:f.w,kind:'crm.capture_read_recovery',idempotencyKey:randomUUID(),payload:{recoveryId:recovery.id}});
  await f.run('crm.capture_read_recovery');
  expect(f.fake.calls.map(c=>c.method)).toEqual(['refreshAccessToken']);
  expect((await f.db.query('SELECT state FROM crm_capture_read_recoveries')).rows[0]).toEqual({state:'uncertain'});
 }finally{await f.stop();}
});

it('foreign actor, changed binding, missing scopes and absent runtime cannot request recovery',async()=>{
 const f=await captureRecoveryFixture();try{
  const a=await withTransaction(f.session,()=>captureReadAuthority(f.context,f.m.id,f.runtime));if(!a.ok)throw new Error('authority');
  const input={mailboxId:f.m.id,expectedGeneration:1,incidentId:f.incident,expectedRecoveryBinding:a.authority.binding};
  const foreign=repositoryContext(workspaceScope(f.w,{kind:'user',userId:f.fixture.alpha.salesperson.userId,role:'salesperson'}),f.session);
  expect(await withTransaction(f.session,()=>requestCaptureReadRecovery(foreign,input,f.runtime))).toEqual({ok:false,reason:'capture_authority_unavailable'});
  expect(await withTransaction(f.session,()=>requestCaptureReadRecovery(f.context,{...input,expectedRecoveryBinding:'b'.repeat(64)},f.runtime))).toEqual({ok:false,reason:'recovery_binding_changed'});
  expect(await withTransaction(f.session,()=>requestCaptureReadRecovery(f.context,input))).toEqual({ok:false,reason:'capture_authority_unavailable'});
  await f.db.query("INSERT INTO mailbox_oauth_grant_observations(workspace_id,mailbox_id,owner_user_id,provider_account_id,generation,granted_scopes) VALUES($1,$2,$3,$4,1,ARRAY['https://www.googleapis.com/auth/gmail.send'])",[f.w,f.m.id,f.owner,f.m.provider_account_id]);
  expect(await withTransaction(f.session,()=>requestCaptureReadRecovery(f.context,input,f.runtime))).toEqual({ok:false,reason:'capture_authority_unavailable'});
 }finally{await f.stop();}
});

it('actual mounted API read and receipt-backed command reject invented fields and replay without another attempt',async()=>{
 const f=await captureRecoveryFixture();try{
  const grant=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin);
  const module=apiRouteModules({session:f.session,supportedClientVersions:clientVersionPolicySchema.parse({minimum:'1.0.0',ceiling:'1.x',incompatible:[]}),sendingEnabled:false,upgradeUrl:'https://example.test/upgrade',suppressionJournal:localNoopSuppressionJournal(),auth:{...f.fixture.deps,db:f.session},crmCapabilityRuntime:f.runtime}).find(m=>m.name==='crm-capture-read-recovery')!;
  const base={method:'POST',query:new URLSearchParams(),headers:{authorization:`Bearer ${grant.accessToken}`},principal:null,db:f.session,readiness:{session:f.session}};
  const read=await module.handle({...base,path:'/crm/business/capture-read-recovery/read',body:{mailboxId:f.m.id}});
  expect(read?.status).toBe(200);const status=crmCaptureReadRecoveryStatusSchema.parse(read?.body);
  const body={commandId:randomUUID(),clientVersion:'1.4.0',mailboxId:f.m.id,expectedGeneration:status.generation!,incidentId:status.incidentId!,expectedRecoveryBinding:status.recoveryBinding!};
  expect((await module.handle({...base,path:'/crm/business/capture-read-recovery/request',body:{...body,clearIncident:true}}))?.status).toBe(400);
  const first=await module.handle({...base,path:'/crm/business/capture-read-recovery/request',body});
  expect(first).toMatchObject({status:200,body:{status:'accepted',replayed:false,result:{state:'queued'}}});
  expect(await module.handle({...base,path:'/crm/business/capture-read-recovery/request',body})).toMatchObject({status:200,body:{status:'accepted',replayed:true}});
  expect((await f.db.query('SELECT id FROM crm_capture_read_recoveries')).rows).toHaveLength(1);
  expect(f.fake.calls).toHaveLength(0);
 }finally{await f.stop();}
});
