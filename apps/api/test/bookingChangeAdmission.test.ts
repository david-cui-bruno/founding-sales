import {expect,it,vi} from 'vitest';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import {dispatch} from '../src/server.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {setupBookingChange} from './support/bookingChangeFixture.ts';

it.each(['admission','inspection'].flatMap(endpoint=>['sign-out','device-revoke'].map(loss=>({endpoint,loss}))))('does not commit a booking change command after $loss during its $endpoint wait',async({endpoint,loss})=>{
 const f=await setupBookingChange(),blocker=await f.fixture.database.appRuntimeSession(),observer=await f.fixture.database.appRuntimeSession();
 const owner=await issueSessionFor(f.fixture,f.fixture.alpha,f.fixture.alpha.admin,{deviceLabel:'change admission owner'});
 let locked=false,pending:Promise<Awaited<ReturnType<typeof dispatch>>>|undefined;
 const call=(path:string,body:unknown,db=f.db)=>dispatch({method:'POST',path,query:new URLSearchParams(),body,headers:{authorization:`Bearer ${owner.accessToken}`}},{session:db,auth:{...f.fixture.deps,db},supportedClientVersions:f.fixture.deps.config.supportedClientVersions,sendingEnabled:false,bookingChange:f.runtime,bookingPolicyRuntime:f.runtime.policy});
 try{
  let path='/meetings/booking-change',command=f.command(f.payload);
  if(endpoint==='inspection'){
   f.controls.dropResponse=true;
   const admitted=await call(path,command);expect(admitted.status).toBe(200);
   const submissionId=(admitted.body as {result:{submissionId:string}}).result.submissionId;
   await f.run();expect(f.writes).toHaveLength(1);
   path+='/inspect';command=f.command({submissionId});
  }
  await blocker.query('BEGIN');locked=true;
  if(endpoint==='admission')await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[sendGateLockName(f.fixture.alpha.workspaceId)]);
  else await blocker.query('LOCK TABLE booking_change_submissions IN ACCESS EXCLUSIVE MODE');
  const waiting=(await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blocking=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  pending=call(path,command);void pending.catch(()=>undefined);
  await vi.waitFor(async()=>expect((await observer.query<{blockers:number[]}>('SELECT pg_blocking_pids($1) AS blockers',[waiting])).rows[0]?.blockers).toContain(blocking),{timeout:5000,interval:10});
  if(loss==='sign-out')expect((await call('/auth/sign-out',{},observer)).status).toBe(200);
  else expect((await f.request('POST','/devices/revoke',{deviceId:owner.deviceId},observer)).status).toBe(200);
  await blocker.query('COMMIT');locked=false;
  expect((await pending).status).toBe(401);
  expect((await observer.query('SELECT count(*)::int AS n FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows[0]).toEqual({n:0});
  expect((await observer.query("SELECT count(*)::int AS n FROM booking_change_submissions WHERE workspace_id=$1",[f.fixture.alpha.workspaceId])).rows[0]).toEqual({n:endpoint==='admission'?0:1});
  expect((await observer.query("SELECT count(*)::int AS n FROM jobs WHERE workspace_id=$1 AND kind='meeting.booking_change' AND payload->>'inspectionOnly'='true'",[f.fixture.alpha.workspaceId])).rows[0]).toEqual({n:0});
 }finally{if(locked)await blocker.query('ROLLBACK');await pending?.catch(()=>undefined);await f.stop();}
});
