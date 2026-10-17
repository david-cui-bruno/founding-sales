import {expect,it} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {recordedGmailClient} from '@fss/domain/mail/gmailClientFake.ts';
import {createApprovedBusinessMailObserver} from '@fss/domain/mail/crmSources.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

it('orders the registered standing sender before its fence against registered retained-original backfill publication',async()=>{
 const f=await bookingStopsFixture(),backfill=await f.fixture.database.appRuntimeSession(),observer=await f.fixture.database.appRuntimeSession();
 const oauth=deferred(),resumeOauth=deferred(),sourceLocked=deferred(),resumeSource=deferred();
 const errors:string[]=[],senderQuery=f.fixture.db.query.bind(f.fixture.db),backfillQuery=backfill.query.bind(backfill);
 let sending:Promise<void>|undefined,publishing:Promise<unknown>|undefined,paused=false,cycle=false;
 try{
  const workspaceId=f.fixture.alpha.workspaceId;
  // Infrastructure only. The source and standing fence are created by normal public/registered paths.
  await senderQuery('UPDATE crm_business_policies SET enabled=true WHERE workspace_id=$1 AND mailbox_id=$2',[workspaceId,f.mailbox.id]);
  await senderQuery("INSERT INTO crm_mail_import_allocations(workspace_id,mailbox_id,revision,owner_user_id,account_binding,generation,project_hash,user_hash,user_limit_units,project_limit_units,user_headroom_units,project_headroom_units,profile_units,list_units,history_units,metadata_units,body_units,verification_sha256,verified_until) VALUES($1,$2,1,$3,$4,1,repeat('c',64),repeat('d',64),1000,1000,100,100,1,1,1,1,1,repeat('e',64),clock_timestamp()+interval '1 hour')",[workspaceId,f.mailbox.id,f.fixture.alpha.admin.userId,f.binding]);
  expect((await f.request('POST','/crm/business/mail/import/request',f.command({mailboxId:f.mailbox.id}))).status).toBe(200);
  const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));
  expect(queued.status,JSON.stringify(queued.body)).toBe(200);
  const messageId=(queued.body as {result:{messageId:string}}).result.messageId;
  const senderPid=(await senderQuery<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const backfillPid=(await backfillQuery<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const refresh=f.gmail.refreshAccessToken.bind(f.gmail);
  f.gmail.refreshAccessToken=async(...args)=>{const result=await refresh(...args);oauth.resolve();await resumeOauth.promise;return result;};
  // assertOutsideTransaction intentionally probes SAVEPOINT and handles 25P01.
  const remember=(error:unknown)=>{if(typeof error==='object'&&error!==null&&'code' in error&&String(error.code)!=='25P01')errors.push(String(error.code));};
  f.fixture.db.query=async <Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{try{return await senderQuery<Row>(text,values);}catch(error){remember(error);throw error;}};
  backfill.query=async <Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{
   try{
    const result=await backfillQuery<Row>(text,values);
    // Real canonical closure is acquired by recordRetainedOriginalMetadata before its UPDATE.
    if(!paused&&text==='SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=ANY($2::uuid[]) ORDER BY source_id FOR UPDATE'){
     paused=true;sourceLocked.resolve();await resumeSource.promise;
    }
    return result;
   }catch(error){remember(error);throw error;}
  };
  const gmail=recordedGmailClient({emailAddress:'owner@booking.example',historyId:'100',messages:[{id:'booking-source-1',threadId:'booking-thread',historyId:'99',internalDateEpochMilliseconds:Date.now()-90*86400000+3600000,headers:{From:'prospect@booking.example',To:'owner@booking.example',Subject:'Agreed call'}}]});
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,crmMailBackfill:{gmail,resolveAccess:async()=>({mailboxId:f.mailbox.id,providerAccountId:'controlled-google',generation:1,access:{accessToken:'controlled-token',expiresAtEpochSeconds:Date.now()/1000+3600}}),proofVerifier:{verify:async()=>true},allocationVerifier:{verify:async()=>true},observer:createApprovedBusinessMailObserver()}});
  const job=(await claimJobs(backfill,{owner:'booking-metadata-lock-order',kinds:['crm.mail_backfill'],limit:1,leaseSeconds:120}))[0]!;
  sending=f.run();void sending.catch(()=>undefined);
  await Promise.race([oauth.promise,sending.then(()=>{throw new Error('sender_did_not_refresh');})]);
  publishing=registry.get('crm.mail_backfill')!.handle({session:backfill,scope:workspaceScope(workspaceId,{kind:'system',component:'worker'}),job});void publishing.catch(()=>undefined);
  await Promise.race([sourceLocked.promise,publishing.then(()=>{throw new Error('backfill_did_not_lock_retained_source');})]);
  expect(gmail.metadataReads).toEqual(['booking-source-1']);
  resumeOauth.resolve();
  const blocked=async(blocker:number,waiter:number)=>(await observer.query<{blocked:boolean}>('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked',[blocker,waiter])).rows[0]!.blocked;
  let sourceWait=false;
  for(let attempt=0;attempt<10000&&!sourceWait;attempt++)sourceWait=await blocked(backfillPid,senderPid);
  expect(sourceWait,'actual sender must wait on the registered metadata publisher canonical closure').toBe(true);
  resumeSource.resolve();
  let done=false;void Promise.allSettled([sending,publishing]).then(()=>{done=true;});
  for(let attempt=0;attempt<10000&&!done&&!cycle;attempt++)cycle=await blocked(backfillPid,senderPid)&&await blocked(senderPid,backfillPid);
  const outcomes=await Promise.allSettled([sending,publishing]);sending=undefined;publishing=undefined;
  expect({cycle,errors},'real pg_blocking_pids cycle and SQLSTATE evidence').toEqual({cycle:false,errors:[]});
  expect(outcomes.map(outcome=>outcome.status)).toEqual(['fulfilled','fulfilled']);
  expect((await f.request('POST','/crm/business/mail/read/v2',f.source)).body).toMatchObject({state:'available',source:{originalObservation:{state:'available',revision:'1'}}});
  expect((await f.request('GET',`/meetings/booking-messages?messageId=${messageId}`)).body).toMatchObject({state:'held'});
  expect(f.gmail.sends).toHaveLength(0);
  expect((await senderQuery<{subject:string;attempt_token:string|null}>(`SELECT subject,attempt_token FROM outbound_messages WHERE workspace_id=$1 AND id=(SELECT outbound_message_id FROM booking_message_requests WHERE workspace_id=$1 AND id=$2)`,[workspaceId,messageId])).rows[0]).toMatchObject({subject:'Re: Our call',attempt_token:null});
 }finally{
  resumeOauth.resolve();resumeSource.resolve();if(sending)await sending.catch(()=>undefined);if(publishing)await publishing.catch(()=>undefined);
  f.fixture.db.query=senderQuery;backfill.query=backfillQuery;await f.stop();
 }
});
