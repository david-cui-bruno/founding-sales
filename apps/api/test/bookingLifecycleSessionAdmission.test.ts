import {describe,it,expect,vi} from 'vitest';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {dispatch} from '../src/server.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {setupConversation,captureAt} from './support/bookingConversationFixture.ts';
import {bookingStopsFixture} from './support/bookingStopsFixture.ts';

type Endpoint='request'|'event'|'message';
async function setup(endpoint:Endpoint){
 if(endpoint==='request'){
  const f=await setupConversation();try{
   const text='Yes, that works.',{source}=await captureAt(f,text,'2026-10-13T16:01:00Z');
   const offered=(await f.request('POST','/crm/business/mail/read',f.offer)).body as {source:{passage:string}};
   const target=new Date(f.startsAt),localDate=new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(target),localTime=new Intl.DateTimeFormat('en-GB',{timeZone:'America/New_York',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(target);
   f.setCandidate({intent:'accept_slot',agreement:{sourceId:source.sourceId,start:0,end:text.length,quote:text},slot:{localDate,localTime,timeZone:'America/New_York',evidence:{sourceId:f.offer.sourceId,start:0,end:offered.source.passage.length,quote:offered.source.passage}},substantive:null});
   const interpreted=await f.request('POST','/crm/booking/interpretation/request',f.command({source,priorSources:[f.offer]}));expect(interpreted.status,JSON.stringify(interpreted.body)).toBe(200);
   const requestId=(interpreted.body as {result:{requestId:string}}).result.requestId;
   const job=(await claimJobs(f.fixture.db,{owner:'624-admission-interpreter',kinds:['crm.booking_interpretation'],limit:1,leaseSeconds:120}))[0]!;
   await f.registry.get('crm.booking_interpretation')!.handle({session:f.fixture.db,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
   return {fixture:f.fixture,token:f.token,db:f.db,command:f.command,request:f.request,conversation:f.conversation,messages:undefined,conversationId:f.conversationId,path:'/meetings/booking-conversation',payload:{interpretationRequestId:requestId,expectedPolicyRevision:1},stop:()=>f.fixture.stop()};
  }catch(error){await f.fixture.stop();throw error;}
 }
 const f=await bookingStopsFixture();
 Object.assign(f.conversation,{messages:f.runtime});
 return {fixture:f.fixture,token:f.token,db:f.db,command:f.command,request:f.request,conversation:f.conversation,messages:f.runtime,conversationId:f.conversationId,path:endpoint==='event'?'/meetings/booking-conversation/event':'/meetings/booking-messages',payload:endpoint==='event'?{conversationId:f.conversationId,expectedPolicyRevision:1,event:'manual_nudge'}:{conversationId:f.conversationId,kind:'approved_link'},stop:f.stop};
}
type Fixture=Awaited<ReturnType<typeof setup>>;
async function durable(f:Fixture,db=f.db){
 const workspace=f.fixture.alpha.workspaceId;
 return {
  conversations:(await db.query('SELECT * FROM booking_conversations WHERE workspace_id=$1 ORDER BY id',[workspace])).rows,
  messages:(await db.query('SELECT * FROM booking_message_requests WHERE workspace_id=$1 ORDER BY id',[workspace])).rows,
  outbound:(await db.query('SELECT * FROM outbound_messages WHERE workspace_id=$1 ORDER BY id',[workspace])).rows,
  jobs:(await db.query('SELECT * FROM jobs WHERE workspace_id=$1 ORDER BY id',[workspace])).rows,
  counters:(await db.query('SELECT * FROM daily_counters WHERE workspace_id=$1 ORDER BY business_date,counter_kind,subject_kind,subject_key',[workspace])).rows,
 };
}
function gate(){let resolve=()=>{};const wait=new Promise<void>(r=>{resolve=r;});return {wait,resolve};}
const losses=['sign-out','device-revoke'] as const;
describe('624 exact-session public booking lifecycle admission',()=>{
 it.each((['request','event','message'] as const).flatMap(endpoint=>losses.map(loss=>({endpoint,loss}))))('$endpoint rolls back its durable mutation after $loss across an actual ordinary database wait',async({endpoint,loss})=>{
  const f=await setup(endpoint),blocker=await f.fixture.database.appRuntimeSession(),observer=await f.fixture.database.appRuntimeSession(),owner=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin,{deviceLabel:'624 command admission owner'});
  let locked=false,pending:Promise<Awaited<ReturnType<typeof dispatch>>>|undefined;
  const call=(path:string,body:unknown,db:SessionQueryable=f.db)=>dispatch({method:'POST',path,query:new URLSearchParams(),body,headers:{authorization:`Bearer ${owner.accessToken}`}},{session:db,auth:{...f.fixture.deps,db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingConversation:f.conversation,...(f.messages===undefined?{}:{bookingMessages:f.messages})});
  try{
   expect((await observer.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
   const before=await durable(f,observer),command=f.command(f.payload);
   await blocker.query('BEGIN');locked=true;
   if(endpoint==='request')await blocker.query('SELECT source_id FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=(SELECT source_refs->0->>\'sourceId\' FROM crm_booking_interpretations WHERE workspace_id=$1 AND id=$2)::uuid FOR UPDATE',[f.fixture.alpha.workspaceId,(f.payload as {interpretationRequestId:string}).interpretationRequestId]);
   else await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[sendGateLockName(f.fixture.alpha.workspaceId)]);
   const waiting=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,blocking=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   pending=call(f.path,command);void pending.catch(()=>undefined);
   await vi.waitFor(async()=>expect((await observer.query<{blockers:number[]}>('SELECT pg_blocking_pids($1) AS blockers',[waiting])).rows[0]?.blockers).toContain(blocking),{timeout:5000,interval:10});
   if(loss==='sign-out')expect((await call('/auth/sign-out',{},observer)).status).toBe(200);
   else expect((await dispatch({method:'POST',path:'/devices/revoke',query:new URLSearchParams(),body:{deviceId:owner.deviceId},headers:{authorization:`Bearer ${f.token}`}},{session:observer,auth:{...f.fixture.deps,db:observer},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false})).status).toBe(200);
   expect((await observer.query("SELECT role,status FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2",[f.fixture.alpha.workspaceId,f.fixture.alpha.admin.userId])).rows[0]).toEqual({role:'admin',status:'active'});
   await blocker.query('COMMIT');locked=false;
   expect.soft((await pending).status).toBe(401);
   expect.soft((await observer.query('SELECT count(*)::int AS n FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows[0]).toEqual({n:0});
   expect.soft(await durable(f,observer)).toEqual(before);
  }finally{if(locked)await blocker.query('ROLLBACK');await pending?.catch(()=>undefined);await f.stop();}
 });
 it.each((['request_replay','event_replay','message_replay','conversation_read','message_read'] as const).flatMap(surface=>losses.map(loss=>({surface,loss}))))('$surface does not publish private results after $loss across its final response wait',async({surface,loss})=>{
  const endpoint:Endpoint=surface==='request_replay'?'request':surface==='event_replay'?'event':'message';
  const f=await setup(endpoint),observer=await f.fixture.database.appRuntimeSession(),owner=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin,{deviceLabel:'624 private response owner'}),held=gate(),release=gate();let paused=false,pending:Promise<Awaited<ReturnType<typeof dispatch>>>|undefined;
  const call=(method:string,path:string,body?:unknown,db:SessionQueryable=f.db)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${owner.accessToken}`}},{session:db,auth:{...f.fixture.deps,db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingConversation:f.conversation,...(f.messages===undefined?{}:{bookingMessages:f.messages})});};
  try{
   const command=f.command(f.payload),admitted=await call('POST',f.path,command);expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
   const retained=(await observer.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows;
   const before=await durable(f,observer);
   const responseSession:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await f.db.query<Row>(text,values);const boundary=surface==='message_read'?text.includes('FROM outbound_messages'):surface==='message_replay'?text.includes('FROM command_receipts'):text==='COMMIT';if(!paused&&boundary){paused=true;held.resolve();await release.wait;}return result;}};
   const readPath=surface==='conversation_read'?`/meetings/booking-conversation?conversationId=${f.conversationId}`:`/meetings/booking-messages?messageId=${(admitted.body as {result:{messageId:string}}).result.messageId}`;
   pending=surface.endsWith('_replay')?call('POST',f.path,command,responseSession):call('GET',readPath,undefined,responseSession);void pending.catch(()=>undefined);
   await vi.waitFor(()=>expect(paused).toBe(true),{timeout:5000,interval:10});await held.wait;
   if(loss==='sign-out')expect((await call('POST','/auth/sign-out',{},observer)).status).toBe(200);
   else expect((await dispatch({method:'POST',path:'/devices/revoke',query:new URLSearchParams(),body:{deviceId:owner.deviceId},headers:{authorization:`Bearer ${f.token}`}},{session:observer,auth:{...f.fixture.deps,db:observer},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false})).status).toBe(200);
   release.resolve();expect((await pending).status).toBe(401);
   expect((await observer.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows).toEqual(retained);
   expect(await durable(f,observer)).toEqual(before);
  }finally{release.resolve();await pending?.catch(()=>undefined);await f.stop();}
 });
 it.each(['request','event','message'] as const)('active exact-session %s command replays its immutable receipt without further mutation',async endpoint=>{
  const f=await setup(endpoint),owner=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin,{deviceLabel:'624 active replay owner'});
  const call=(command:unknown)=>dispatch({method:'POST',path:f.path,query:new URLSearchParams(),body:command,headers:{authorization:`Bearer ${owner.accessToken}`}},{session:f.db,auth:{...f.fixture.deps,db:f.db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingConversation:f.conversation,...(f.messages===undefined?{}:{bookingMessages:f.messages})});
  try{
   const command=f.command(f.payload),admitted=await call(command);expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
   const before=await durable(f),retained=(await f.db.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows;
   expect((await call(command)).body).toMatchObject({status:'accepted',replayed:true});
   expect((await f.db.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows).toEqual(retained);expect(await durable(f)).toEqual(before);
  }finally{await f.stop();}
 });
 it.each(['conversation_read','request_replay'] as const)('%s returns current unknown when the same private authority observation expires across forwarded COMMIT',async surface=>{
  const f=await setup('request'),held=gate(),release=gate();let paused=false,pending:Promise<Awaited<ReturnType<typeof dispatch>>>|undefined;
  const owner=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin,{deviceLabel:'624 terminal expiry owner'});
  const call=(method:string,path:string,body?:unknown,db:SessionQueryable=f.db)=>{const url=new URL(path,'https://fixture.test');return dispatch({method,path:url.pathname,query:url.searchParams,body,headers:{authorization:`Bearer ${owner.accessToken}`}},{session:db,auth:{...f.fixture.deps,db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingConversation:f.conversation});};
  try{
   const command=f.command(f.payload),admitted=await call('POST',f.path,command);expect(admitted.status,JSON.stringify(admitted.body)).toBe(200);
   const conversationId=(admitted.body as {result:{conversationId:string}}).result.conversationId,readPath=`/meetings/booking-conversation?conversationId=${conversationId}`;
   let clock=new Date().toISOString(),observations=0;const readEvidence=f.conversation.policy.readEvidence;
   f.conversation.policy.now=()=>clock;
   f.conversation.policy.readEvidence=async(...args)=>{observations++;return readEvidence(...args);};
   const invoke=(db:SessionQueryable=f.db)=>surface==='request_replay'?call('POST',f.path,command,db):call('GET',readPath,undefined,db);
   const baseline=await invoke();expect(baseline.status,JSON.stringify(baseline.body)).toBe(200);const ordinaryObservations=observations;expect(ordinaryObservations).toBeGreaterThan(0);observations=0;
   const before=await durable(f),retained=(await f.db.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows;
   const responseSession:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await f.db.query<Row>(text,values);if(!paused&&text==='COMMIT'){paused=true;held.resolve();await release.wait;}return result;}};
   pending=invoke(responseSession);void pending.catch(()=>undefined);await vi.waitFor(()=>expect(paused).toBe(true),{timeout:5000,interval:10});await held.wait;
   clock=new Date(Date.parse(clock)+8*86400_000).toISOString();release.resolve();
   const response=await pending;expect(response.status).toBe(409);expect(response.body).toEqual({error:'booking_readiness_unavailable'});
   expect(observations,'terminal response must reuse the existing observation, not recontact the provider').toBe(ordinaryObservations);
   expect(await durable(f)).toEqual(before);expect((await f.db.query('SELECT * FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows).toEqual(retained);
  }finally{release.resolve();await pending?.catch(()=>undefined);await f.stop();}
 });
});
