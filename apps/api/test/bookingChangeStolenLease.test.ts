import {describe,it,expect} from 'vitest';
import {setupBookingChange} from './support/bookingChangeFixture.ts';
import {HandlerRegistry} from '@fss/domain/jobs/handlerRegistry.ts';
import {runTwiceUnderStolenLease} from '@fss/domain/jobs/atLeastOnce.ts';
import {jobIdempotencyKey} from '@fss/domain/jobs/jobKinds.ts';
import {registerHandlers} from '../../worker/src/bootstrap/main.ts';
import {runClaimedJob} from '../../worker/src/runner/jobRunner.ts';

describe('registered booking change stolen-lease protection',()=>{
 it('a reclaimed fresh owner completes once and the paused stale owner cannot call or settle again',async()=>{
  const f=await setupBookingChange();try{
   const response=await f.request('POST','/meetings/booking-change',f.command(f.payload));expect(response.status).toBe(200);
   const id=(response.body as {result:{submissionId:string}}).result.submissionId;
   const registry=registerHandlers(new HandlerRegistry(),{classifier:undefined,mail:undefined,send:undefined,research:undefined,bookingChange:f.runtime});
   const report=await runTwiceUnderStolenLease({session:f.fixture.db,registry,run:runClaimedJob,workspaceId:f.fixture.alpha.workspaceId,kind:'meeting.booking_change',idempotencyKey:jobIdempotencyKey.bookingChange(id),payload:{submissionId:id},countEffects:async()=>Number((await f.db.query<{count:string}>("SELECT count(*) FROM booking_change_submissions WHERE workspace_id=$1 AND id=$2 AND state='accepted'",[f.fixture.alpha.workspaceId,id])).rows[0]!.count)});
   expect(report).toMatchObject({kind:'meeting.booking_change',effectsBefore:0,effectsAfter:1,freshOutcome:'completed',staleOutcome:'lease_lost'});
   expect(BigInt(report.freshFencingToken)).toBeGreaterThan(BigInt(report.staleFencingToken));
   expect(f.writes).toHaveLength(1);expect(f.inspections).toHaveLength(0);
   expect((await f.request('GET',`/meetings/booking-change?submissionId=${id}`)).body).toMatchObject({state:'accepted',providerBookingUid:'external-supported',reminderState:'stopped',dispatchStartedAt:expect.any(String)});
   expect((await f.request('GET',`/meetings/firm?firmId=${f.firmId}`)).body).toMatchObject({meetings:[{meetingId:f.meetingId,state:'cancelled'}]});
   expect((await f.db.query<{state:string;fencing_token:string}>("SELECT state,fencing_token::text FROM jobs WHERE workspace_id=$1 AND kind='meeting.booking_change' AND idempotency_key=$2",[f.fixture.alpha.workspaceId,jobIdempotencyKey.bookingChange(id)])).rows).toEqual([{state:'done',fencing_token:report.freshFencingToken}]);
  }finally{await f.stop();}
 });
});
