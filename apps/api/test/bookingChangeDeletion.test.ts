import {describe,it,expect} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {sendGateLockName} from '@fss/domain/policy/sendGate.ts';
import {claimJobs} from '@fss/domain/jobs/jobStore.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
type Fixture=Awaited<ReturnType<typeof setupBookingChange>>;
async function payloadFor(f:Fixture,action:'cancel'|'reschedule'){
 if(action==='cancel')return f.payload;
 const agreement=await f.capture('Please move our existing appointment to Thursday October 15, 2026 at 11 AM America/New_York.');
 return {...f.payload,action,agreement,confirmation:'owner_confirmed_attendee_unconditional_exact_slot' as const,agreedSlot:{startsAt:'2026-10-15T15:00:00Z',timeZone:'America/New_York'}};
}
async function deleteSubject(f:Fixture,targetKind:'firm'|'contact',session=f.db){
 const preview=await f.request('POST','/retention/deletions/preview',f.command({targetKind,firmId:f.firmId,...(targetKind==='contact'?{contactId:f.contactId}:{})}),session);expect(preview.status,JSON.stringify(preview.body)).toBe(200);
 const shown=(preview.body as {result:{requestId:string;previewHash:string}}).result;
 const committed=await f.request('POST','/retention/deletions/commit',f.command({requestId:shown.requestId,previewHash:shown.previewHash}),session);expect(committed.status,JSON.stringify(committed.body)).toBe(200);
}
function gate(){let resolve=()=>{};const wait=new Promise<void>(r=>{resolve=r;});return {wait,resolve};}
const receiptId=(body:unknown)=>(body as {result:{submissionId:string}}).result.submissionId;
describe('booking change settlement across public deletion during controlled provider POST',()=>{
 it.each([['firm','cancel'],['firm','reschedule'],['contact','cancel'],['contact','reschedule']] as const)('%s deletion during %s conserves accepted opaque facts without restoring private projections',async(targetKind,action)=>{
  const f=await setupBookingChange();try{
   const payload=await payloadFor(f,action),command=f.command(payload),response=await f.request('POST','/meetings/booking-change',command);expect(response.status,JSON.stringify(response.body)).toBe(200);const id=receiptId(response.body);
   const originalReceipt=(await f.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0];
   let deleted=false;
   f.controls.changeWait=async()=>{
    expect(f.writes).toHaveLength(1);
    expect((await f.fixture.db.query('SELECT dispatch_started_at FROM booking_change_submissions WHERE id=$1',[id])).rows[0]?.['dispatch_started_at']).toBeInstanceOf(Date);
    await deleteSubject(f,targetKind);deleted=true;
    expect((await f.fixture.db.query("SELECT canonical_key FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone' AND scope='handle'",[f.fixture.alpha.workspaceId])).rows).toContainEqual({canonical_key:'prospect@booking.example'});
    expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
    expect((await f.fixture.db.query('SELECT booking_uid FROM meeting_booking_uids WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   };
   await f.run();expect(deleted).toBe(true);
   const uid=action==='cancel'?'external-supported':`replacement-${id}`;
   expect.soft((await f.fixture.db.query('SELECT state,action,target_booking_uid,provider_booking_uid,dispatch_started_at,meeting_id,payload,source_fingerprint,target_fingerprint,provenance_state FROM booking_change_submissions WHERE id=$1',[id])).rows[0]).toMatchObject({state:'accepted',action,target_booking_uid:'external-supported',provider_booking_uid:uid,dispatch_started_at:expect.any(Date),meeting_id:null,payload:{},source_fingerprint:'0'.repeat(64),target_fingerprint:'0'.repeat(64),provenance_state:'redacted'});
   expect.soft((await f.fixture.db.query('SELECT attendee_email FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect.soft((await f.fixture.db.query('SELECT booking_uid FROM meeting_booking_uids WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect.soft((await f.fixture.db.query("SELECT id FROM stage_review_items WHERE workspace_id=$1 AND evidence_kind LIKE 'meeting.%'",[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',action,meetingId:null,sourceState:'redacted',providerBookingUid:uid,dispatchStartedAt:expect.any(String),reminderState:action==='cancel'?'stopped':'replaced'});
   await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT result FROM command_receipts WHERE command_id=$1',[command.commandId])).rows[0]).toEqual(originalReceipt);
  }finally{await f.stop();}
 });
 it.each(['cancel','reschedule'] as const)('source-only deletion still folds accepted %s lifecycle and preserves unknown attendance',async action=>{
  const f=await setupBookingChange();try{
   const payload=await payloadFor(f,action),response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status).toBe(200);const id=receiptId(response.body);
   f.controls.changeWait=async()=>{expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);};
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',sourceState:'redacted',meetingId:f.meetingId,reminderState:action==='cancel'?'stopped':'replaced'});
   expect((await f.fixture.db.query('SELECT state,attendee_email,attendance_source FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.meetingId])).rows[0]).toEqual({state:action==='cancel'?'cancelled':'rescheduled',attendee_email:'prospect@booking.example',attendance_source:null});
   expect((await f.fixture.db.query("SELECT 1 FROM suppression_events WHERE workspace_id=$1 AND source='deletion_tombstone'",[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);
  }finally{await f.stop();}
 });
 it('unknown acceptance during source deletion is conserved without inspection or replay',async()=>{
  const f=await setupBookingChange();try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(response.status).toBe(200);const id=receiptId(response.body);f.controls.dropResponse=true;
   f.controls.changeWait=async()=>{expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);};
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'unknown',sourceState:'redacted',dispatchStartedAt:expect.any(String),providerBookingUid:null});
   await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));await f.run();expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(0);
   expect((await f.fixture.db.query('SELECT state,attendance_source FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.meetingId])).rows[0]).toEqual({state:'booked',attendance_source:null});
  }finally{await f.stop();}
 });
 it.each(['cancel','reschedule'] as const)('source-only erasure during accepted %s preserves a concurrent public human attendance correction',async action=>{
  const f=await setupBookingChange();try{
   const payload=await payloadFor(f,action),response=await f.request('POST','/meetings/booking-change',f.command(payload));expect(response.status).toBe(200);const id=receiptId(response.body);
   f.controls.changeWait=async()=>{
    await f.callback('external-supported','BOOKING_RESCHEDULED','2026-10-13T14:00:00Z','2026-10-13T17:00:30Z');
    expect((await f.request('POST','/meetings/attendance',f.command({meetingId:f.meetingId,attendance:'attended'}))).status).toBe(200);
    expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);
   };
   await f.run();expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',sourceState:'redacted',meetingId:f.meetingId});
   expect((await f.fixture.db.query('SELECT state,attendance_source,attendance_confirmed_by FROM meetings WHERE workspace_id=$1 AND id=$2',[f.fixture.alpha.workspaceId,f.meetingId])).rows[0]).toEqual({state:'held',attendance_source:'manual',attendance_confirmed_by:f.fixture.alpha.admin.userId});
   expect(f.writes).toHaveLength(1);
  }finally{await f.stop();}
 });
 it('accepted settlement actually waits for the public deletion-held stop-fact gate before private publication',async()=>{
  const f=await setupBookingChange(),worker=await f.fixture.database.appRuntimeSession(),deleting=await f.fixture.database.appRuntimeSession(),held=gate(),release=gate();let paused=false,deletingTask:Promise<unknown>|undefined,running:Promise<unknown>|undefined;
  const deletion:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{const result=await deleting.query<Row>(text,values);if(!paused&&text==='SELECT pg_advisory_xact_lock(hashtextextended($1, 0))'&&values?.[0]===sendGateLockName(f.fixture.alpha.workspaceId)){paused=true;held.resolve();await release.wait;}return result;}};
  try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(response.status).toBe(200);const id=receiptId(response.body);
   const workerPid=(await worker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid,deletionPid=(await deleting.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   f.controls.changeWait=async()=>{deletingTask=deleteSubject(f,'firm',deletion);await held.wait;};
   const job=(await claimJobs(f.fixture.db,{owner:'booking-change-deletion-gate-worker',kinds:['meeting.booking_change'],limit:1,leaseSeconds:120}))[0]!;
   running=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingChange:f.runtime}).get('meeting.booking_change')!.handle({session:worker,scope:workspaceScope(f.fixture.alpha.workspaceId,{kind:'system',component:'worker'}),job});
   let observed=false;
   for(let attempt=0;attempt<400;attempt++){if((await f.fixture.db.query('SELECT 1 WHERE $2::int=ANY(pg_blocking_pids($1::int))',[workerPid,deletionPid])).rows.length){observed=true;break;}await new Promise(resolve=>setTimeout(resolve,5));}
   expect(observed,'settlement must actually wait on the public deletion-held gate').toBe(true);
   release.resolve();await deletingTask;await running;
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'external-supported',meetingId:null,sourceState:'redacted',reason:'subject_deleted'});
   expect((await f.fixture.db.query('SELECT id FROM meetings WHERE workspace_id=$1',[f.fixture.alpha.workspaceId])).rows).toHaveLength(0);expect(f.writes).toHaveLength(1);
  }finally{release.resolve();await deletingTask;await running;await f.stop();}
 });
});
