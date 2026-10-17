import {describe,it,expect} from 'vitest';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';
import {dispatch} from '../src/server.ts';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';

function deferred(){let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done;});return {promise,resolve};}

describe('booking sender and canonical source deletion lock order',()=>{
 it('serializes normal deletion against the real post-OAuth fence claim without a PostgreSQL deadlock',async()=>{
  const f=await bookingStopsFixture(),deleting=await f.fixture.database.appRuntimeSession(),observer=await f.fixture.database.appRuntimeSession();
  const locked=deferred(),resume=deferred(),errors:string[]=[];
  let oauthRefreshes=0;
  const refresh=f.gmail.refreshAccessToken.bind(f.gmail);
  f.gmail.refreshAccessToken=async(...args)=>{oauthRefreshes++;return refresh(...args);};
  const query=f.fixture.db.query.bind(f.fixture.db);
  let running:Promise<void>|undefined,deletion:ReturnType<typeof dispatch>|undefined,paused=false;
  try{
   const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));
   expect(queued.status,JSON.stringify(queued.body)).toBe(200);
   const messageId=(queued.body as {result:{messageId:string}}).result.messageId;
   const senderPid=(await query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const deletePid=(await deleting.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   // Execute the real FOR UPDATE first. Pause only after PostgreSQL owns the fence,
   // which is inside the registered sender's post-OAuth claiming transaction.
   f.fixture.db.query=async <Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{
    try{
     const result=await query<Row>(text,values);
     if(!paused&&text.includes('FROM outbound_messages WHERE')&&text.endsWith('FOR UPDATE')){
      paused=true;locked.resolve();await resume.promise;
     }
     return result;
    }catch(error){if(typeof error==='object'&&error!==null&&'code' in error)errors.push(String(error.code));throw error;}
   };
   running=f.run();await Promise.race([locked.promise,running.then(()=>{throw new Error('registered_sender_did_not_reach_real_fence_claim');})]);
   expect(oauthRefreshes).toBe(1);
   const deleteQuery=deleting.query.bind(deleting);
   const session:SessionQueryable={query:async <Row extends Record<string,unknown>>(text:string,values?:readonly unknown[])=>{
    try{return await deleteQuery<Row>(text,values);}catch(error){if(typeof error==='object'&&error!==null&&'code' in error)errors.push(String(error.code));throw error;}
   }};
   deletion=dispatch({method:'POST',path:'/crm/business/mail/delete',query:new URLSearchParams(),body:f.command({sourceId:f.source.sourceId,expectedRevision:1}),headers:{authorization:`Bearer ${f.token}`}},{session,auth:{...f.fixture.deps,db:session},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false});
   let blocked=false;
   for(let attempt=0;attempt<100000&&!blocked;attempt++)blocked=(await observer.query<{blocked:boolean}>('SELECT $1=ANY(pg_blocking_pids($2)) AS blocked',[senderPid,deletePid])).rows[0]!.blocked;
   expect(blocked,'normal deletion must genuinely wait on the paused claiming sender').toBe(true);
   resume.resolve();
   const outcomes=await Promise.allSettled([running,deletion]);running=undefined;deletion=undefined;
   expect(errors,'real PostgreSQL SQLSTATEs, not fixture failures').not.toContain('40P01');
   expect(outcomes[0]!.status).toBe('fulfilled');
   expect(outcomes[1]!.status).toBe('fulfilled');
   if(outcomes[1]!.status!=='fulfilled')throw outcomes[1]!.reason;
   expect(outcomes[1]!.value).toMatchObject({status:200});
   expect((await f.request('POST','/crm/business/mail/read',f.source)).body).toMatchObject({state:'unavailable'});
   const fence=(await query<{subject:string;state:string;provider_message_id:string|null}>(`SELECT subject,state,provider_message_id FROM outbound_messages WHERE workspace_id=$1 AND id=(SELECT outbound_message_id FROM booking_message_requests WHERE workspace_id=$1 AND id=$2)`,[f.fixture.alpha.workspaceId,messageId])).rows[0]!;
   expect(fence.subject).toBe('Re: Agreed call');
   // The sender already owns the gate: accepted dispatch remains irreversible,
   // including its attempted envelope evidence, while the private source is erased.
   expect(f.gmail.sends).toHaveLength(1);expect(fence.state).toBe('sent');expect(fence.provider_message_id).not.toBeNull();
  }finally{
   resume.resolve();if(running)await running.catch(()=>undefined);if(deletion)await deletion.catch(()=>undefined);
   f.fixture.db.query=query;await f.stop();
  }
 });
 it('erases a queued private subject and source before a later registered sender can claim',async()=>{
  const f=await bookingStopsFixture();try{
   const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));expect(queued.status).toBe(200);
   const messageId=(queued.body as {result:{messageId:string}}).result.messageId;
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   const fence=(await f.fixture.db.query<{subject:string;attempt_token:string|null;dispatch_started_at:Date|null}>(`SELECT subject,attempt_token,dispatch_started_at FROM outbound_messages WHERE workspace_id=$1 AND id=(SELECT outbound_message_id FROM booking_message_requests WHERE workspace_id=$1 AND id=$2)`,[f.fixture.alpha.workspaceId,messageId])).rows[0]!;
   expect(fence).toMatchObject({subject:'Re: Our call',attempt_token:null,dispatch_started_at:null});
   expect((await f.fixture.db.query<{count:string}>('SELECT count(*)::text AS count FROM mail_message_bodies WHERE workspace_id=$1 AND mail_message_id=$2',[f.fixture.alpha.workspaceId,f.source.sourceId])).rows[0]!.count).toBe('0');
   await f.run();expect(f.gmail.sends).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-messages?messageId=${messageId}`)).body).toMatchObject({state:'held'});
  }finally{await f.stop();}
 });
 it('deletes a source without any queued fence and keeps restore revision semantics',async()=>{
  const f=await bookingStopsFixture();try{
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   expect((await f.request('POST','/crm/business/mail/restore',f.command({sourceId:f.source.sourceId,expectedRevision:2}))).status).toBe(200);
   expect(f.gmail.sends).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('retains unknown dispatch facts and attempted envelope evidence on source deletion',async()=>{
  const f=await bookingStopsFixture();try{
   const queued=await f.request('POST','/meetings/booking-messages',f.command({conversationId:f.conversationId,kind:'approved_link'}));expect(queued.status).toBe(200);
   const messageId=(queued.body as {result:{messageId:string}}).result.messageId;
   let calls=0;f.gmail.sendMessage=async()=>{calls++;return {ok:false,outcome:'indeterminate',detail:'controlled-response-lost'};};
   await f.run();expect((await f.request('GET',`/meetings/booking-messages?messageId=${messageId}`)).body).toMatchObject({state:'reconciling'});
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.source.sourceId,expectedRevision:1}))).status).toBe(200);
   await f.run();expect(calls).toBe(1);
   expect((await f.request('GET',`/meetings/booking-messages?messageId=${messageId}`)).body).toMatchObject({state:'reconciling'});
   expect((await f.fixture.db.query<{subject:string}>(`SELECT subject FROM outbound_messages WHERE workspace_id=$1 AND id=(SELECT outbound_message_id FROM booking_message_requests WHERE workspace_id=$1 AND id=$2)`,[f.fixture.alpha.workspaceId,messageId])).rows[0]!.subject).toBe('Re: Agreed call');
  }finally{await f.stop();}
 });
});
