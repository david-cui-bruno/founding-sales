import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import {describe,it,expect} from 'vitest';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {setupBooking} from './bookingCreate.test.ts';
type Fixture=Awaited<ReturnType<typeof setupBooking>>;
async function deleteSubject(f:Fixture,targetKind:'firm'|'contact',session=f.db){
 const preview=await f.request('POST','/retention/deletions/preview',f.command({targetKind,firmId:f.firmId,...(targetKind==='contact'?{contactId:f.contactId}:{})}),session);expect(preview.status,JSON.stringify(preview.body)).toBe(200);
 const shown=(preview.body as {result:{requestId:string;previewHash:string}}).result;
 const committed=await f.request('POST','/retention/deletions/commit',f.command({requestId:shown.requestId,previewHash:shown.previewHash}),session);expect(committed.status,JSON.stringify(committed.body)).toBe(200);
}
function gate(){let resolve=()=>{};const wait=new Promise<void>(r=>{resolve=r;});return {wait,resolve};}
function registeredWorker(f:Fixture,session:SessionQueryable,job:Awaited<ReturnType<typeof claimJobs>>[number]){return registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingCreate:f.runtime}).get('meeting.booking_create')!.handle({session,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});}

// The exported fixture also registers its original suite. Count that execution
// separately from these deletion regressions, not as additional unique evidence.
describe('accepted booking responses respect completed public subject deletion',()=>{
 it.each(['firm','contact'] as const)('public %s preview/commit during controlled provider POST cannot resurrect private attendee data',async targetKind=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession();try{
   expect((await worker.query('SELECT current_user AS role')).rows[0]).toEqual({role:'app_runtime'});
   const command=f.command(f.payload),response=await f.request('POST','/meetings/booking-create',command);expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const originalReceipt=(await f.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0];
   expect(originalReceipt).toMatchObject({result:{submissionId:id}});
   let deleted=false;
   f.controls.onHttp=async(_url,init)=>{if(init.method!=='POST')return;
    expect((await f.fixture.db.query('SELECT dispatch_started_at FROM booking_create_submissions WHERE id=$1',[id])).rows[0]?.['dispatch_started_at']).toBeInstanceOf(Date);
    await deleteSubject(f,targetKind);
    expect((await f.fixture.db.query("SELECT canonical_key FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone' AND scope='handle'",[f.fixture.alpha.workspaceId])).rows).toContainEqual({canonical_key:'prospect@booking.example'});
    deleted=true;
   };
   const job=(await claimJobs(f.fixture.db,{owner:'deleted-subject-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   const run=()=>registeredWorker(f,worker,job);
   await run();expect(deleted).toBe(true);
   const row=(await f.fixture.db.query('SELECT state,provider_booking_uid,dispatch_started_at,meeting_id,payload,provenance_state,reason FROM booking_create_submissions WHERE id=$1',[id])).rows[0];
   expect.soft(row).toMatchObject({state:'accepted',provider_booking_uid:'booking-31',dispatch_started_at:expect.any(Date),meeting_id:null,payload:{},provenance_state:'redacted',reason:expect.any(String)});
   expect.soft(row?.['payload']).toEqual({});
   expect.soft(row?.['reason']).toBe('subject_deleted');
   expect.soft((await f.fixture.db.query('SELECT attendee_email FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect.soft((await f.fixture.db.query('SELECT id FROM stage_review_items WHERE workspace_id=$1 AND evidence_kind LIKE $2',[f.fixture.alpha.workspaceId,'meeting.%'])).rows).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT full_name,status FROM contacts WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.contactId])).rows[0]).toMatchObject({status:'inactive'});
   expect((await f.fixture.db.query('SELECT id FROM email_addresses WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.attendeeRouteId])).rows).toHaveLength(0);
   await run();
   expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'accepted',sourceState:'redacted',meetingId:null,providerBookingUid:'booking-31',dispatchStartedAt:expect.any(String)});
   const receipt=(await f.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0];expect(receipt).toEqual(originalReceipt);
  }finally{await f.fixture.stop();}
 });
 it.each(['accepted','source_only','unknown_source_only'] as const)('conserves %s evidence without confusing source erasure with subject tombstones',async phase=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession();try{
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   f.controls.dropResponse=phase==='unknown_source_only';let erased=false;
   f.controls.onHttp=async(_url,init)=>{if(init.method==='POST'&&phase!=='accepted'){expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);erased=true;}};
   const job=(await claimJobs(f.fixture.db,{owner:'source-only-terminal-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   await registeredWorker(f,worker,job);
   const expectedState=phase==='unknown_source_only'?'unknown':'accepted';
   const receipt=await f.request('GET',`/meetings/booking-create?submissionId=${id}`);expect(receipt.body).toMatchObject({state:expectedState,sourceState:phase==='accepted'?'current':'redacted',dispatchStartedAt:expect.any(String),meetingId:phase==='unknown_source_only'?null:expect.any(String),providerBookingUid:phase==='unknown_source_only'?null:'booking-31'});
   expect(erased).toBe(phase!=='accepted');
   expect((await f.fixture.db.query("SELECT 1 FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone'",[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT attendee_email FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toEqual(phase==='unknown_source_only'?[]:[{attendee_email:'prospect@booking.example'}]);
   await registeredWorker(f,worker,job);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toEqual(receipt.body);
  }finally{await f.fixture.stop();}
 });
 it.each(['firm','contact'] as const)('accepted inspection during public %s deletion conserves UID without restoring a pending attendee',async targetKind=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession();try{
   f.controls.status='pending';const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const job=(await claimJobs(f.fixture.db,{owner:'deletion-inspection-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   await registeredWorker(f,worker,job);expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'pending',providerBookingUid:'booking-31',meetingId:null});
   f.controls.status='accepted';let deleted=false;f.controls.onHttp=async url=>{if(url.pathname==='/v2/bookings'){await deleteSubject(f,targetKind);deleted=true;}};
   expect((await f.request('POST','/meetings/booking-create/inspect',f.command({submissionId:id}))).status).toBe(200);
   await registeredWorker(f,worker,job);expect(deleted).toBe(true);
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'booking-31',meetingId:null,sourceState:'redacted',reason:'subject_deleted',dispatchStartedAt:expect.any(String)});
   expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
   await registeredWorker(f,worker,job);expect(f.requests.filter(r=>r.init.method==='GET'&&new URL(r.url).pathname==='/v2/bookings')).toHaveLength(1);
  }finally{await f.fixture.stop();}
 });
 it('accepted settlement waits on the actual public deletion stop-fact gate before reading or publishing private lifecycle',async()=>{
  const f=await setupBooking(),worker=await f.fixture.database.appRuntimeSession(),deleting=await f.fixture.database.appRuntimeSession();const held=gate(),release=gate();let deletingTask:Promise<unknown>|undefined,running:Promise<unknown>|undefined,paused=false;
  const deletion:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await deleting.query<Row>(text,values);if(!paused&&text==='SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'&&values?.[0]===sendGateLockName(f.fixture.alpha.workspaceId)){paused=true;held.resolve();await release.wait;}return result;}};
  try{
   const response=await f.request('POST','/meetings/booking-create',f.command(f.payload));expect(response.status).toBe(200);const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const workerPid=(await worker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,deletionPid=(await deleting.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   f.controls.onHttp=async(_url,init)=>{if(init.method==='POST'){deletingTask=deleteSubject(f,'firm',deletion);await held.wait;}};
   const job=(await claimJobs(f.fixture.db,{owner:'terminal-deletion-gate-worker',kinds:['meeting.booking_create'],limit:1,leaseSeconds:120}))[0]!;
   running=registeredWorker(f,worker,job);let observed=false;
   for(let attempt=0;attempt<400;attempt++){if((await f.fixture.db.query('SELECT 1 WHERE $2::int=ANY(pg_blocking_pids($1::int))',[workerPid,deletionPid])).rows.length){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   expect(observed,'accepted worker must actually wait on the public deletion-held advisory gate').toBe(true);
   release.resolve();await deletingTask;await running;
   expect((await f.request('GET',`/meetings/booking-create?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'booking-31',meetingId:null,sourceState:'redacted',reason:'subject_deleted'});
   expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);expect(f.requests.filter(r=>r.init.method==='POST')).toHaveLength(1);
  }finally{release.resolve();await deletingTask;await running;await f.fixture.stop();}
 });
});
