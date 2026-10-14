import {describe,it,expect} from 'vitest';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {setupBooking} from './bookingCreate.test.ts';

// Reuse the exported genuine canonical-source/public-command fixture. Its original
// suite also runs here, preserving all existing admission and recovery regressions.
const stops=[{scope:'handle',channel:'email'},{scope:'handle',channel:'all'},{scope:'firm',channel:'all'}] as const;
type Fixture=Awaited<ReturnType<typeof setupBooking>>;
async function stop(f:Fixture,target:{scope:'firm'|'handle';channel:'email'|'all'|'phone'}){
 const response=await f.request('POST','/suppressions/record',f.command({...target,source:'prospect_opt_out',...(target.scope==='firm'?{firmId:f.firmId}:{value:'PROSPECT@booking.example'})}));
 expect(response.status,JSON.stringify(response.body)).toBe(200);
 expect((await f.request('GET','/suppressions')).body).toMatchObject({suppressions:[{scope:target.scope,channel:target.channel,source:'prospect_opt_out'}]});
}
function gate(){let resolve=()=>{};const wait=new Promise<void>(r=>{resolve=r;});return {wait,resolve};}
describe('public booking create honors current suppression stops',()=>{
 it.each(stops)('current $scope/$channel prospect opt-out refuses admission',async target=>{
  const f=await setupBooking();try{
   expect((await f.db.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
   await stop(f,target);
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));
   expect.soft(response.status).toBe(409);
   expect.soft(response.body).toMatchObject({reason:target.scope==='firm'?'firm_suppressed':'handle_suppressed'});
   expect.soft((await f.fixture.db.query('SELECT id FROM booking_create_submissions WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect.soft((await f.fixture.db.query("SELECT id FROM jobs WHERE workspace_id=$1 AND kind='meeting.booking_create'",[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect(f.requests).toHaveLength(0);
  }finally{await f.fixture.stop();}
 });
 it.each(stops)('committed $scope/$channel opt-out during controlled availability GET prevents marker and provider create',async target=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession();const entered=gate(),release=gate();let running:Promise<unknown>|undefined;
  try{
   expect((await worker.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   f.controls.onHttp=async(url,init)=>{if(url.pathname==='/v2/calendars/busy-times'){expect(init.method).toBe('GET');entered.resolve();await release.wait;}};
   const job=(await claimJobs(f.fixture.db,{owner:'suppression-controlled-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:f.runtime});
   running=registry.get('meeting.booking_create')!.handle({session:worker,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
   await entered.wait;await stop(f,target);release.resolve();await running;
   expect.soft(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(0);
   expect.soft((await f.fixture.db.query('SELECT state,reason,dispatch_started_at,provider_booking_uid,meeting_id FROM booking_create_submissions WHERE id=$1',[id])).rows[0]).toEqual({state:'failed',reason:target.scope==='firm'?'firm_suppressed':'handle_suppressed',dispatch_started_at:null,provider_booking_uid:null,meeting_id:null});
   expect.soft((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  }finally{release.resolve();await running;await f.fixture.stop();}
 });
 it.each(stops)('stop $scope/$channel committed after reservation prevents even availability reads',async target=>{
  const f=await setupBooking();try{
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   await stop(f,target);await f.runBooking();
   expect(f.requests).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'failed',reason:target.scope==='firm'?'firm_suppressed':'handle_suppressed',dispatchStartedAt:null});
  }finally{await f.fixture.stop();}
 });
 it('firm phone-only stop does not prohibit booking email and an unrelated handle stop does not match',async()=>{
  const f=await setupBooking();try{
   await stop(f,{scope:'firm',channel:'phone'});
   expect((await f.request('POST','/suppressions/record',f.command({scope:'handle',value:'other@booking.example',source:'prospect_opt_out',channel:'all'}))).status).toBe(200);
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);
   await f.runBooking();expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${(response.body as {result:{submissionId:string}}).result.submissionId}`)).body).toMatchObject({state:'accepted'});
  }finally{await f.fixture.stop();}
 });
 it.each(stops)('unknown accepted attempt remains inspectable after $scope/$channel stop without duplicate creation or cancellation',async target=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession();try{
   f.controls.dropResponse=true;
   const command=f.command(f.payload);
   const response=await f.request('POST','/meetings/booking-create',command);expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const job=(await claimJobs(f.fixture.db,{owner:'conserved-suppression-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   const registry=()=>registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:f.runtime});
   const run=()=>registry().get('meeting.booking_create')!.handle({session:worker,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
   await run();
   const unknown=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(unknown.body).toMatchObject({state:'unknown',dispatchStartedAt:expect.any(String),providerBookingUid:null,meetingId:null});
   const originalReceipt=(await f.fixture.db.query('SELECT result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows;
   expect(originalReceipt).toHaveLength(1);
   await stop(f,target);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toEqual(unknown.body);
   expect((await f.request('POST','/meetings/booking-create/inspect',f.command({submissionId:id}))).status).toBe(200);
   f.controls.dropResponse=false;await run();
   expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   expect(f.requests.filter(r=>r.init.method==='GET'&&new URL(r.url).pathname==='/v2/bookings')).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'booking-31',meetingId:expect.any(String)});
   expect((await f.fixture.db.query('SELECT result FROM command_receipts WHERE workspace_id=$1 AND command_id=$2',[f.fixture.alpha.workspaceId,command.commandId])).rows).toEqual(originalReceipt);
  }finally{await f.fixture.stop();}
 });
});
