import {describe,it,expect} from 'vitest';
import type {BookingChangePayload} from '@fss/contracts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
describe('public booking change Route authority after terminal waits',()=>{
 it.each(['cancel','reschedule'] as const)('%s refuses a disjoint-firm shared attendee added during receipt wait',async action=>runRouteWait(action,'receipt'));
 it.each(['cancel','reschedule'] as const)('%s refuses a disjoint-firm shared attendee added during final cost wait',async action=>runRouteWait(action,'cost'));
 it.each(['cancel','reschedule'] as const)('%s remains eligible when only an unrelated endpoint is added during receipt wait',async action=>runRouteWait(action,'receipt',true));
 it.each(['cancel','reschedule'] as const)('%s remains eligible when only an unrelated endpoint is added during final cost wait',async action=>runRouteWait(action,'cost',true));
 it.each(['cancel','reschedule'] as const)('%s conserves attempted unknown evidence when a shared attendee appears during inspection cost wait',async action=>runRouteWait(action,'cost',false,true));
});
async function runRouteWait(action:'cancel'|'reschedule',phase:'receipt'|'cost',unchanged=false,attempted=false){
 const f=await setupBookingChange(),blocker=await f.fixture.database.appRuntimeSession(),worker=await f.fixture.database.appRuntimeSession(),adding=await f.fixture.database.appRuntimeSession();let locked=false,running:Promise<unknown>|undefined;const firmLocks:string[]=[];
 const observedWorker:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await worker.query<Row>(text,values);if(text.includes('FROM firms')&&(text.includes('FOR UPDATE')||text.includes('FOR SHARE')))firmLocks.push(String(values?.[1]));return result;}};
 try{
  expect((await worker.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});expect((await adding.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
  const otherFirm=await seedFirm(f.fixture,{name:'Disjoint shared attendee',assignedUserId:f.fixture.alpha.admin.userId}),otherContact=await seedContact(f.fixture,{firmId:otherFirm,fullName:'Different attendee'});
  let payload:BookingChangePayload=f.payload;if(action==='reschedule'){const agreement=await f.capture('Please reschedule to October 15, 2026 at 11 AM America/New_York.');payload={...f.payload,action,agreement,confirmation:'owner_confirmed_attendee_unconditional_exact_slot',agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};}
  const command=f.command(payload),response=await f.request('POST','/meetings/booking-change',command);expect(response.status,JSON.stringify(response.body)).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
  if(attempted){f.controls.dropResponse=true;await f.run();expect(f.writes).toHaveLength(1);expect((await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}))).status).toBe(200);}
  const originalReceipt=(await f.fixture.db.query('SELECT result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows;
  expect(originalReceipt).toHaveLength(1);
  const before=(await f.fixture.db.query<{dispatch_started_at:Date|null}>('SELECT dispatch_started_at FROM booking_change_submissions WHERE id=$1',[id])).rows[0];
  const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,workerPid=(await worker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const costLock=`${f.fixture.alpha.workspaceId}:controlled-change-cost-observation`;let targetRead=attempted,costReads=0;
  const read=f.runtime.readCostContract;f.runtime.readCostContract=async snapshot=>{const contract=await read(snapshot);if(phase==='cost'&&targetRead&&++costReads===2)await observedWorker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[costLock]);return contract;};
  f.controls.targetWait=async()=>{targetRead=true;await blocker.query('BEGIN');locked=true;if(phase==='receipt')await blocker.query('SELECT id FROM booking_change_submissions WHERE id=$1 FOR UPDATE',[id]);else await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[costLock]);};
  if(attempted){await blocker.query('BEGIN');locked=true;await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[costLock]);}
  const job=(await claimJobs(f.fixture.db,{owner:'normal-change-route-wait-worker',kinds:['meeting.booking_change'],limit:1,leaseSeconds:120}))[0]!;
  const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingChange:f.runtime});
  running=registry.get('meeting.booking_change')!.handle({session:observedWorker,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
  let waiting=false;for(let attempt=0;attempt<400;attempt++){if((await blocker.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))',[workerPid,blockerPid])).rows.length){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
  expect(waiting,'registered app_runtime worker must actually wait after selected Route/ambiguity observation').toBe(true);
  const added=await f.request('POST','/contacts/routes/add',f.command({firmId:otherFirm,contactId:otherContact,routeKind:'email',value:unchanged?'different@booking.example':'prospect@booking.example',source:'salesperson',technicalValidation:'passed',associationConfidence:0.95}),adding);expect(added.status,JSON.stringify(added.body)).toBe(200);
  expect((await blocker.query('SELECT pid FROM pg_stat_activity WHERE pid=$1 AND $2::int=ANY(pg_blocking_pids(pid))',[workerPid,blockerPid])).rows).toHaveLength(1);
  await blocker.query('COMMIT');locked=false;await running;
  expect(firmLocks).toContain(f.firmId);expect(firmLocks).not.toContain(otherFirm);
  expect.soft(f.writes).toHaveLength(attempted||unchanged?1:0);expect(f.inspections).toHaveLength(0);
  expect.soft((await f.fixture.db.query('SELECT state,reason,dispatch_started_at FROM booking_change_submissions WHERE id=$1',[id])).rows[0]).toMatchObject(attempted?{state:'unknown',reason:'attendee_ambiguous',dispatch_started_at:before!.dispatch_started_at}:unchanged?{state:'accepted',reason:null,dispatch_started_at:expect.any(Date)}:{state:'failed',reason:'attendee_ambiguous',dispatch_started_at:null});
  expect((await f.fixture.db.query('SELECT result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows).toEqual(originalReceipt);
 }finally{if(locked)await blocker.query('ROLLBACK');if(running!==undefined)await Promise.allSettled([running]);await f.stop();}
}
