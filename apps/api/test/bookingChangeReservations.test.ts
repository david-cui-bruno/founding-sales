import {describe,it,expect,vi} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
import type {BookingCreateRuntime} from '@fss/domain/meetings/bookingCreateRuntime.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runOnce} from '../../worker/src/runner/jobRunner.ts';
const idOf=(body:unknown)=>(body as {result:{submissionId:string}}).result.submissionId;
async function setup(){
 const f=await setupBookingChange();let creates=0;
 const create:BookingCreateRuntime={policy:f.runtime.policy,readCostContract:async()=>({accountId:'9',eventTypeId:7,operationScope:'availability_create_inspection',maximumCents:0,verifiedAt:'2026-10-13T16:00:00Z',validUntil:'2026-10-14T20:00:00Z',reference:'controlled-scoped-create-cost-not-real-pricing'}),provider:{availability:async()=>({available:true,reason:null}),inspect:async()=>({state:'unknown',reason:'controlled_unknown'}),create:async call=>{creates++;return {state:'accepted',booking:{id:42,uid:`created-${call.submissionId}`,eventTypeId:call.eventTypeId,accountId:call.accountId,organizerEmail:call.organizerEmail,attendeeEmail:call.attendee.email,startsAt:call.startsAt,endsAt:new Date(Date.parse(call.startsAt)+20*60_000).toISOString(),updatedAt:'2026-10-13T17:01:00Z',submissionId:call.submissionId}};}}};
 Object.assign(f.runtimeOptions,{bookingCreate:create});
 const agreedSlot={startsAt:'2026-10-15T14:00:00Z',timeZone:'America/New_York'};
 const change={...f.payload,action:'reschedule' as const,agreedSlot,confirmation:'owner_confirmed_attendee_unconditional_exact_slot' as const};
 const agreement=await f.capture('I agree to Thursday October 15 at 10 AM New York.');
 const creation={expectedPolicyRevision:1,attendeeRouteId:f.attendeeRouteId,agreement,agreedSlot,confirmation:'owner_confirmed_unconditional_exact_slot' as const};
 async function run(){const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:create,bookingChange:f.runtime});const result=await runOnce(f.fixture.db,{registry,owner:'booking-cross-controlled-runner',limit:20,classes:['urgent']});expect(result.failed).toBe(0);}
 return {...f,create,change,creation,run,creates:()=>creates};
}
describe('ordinary create and reschedule shared reservations',()=>{
 it.each(['create','reschedule'] as const)('concurrent ordinary calls with %s reaching the shared reservation first admit one',async first=>{
  const f=await setup(),blocker=await f.fixture.database.appRuntimeSession(),second=await f.fixture.database.appRuntimeSession();let locked=false;let firstRun:Promise<unknown>|undefined,secondRun:Promise<unknown>|undefined;
  try{
   await blocker.query('BEGIN');locked=true;await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${f.fixture.alpha.workspaceId}:booking_create:9`]);
   const pid=Number((await f.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid),blockerPid=Number((await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
   const invoke=(kind:'create'|'reschedule',db=f.db)=>f.request('POST',kind==='create'?'/meetings/booking-create':'/meetings/booking-change',f.command(kind==='create'?f.creation:f.change),db);
   const pending=invoke(first);firstRun=pending;
   await vi.waitFor(async()=>{expect((await blocker.query<{blockers:number[]}>('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0]?.blockers).toContain(blockerPid);},{timeout:5000,interval:10});
   const other=invoke(first==='create'?'reschedule':'create',second);secondRun=other;
   await blocker.query('COMMIT');locked=false;
   const [winner,loser]=await Promise.all([pending,other]);expect(winner.status).toBe(200);expect(loser.status).toBe(409);expect(loser.body).toMatchObject({reason:'slot_unavailable'});
   await f.run();expect(f.creates()+f.writes.length).toBe(1);
  }finally{if(locked)await blocker.query('ROLLBACK');await Promise.all([firstRun?.catch(()=>undefined),secondRun?.catch(()=>undefined)]);await f.stop();}
 });
 it.each(['cancel','reschedule'] as const)('a create-derived appointment supports explicit %s while human notes and unknown attendance survive',async action=>{
  const f=await setup();try{
   const admitted=await f.request('POST','/meetings/booking-create',f.command({...f.creation,agreedSlot:{startsAt:'2026-10-14T14:00:00Z',timeZone:'America/New_York'}}));expect(admitted.status).toBe(200);await f.run();
   const created=(await f.request('GET',`/meetings/booking-create?submissionId=${idOf(admitted.body)}`)).body as {state:string;meetingId:string;providerBookingUid:string};expect(created.state).toBe('accepted');
   expect((await f.request('POST','/meetings/notes',f.command({meetingId:created.meetingId,expectedRevision:0,debrief:'Human correction retained',speakerMappings:[],itemOverrides:[],sufficient:true}))).status).toBe(200);
   const agreement=await f.capture(action==='cancel'?'Please cancel our Wednesday appointment.':'Please move our appointment to Thursday October 15 at 10 AM New York.');
   const common={...f.payload,meetingId:created.meetingId,expectedBookingUid:created.providerBookingUid,agreement};
   const request=action==='cancel'?common:{...common,action:'reschedule',agreedSlot:f.change.agreedSlot,confirmation:'owner_confirmed_attendee_unconditional_exact_slot'};
   const changed=await f.request('POST','/meetings/booking-change',f.command(request));expect(changed.status).toBe(200);await f.run();
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${idOf(changed.body)}`)).body).toMatchObject({state:'accepted',meetingId:created.meetingId});
   const before=(await f.request('GET',`/meetings/outcomes?meetingId=${created.meetingId}`)).body;expect(before).toMatchObject({notes:{revision:1,debrief:'Human correction retained'}});expect(JSON.stringify(before)).not.toContain('"attendance":"attended"');
   await f.callback(created.providerBookingUid,'BOOKING_CREATED','2026-10-14T14:00:00Z','2026-10-13T17:00:00Z');
   expect((await f.request('GET',`/meetings/outcomes?meetingId=${created.meetingId}`)).body).toEqual(before);expect(f.creates()).toBe(1);expect(f.writes).toHaveLength(1);
   const list=await f.request('GET',`/meetings/firm?firmId=${f.firmId}`);expect(JSON.stringify(list.body)).toContain(created.meetingId);expect((await f.request('GET','/today/actions/v2')).status).toBe(200);
  }finally{await f.stop();}
 });
 it('unknown reschedule holds its exact window after registry restart and inspection never replays',async()=>{
  const f=await setup();try{
   f.controls.dropResponse=true;const change=await f.request('POST','/meetings/booking-change',f.command(f.change));expect(change.status).toBe(200);await f.run();const id=idOf(change.body);
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'unknown'});
   expect((await f.request('POST','/meetings/booking-create',f.command(f.creation))).body).toMatchObject({reason:'slot_unavailable'});
   await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(1);expect(f.creates()).toBe(0);
  }finally{await f.stop();}
 });
});
