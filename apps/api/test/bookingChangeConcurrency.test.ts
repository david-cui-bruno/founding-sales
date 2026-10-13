import {describe,it,expect,vi} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
const idOf=(body:unknown)=>(body as {result:{submissionId:string}}).result.submissionId;
describe('booking change durable concurrency and terminal waits',()=>{
 it('two ordinary concurrent attendee requests for one appointment reserve one action, not two writes',async()=>{
  const f=await setupBookingChange();try{
   const second=await f.fixture.database.appRuntimeSession(),other=await f.capture('Please cancel our appointment, confirming the earlier request.');
   const responses=await Promise.all([f.request('POST','/meetings/booking-change',f.command(f.payload)),f.request('POST','/meetings/booking-change',f.command({...f.payload,agreement:other}),second)]);
   expect(responses.map(r=>r.status).sort()).toEqual([200,409]);expect(responses.find(r=>r.status===409)?.body).toMatchObject({reason:'booking_change_in_progress'});
   await f.run();expect(f.writes).toHaveLength(1);
  }finally{await f.stop();}
 });
 it('a source-backed repeated command before dispatch returns the same durable action identity',async()=>{
  const f=await setupBookingChange();try{const first=await f.request('POST','/meetings/booking-change',f.command(f.payload)),second=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(first.status).toBe(200);expect(idOf(second.body)).toBe(idOf(first.body));await f.run();expect(f.writes).toHaveLength(1);}finally{await f.stop();}
 });
 it('durable accepted dispatch and redaction barriers cannot be reset by receipt updates',async()=>{
  const f=await setupBookingChange();try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload)),id=idOf(response.body);await f.run();
   for(const mutation of ["dispatch_started_at=NULL","state='pending'"]){await expect(f.db.query(`UPDATE booking_change_submissions SET ${mutation} WHERE workspace_id=$1 AND id=$2`,[f.fixture.alpha.workspaceId,id])).rejects.toMatchObject({code:'23514',constraint:'booking_change_marker_irreversible'});}
   expect((await f.request('POST','/crm/business/mail/delete',f.command({sourceId:f.payload.agreement.sourceId,expectedRevision:1}))).status).toBe(200);
   await expect(f.db.query("UPDATE booking_change_submissions SET provenance_state='current',payload=$3,source_fingerprint=$4,target_fingerprint=$4 WHERE workspace_id=$1 AND id=$2",[f.fixture.alpha.workspaceId,id,JSON.stringify(f.payload),'a'.repeat(64)])).rejects.toMatchObject({code:'23514',constraint:'booking_change_marker_irreversible'});
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',sourceState:'redacted',dispatchStartedAt:expect.any(String)});
  }finally{await f.stop();}
 });
 it.each(['initial','dispatch','inspection'] as const)('canonical account access is reread after the final cost await before %s provider work',async phase=>{
  const f=await setupBookingChange();try{
   const admitted=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(admitted.status).toBe(200);const id=idOf(admitted.body);
   if(phase==='inspection'){f.controls.dropResponse=true;await f.run();await f.request('POST','/meetings/booking-change/inspect',f.command({submissionId:id}));}
   let afterReads=phase!=='dispatch',accountAccess=true,targetReads=0;
   const evidence=f.runtime.policy.readEvidence,cost=f.runtime.readCostContract;
   f.runtime.policy.readEvidence=async(context,binding)=>{const result=await evidence(context,binding);return result===null?null:{...result,accountAccess};};
   f.runtime.readCostContract=async snapshot=>{const result=await cost(snapshot);if(afterReads){await Promise.resolve();accountAccess=false;}return result;};
   f.controls.targetWait=async()=>{targetReads++;afterReads=true;};
   await f.run();expect(f.writes).toHaveLength(phase==='inspection'?1:0);expect(f.inspections).toHaveLength(0);expect(targetReads).toBe(phase==='dispatch'?1:0);
  }finally{await f.stop();}
 });
 it.each(['evidence_expiry','lease_expiry','target_expiry','invalid_clock'] as const)('a real receipt-row wait rechecks %s at the last provider-write marker',async expiry=>{
  const f=await setupBookingChange();const blocker=await f.fixture.database.appRuntimeSession();let locked=false;let running:Promise<unknown>|undefined;
  try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));const id=idOf(response.body);
   const pid=Number((await f.fixture.db.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid),blockerPid=Number((await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid);
   let leaseExpires:string|null=null;
   f.controls.targetWait=async()=>{
    if(expiry==='lease_expiry')leaseExpires=(await f.fixture.db.query<{expires:string}>("UPDATE jobs SET lease_expires_at=clock_timestamp()+interval '250 milliseconds' WHERE workspace_id=$1 AND kind='meeting.booking_change' AND state='running' RETURNING lease_expires_at::text AS expires",[f.fixture.alpha.workspaceId])).rows[0]!.expires;
    await blocker.query('BEGIN');locked=true;await blocker.query('SELECT id FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[f.fixture.alpha.workspaceId,id]);
   };
   running=f.run();void running.catch(()=>undefined);
   await vi.waitFor(async()=>{expect((await f.db.query<{blockers:number[]}>('SELECT pg_blocking_pids($1) AS blockers',[pid])).rows[0]?.blockers).toContain(blockerPid);},{timeout:5000,interval:10});
   if(expiry==='evidence_expiry')f.setClock('2026-10-14T20:00:00Z');
   else if(expiry==='target_expiry')f.setClock('2026-10-14T14:01:00Z');
   else if(expiry==='invalid_clock')f.setClock('not-an-instant');
   else await vi.waitFor(async()=>{expect((await f.db.query<{expired:boolean}>('SELECT clock_timestamp()>$1::timestamptz AS expired',[leaseExpires])).rows[0]?.expired).toBe(true);},{timeout:5000,interval:10});
   await blocker.query('COMMIT');locked=false;await running;
   expect(f.writes).toHaveLength(0);expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({dispatchStartedAt:null});
  }finally{if(locked)await blocker.query('ROLLBACK');await running?.catch(()=>undefined);await f.stop();}
 });
});
