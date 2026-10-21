import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { captureRecoveryFixture } from './support/captureReadRecoveryFixture.ts';
import { recordedGmailClient } from '@fss/domain/mail/gmailClientFake.ts';
import { createApprovedBusinessMailObserver, changeMailSource } from '@fss/domain/mail/crmSources.ts';
import { createCaptureReadForwardProvider } from '../../worker/src/bootstrap/crmCaptureReadRecovery.ts';
import { createServerCrmGmailAccessResolver, composeCrmGmail } from '../../worker/src/bootstrap/crmGmail.ts';
import { HandlerRegistry } from '@fss/domain/jobs/handlerRegistry.ts';
import { registerHandlers } from '../../worker/src/bootstrap/main.ts';
import { claimJobs, completeJob } from '@fss/domain/jobs/jobStore.ts';
import { withTransaction } from '@fss/domain/db/queryable.ts';
import { repositoryContext } from '@fss/domain/db/workspaceScope.ts';
import { crmCaptureReadForwardSource } from '../../worker/src/scheduler/crmCaptureReadForwardSource.ts';
import { storeRefreshToken } from '@fss/domain/mail/tokens.ts';

type Fixture = Awaited<ReturnType<typeof captureRecoveryFixture>>;
it('a real 51-original listing consumes at most 50 metadata reads per turn and resumes the frozen page',async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f),p=await progress(f),cutoff=p.forward_cutoff_at.getTime();
  await f.db.query('UPDATE crm_capture_read_progress SET window_to_at=$1 WHERE recovery_id=$2',[new Date(cutoff+5),id]);
  const gmail=recordedGmailClient({emailAddress:f.m.email_address,historyId:'100',messages:Array.from({length:51},(_,n)=>message(`bounded_${n}`,cutoff))});
  await runPage(f,gmail);expect(gmail.metadataReads).toHaveLength(50);expect((await progress(f)).state).toBe('pending');
  await f.nextForward(id);await runPage(f,gmail);expect(gmail.metadataReads).toHaveLength(51);expect((await progress(f)).state).toBe('current');
  expect((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='crm.mail_capture'")).rows[0]).toEqual({n:51});
 }finally{await f.stop();}
});
it('abandoned scanning is durable uncertainty rather than a replay, even with a new job ID',async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f),p=await progress(f);
  await f.db.query("UPDATE crm_capture_read_progress SET state='scanning',window_to_at=clock_timestamp() WHERE recovery_id=$1",[id]);
  await f.run('crm.capture_read_forward');expect(f.fake.calls.map(c=>c.method)).toEqual(['refreshAccessToken','getProfile']);
  expect((await progress(f)).state).toBe('uncertain');expect((await progress(f)).window_from_at).toEqual(p.window_from_at);
  await f.nextForward(id);await f.run('crm.capture_read_forward');expect(f.fake.calls).toHaveLength(2);
 }finally{await f.stop();}
});
for(const mutation of ['incident-before-body','rotation-before-body','consent-before-body','body-unknown'] as const)it(`normal capture consumer fences ${mutation} and leaves original incident untouched`,async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f),p=await progress(f),cutoff=p.forward_cutoff_at.getTime();
  const before=(await f.db.query('SELECT to_jsonb(i) AS value FROM mailbox_provider_incidents i WHERE id=$1',[f.incident])).rows;
  await f.db.query('UPDATE crm_capture_read_progress SET window_to_at=$1 WHERE recovery_id=$2',[new Date(cutoff+5),id]);
  const base=recordedGmailClient({emailAddress:f.m.email_address,historyId:'100',messages:[message('current_original',cutoff)]});
  await runPage(f,base);
  const gmail={...base,getMetadata:async(...args:Parameters<typeof base.getMetadata>)=>{
   const result=await base.getMetadata(...args);
   if(mutation==='incident-before-body')await f.db.query("INSERT INTO mailbox_provider_incidents(workspace_id,mailbox_id,source_kind,source_id,classification,reason,observed_at) VALUES($1,$2,'mail_read','consumer-stop','transient','rate_limited',clock_timestamp())",[f.w,f.m.id]);
   if(mutation==='rotation-before-body')await storeRefreshToken(repositoryContext(f.context.scope,f.db),{mailboxId:f.m.id,cipher:f.cipher,plaintext:randomUUID()});
   if(mutation==='consent-before-body')await f.db.query('UPDATE crm_mail_capture_controls SET enabled=false WHERE mailbox_id=$1',[f.m.id]);
   return result;
  },getBody:async(...args:Parameters<typeof base.getBody>)=>{if(mutation==='body-unknown')throw new Error('private provider outcome');return base.getBody(...args);}};
  const openSession=async()=>({session:await f.fixture.database.appRuntimeSession(),close:async()=>{}}),deps={gmail,oauth:f.oauth,cipher:f.cipher,runtime:f.runtime,openSession};
  const resolveAccess=createServerCrmGmailAccessResolver(deps);
  const provider=createCaptureReadForwardProvider({...deps,ordinaryResolveAccess:resolveAccess,proofVerifier:f.verifiers.captureVerifier});
  const composition=composeCrmGmail({gmail,observer:observer(f),resolveAccess,proofVerifier:f.verifiers.captureVerifier,allocationVerifier:f.verifiers.allocationVerifier},provider);
  const handler=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composition}).get('crm.mail_capture')!;
  const job=(await claimJobs(f.session,{owner:'consumer-authority-test',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
  await expect(handler.handle({scope:f.system.scope,session:f.session,job})).rejects.toThrow('capture_read_consumer_unavailable');
  expect(base.bodyReads).toHaveLength(0);expect((await f.db.query('SELECT source_id FROM crm_mail_sources')).rows).toHaveLength(0);
  expect((await progress(f)).state).toBe('uncertain');
  expect((await f.db.query('SELECT to_jsonb(i) AS value FROM mailbox_provider_incidents i WHERE id=$1',[f.incident])).rows).toEqual(before);
 }finally{await f.stop();}
});
async function recovered(f: Fixture) {
 const result = await f.request(); if (!result.ok) throw new Error('request');
 await f.run('crm.capture_read_recovery');
 return result.value.attemptId;
}
async function progress(f: Fixture) {
 return (await f.db.query<{window_from_at:Date;window_to_at:Date|null;next_page_token:string|null;state:string;visited_messages:string;observed_metadata:string;forward_cutoff_at:Date}>('SELECT * FROM crm_capture_read_progress')).rows[0]!;
}
function message(id: string, at: number, labels = ['INBOX']) {
 return { id, threadId:`thread_${id}`, internalDateEpochMilliseconds:at, labelIds:labels, headers:{From:'Person <person@example.test>',To:'business@example.test',Subject:'Business conversation'}, body:'A fictional business conversation.', historyId:'101' };
}
function observer(f: Fixture) {
 return createApprovedBusinessMailObserver({revalidateAuthority:f.verifiers.revalidateMetadata,categorizeMetadata:()=>({category:'business',reason:'business_metadata',classifierVersion:'fixture'})});
}
async function runPage(f: Fixture, gmail: ReturnType<typeof recordedGmailClient>) {
 const job=(await claimJobs(f.session,{owner:'bounded-forward-test',kinds:['crm.capture_read_forward'],limit:1,leaseSeconds:120}))[0]!;
 const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmCaptureRead:{gmail,oauth:f.oauth,cipher:f.cipher,runtime:f.runtime,observer:observer(f)}});
 await registry.get('crm.capture_read_forward')!.handle({scope:f.system.scope,session:f.session,job});
 await completeJob(f.session,job);
}

it('freezes exact paginated windows, observes incoming and Sent originals only after original consent, and retains idempotence',async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f), initial=await progress(f),cutoff=initial.forward_cutoff_at.getTime();
  // Force a deterministic frozen upper bound, independently of subsequent wall time.
  const upper=new Date(cutoff+3);
  await f.db.query('UPDATE crm_capture_read_progress SET window_to_at=$1 WHERE recovery_id=$2',[upper,id]);
  const gmail=recordedGmailClient({emailAddress:f.m.email_address,historyId:'999',listPageSize:2,listBounds:'strict',messages:[message('old',cutoff-1),message('incoming',cutoff),message('sent',cutoff+1,['SENT']),message('draft',cutoff+2,['DRAFT']),message('later',cutoff+3)]});
  await runPage(f,gmail);
  const first=await progress(f);expect(first.window_from_at).toEqual(initial.window_from_at);expect(first.window_to_at).toEqual(upper);expect(first.next_page_token).not.toBeNull();
  await f.nextForward(id);await runPage(f,gmail);
  const second=await progress(f);expect(second.window_from_at).toEqual(upper);expect(second.window_to_at).toBeNull();expect(second.next_page_token).toBeNull();
  const lists=gmail.calls.filter(c=>c.method==='listMessageIds');expect(lists).toHaveLength(2);
  expect(lists[0]!.detail).toMatchObject({maxResults:50,afterEpochSeconds:Math.floor(cutoff/1000)-1,beforeEpochSeconds:Math.ceil(upper.getTime()/1000)+1});
  expect(lists[1]!.detail).toMatchObject({...lists[0]!.detail,pageToken:first.next_page_token});
  expect((await f.db.query('SELECT provider_thread_id FROM crm_business_conversations ORDER BY provider_thread_id')).rows).toEqual([{provider_thread_id:'thread_incoming'},{provider_thread_id:'thread_sent'}]);
  expect(gmail.calls.some(c=>['getBody','listHistory','sendMessage','searchSent'].includes(c.method))).toBe(false);
  expect((await f.db.query("SELECT kind FROM jobs WHERE kind NOT IN ('crm.capture_read_recovery','crm.capture_read_forward','crm.mail_capture')")).rows).toHaveLength(0);
  // The next interval includes the exact previous upper boundary, never skips it.
  await f.db.query('UPDATE crm_capture_read_progress SET window_to_at=$1 WHERE recovery_id=$2',[new Date(cutoff+6),id]);
  await f.nextForward(id);await runPage(f,gmail);
  await f.nextForward(id);await runPage(f,gmail);
  expect((await f.db.query('SELECT provider_thread_id FROM crm_business_conversations ORDER BY provider_thread_id')).rows).toEqual([{provider_thread_id:'thread_incoming'},{provider_thread_id:'thread_later'},{provider_thread_id:'thread_sent'}]);
  expect((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='crm.mail_capture'")).rows[0]).toEqual({n:3});
  expect((await f.db.query('SELECT history_id FROM mailboxes WHERE id=$1',[f.m.id])).rows[0]).toEqual({history_id:null});
 }finally{await f.stop();}
});

for(const mutation of ['new-incident','rotation','consent','unknown','oversized','repeat-page'] as const)it(`bounded scanner stops ${mutation} without advancing cutoff or generic work`,async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f),before=await progress(f),base=f.fake;
  const gmail={...base,listMessageIds:vi.fn(async()=>{
   if(mutation==='new-incident')await f.db.query("INSERT INTO mailbox_provider_incidents(workspace_id,mailbox_id,source_kind,source_id,classification,reason,observed_at) VALUES($1,$2,'mail_read','new-incident','transient','rate_limited',clock_timestamp())",[f.w,f.m.id]);
   if(mutation==='rotation')await storeRefreshToken(repositoryContext(f.context.scope,f.db),{mailboxId:f.m.id,cipher:f.cipher,plaintext:randomUUID()});
   if(mutation==='consent')await f.db.query('UPDATE crm_mail_capture_controls SET enabled=false WHERE mailbox_id=$1',[f.m.id]);
   if(mutation==='unknown')throw new Error('private exception');
   return {ok:true as const,messageIds:mutation==='oversized'?Array.from({length:51},(_,i)=>`id_${i}`):[],nextPageToken:mutation==='repeat-page'?'same':null};
  })};
  if(mutation==='repeat-page')await f.db.query("UPDATE crm_capture_read_progress SET next_page_token='same',window_to_at=clock_timestamp() WHERE recovery_id=$1",[id]);
  await f.run('crm.capture_read_forward',gmail);
  const after=await progress(f);expect(after.window_from_at).toEqual(before.window_from_at);expect(after.forward_cutoff_at).toEqual(before.forward_cutoff_at);
  expect(after.state).toBe(mutation==='unknown'?'uncertain':'blocked');
  expect(gmail.calls.filter(c=>c.method==='getMetadata')).toHaveLength(0);
  expect(await crmCaptureReadForwardSource(true).find(f.db,new Date().toISOString())).toEqual([]);
  await f.nextForward(id);await f.run('crm.capture_read_forward',gmail);expect(gmail.listMessageIds).toHaveBeenCalledTimes(1);
 }finally{await f.stop();}
});

it('normal registered CRM body capture uses recovered read only and deletion barriers prevent replay',async()=>{
 const f=await captureRecoveryFixture();try{
  const id=await recovered(f),p=await progress(f),cutoff=p.forward_cutoff_at.getTime();
  await f.db.query('UPDATE crm_capture_read_progress SET window_to_at=$1 WHERE recovery_id=$2',[new Date(cutoff+1000),id]);
  const gmail=recordedGmailClient({emailAddress:f.m.email_address,historyId:'100',messages:[message('copy_original',cutoff)]});
  await runPage(f,gmail);
  const openSession=async()=>({session:await f.fixture.database.appRuntimeSession(),close:async()=>{}});
  const deps={gmail,oauth:f.oauth,cipher:f.cipher,runtime:f.runtime,openSession};
  const resolveAccess=createServerCrmGmailAccessResolver(deps);
  const provider=createCaptureReadForwardProvider({...deps,ordinaryResolveAccess:resolveAccess,proofVerifier:f.verifiers.captureVerifier});
  const composition=composeCrmGmail({gmail,observer:observer(f),resolveAccess,proofVerifier:f.verifiers.captureVerifier,allocationVerifier:f.verifiers.allocationVerifier},provider);
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,...composition});
  const job=(await claimJobs(f.session,{owner:'normal-capture-test',kinds:['crm.mail_capture'],limit:1,leaseSeconds:120}))[0]!;
  expect(job).toBeDefined();await registry.get('crm.mail_capture')!.handle({scope:f.system.scope,session:f.session,job});await completeJob(f.session,job);
  const source=(await f.db.query<{source_id:string;source_revision:number}>('SELECT source_id,source_revision FROM crm_mail_sources')).rows[0]!;
  expect(source).toBeDefined();expect(gmail.calls.filter(c=>c.method==='getBody')).toHaveLength(1);
  expect(await withTransaction(f.session,()=>changeMailSource(f.context,{sourceId:source.source_id,expectedRevision:source.source_revision},'delete'))).toMatchObject({ok:true});
  expect((await f.db.query('SELECT availability FROM crm_mail_sources')).rows[0]).toEqual({availability:'deleted'});
  // Existing canonical deletion identity prevents re-enumeration from resurrecting content.
  await f.db.query('UPDATE crm_capture_read_progress SET window_from_at=forward_cutoff_at,window_to_at=$1 WHERE recovery_id=$2',[new Date(cutoff+1000),id]);
  await f.nextForward(id);await runPage(f,gmail);
  expect((await f.db.query('SELECT availability FROM crm_mail_sources')).rows[0]).toEqual({availability:'deleted'});
  expect((await f.db.query("SELECT count(*)::int AS n FROM jobs WHERE kind='crm.mail_capture'")).rows[0]).toEqual({n:1});
 }finally{await f.stop();}
});
