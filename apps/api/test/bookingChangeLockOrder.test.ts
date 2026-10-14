import {describe,it,expect} from 'vitest';
import type {BookingChangePayload} from '@fss/contracts';
import type {QueryResultRowLike,SessionQueryable} from '@fss/domain/db/queryable.ts';
import {createBookingInterpretationAuthority} from '@fss/domain/crm/bookingInterpretationAuthority.ts';
import {dispatch} from '../src/server.ts';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
function barrier(){let resolve=()=>{};const wait=new Promise<void>(done=>{resolve=done;});return {wait,resolve};}
describe('ordinary booking change canonical source/policy lock order',()=>{
 it.each(['cancel','reschedule'] as const)('normal interpretation read and %s serialize without PostgreSQL deadlock',async action=>{
  const f=await setupBookingChange(),reading=await f.fixture.database.appRuntimeSession();const sourceLocked=barrier(),resumeRead=barrier();let paused=false;const errors:string[]=[];let concurrent:Promise<unknown>[]=[];
  const observe=(db:SessionQueryable,pause:boolean):SessionQueryable=>({query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{
   try{const result=await db.query<Row>(text,values);if(pause&&!paused&&text.includes('SELECT source_id FROM crm_mail_sources')&&text.includes('FOR UPDATE')){paused=true;sourceLocked.resolve();await resumeRead.wait;}return result;}
   catch(error){if(error!==null&&typeof error==='object'&&'code' in error)errors.push(String(error.code));throw error;}
  }});
  const authority=createBookingInterpretationAuthority(f.runtime.policy);
  const interpret=(path:string,body:unknown,session:SessionQueryable)=>dispatch({method:'POST',path,body,query:new URLSearchParams(),headers:{authorization:`Bearer ${f.token}`}},{session,auth:{...f.fixture.deps,db:session},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingInterpretationAuthority:authority});
  try{
   expect((await reading.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});expect((await f.db.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
   let payload:BookingChangePayload=f.payload;
   if(action==='reschedule'){const offeredContext=await f.capture('Can we move our existing call to October 15, 2026 at 11 AM America/New_York?','outgoing'),agreement=await f.capture('Yes, that Thursday time works. Please move our existing appointment.');payload={...f.payload,action,confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreement,offeredContext,agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};}
   const requested=await interpret('/crm/booking/interpretation/request',f.command({source:payload.agreement,priorSources:payload.action==='reschedule'&&payload.offeredContext!==undefined?[payload.offeredContext]:[]}),reading);expect(requested.status,JSON.stringify(requested.body)).toBe(200);expect(requested.body).toMatchObject({result:{state:'pending'}});
   const requestId=(requested.body as {result:{requestId:string}}).result.requestId;
   const readPid=(await reading.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,changePid=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const read=interpret('/crm/booking/interpretation/read',{requestId},observe(reading,true));concurrent=[read];await sourceLocked.wait;
   const change=f.request('POST','/meetings/booking-change',f.command(payload),observe(f.db,false));concurrent.push(change);
   // Every query goes to PostgreSQL. Retain real error codes before releasing the
   // source barrier, never a mocked lock or copied positive state SQL.
   const settled=Promise.allSettled([read,change]);let sourceWaitObserved=false;
   for(let attempt=0;attempt<400;attempt++){if((await f.fixture.db.query('SELECT 1 WHERE $2::int=ANY(pg_blocking_pids($1::int))',[changePid,readPid])).rows.length){sourceWaitObserved=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   expect(sourceWaitObserved,'normal change must really wait on interpretation-held canonical sources').toBe(true);resumeRead.resolve();const results=await settled;
   expect.soft(errors,'ordinary source-first interpretation and change must not produce actual PostgreSQL40P01').not.toContain('40P01');
   expect.soft(results.map(result=>result.status==='fulfilled'?result.value.status:String(result.reason))).toEqual([200,200]);
   expect.soft((await f.fixture.db.query('SELECT action,state,dispatch_started_at FROM booking_change_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toEqual([{action,state:'pending',dispatch_started_at:null}]);
   expect(f.writes).toHaveLength(0);expect(f.inspections).toHaveLength(0);
  }finally{resumeRead.resolve();await Promise.allSettled(concurrent);await f.stop();}
 });
});
