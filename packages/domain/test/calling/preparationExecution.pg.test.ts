import {afterEach,beforeEach,expect,it} from 'vitest';
import {preparedExecutionFixture} from './preparationExecutionFixture.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
import {consumeCallSession,recordCallStatus,readCallCadence} from '../../calls/sessions.ts';
import {consumeDialTicket} from '../../dial/tickets.ts';
import {readCallSessionClearance} from '../../calls/sessionClearance.ts';
import {reservePhoneHandoff,readPhoneHandoffResult} from '../../dial/phoneHandoff.ts';
let f:Awaited<ReturnType<typeof preparedExecutionFixture>>;
beforeEach(async()=>{f=await preparedExecutionFixture();});afterEach(async()=>f?.stop());
async function erase(id:string){await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("SELECT erase_calling_preparation($1,$2,'source_deleted')",[f.seed.alpha.workspaceId,id]);});}
it('actual ticket/session issue retains exact source marker and clips original capability lifetime; erasure clears bytes without destroying opaque provider/accounting identities',async()=>{
 const p=await f.prepared(),session=await f.session(p);expect(session).toMatchObject({ok:true});if(!session.ok)throw Error(session.reason);
 const before=(await f.runtime.query<{ticket_id:string;reservation_id:string;expires_at:Date}>('SELECT ticket_id,reservation_id,expires_at FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows[0]!;
 expect((await f.runtime.query('SELECT calling_preparation_id,e164 FROM dial_tickets WHERE id=$1',[before.ticket_id])).rows).toEqual([{calling_preparation_id:p.preparationId,e164:p.phone}]);
 await expect(f.tx(()=>f.runtime.query('UPDATE dial_tickets SET calling_preparation_erased_at=clock_timestamp() WHERE id=$1',[before.ticket_id]))).rejects.toMatchObject({code:'23514'});
 await erase(p.preparationId);
 expect((await f.runtime.query('SELECT e164,firm_time_zone,consumed_at FROM dial_tickets WHERE id=$1',[before.ticket_id])).rows).toEqual([{e164:null,firm_time_zone:null,consumed_at:null}]);
 expect((await f.runtime.query('SELECT ticket_id,reservation_id,expires_at FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows).toEqual([before]);
 expect((await f.runtime.query('SELECT state FROM provider_reservations WHERE id=$1',[before.reservation_id])).rows).toEqual([{state:'reserved'}]);
 expect(await f.tx(()=>readCallSessionClearance(f.ctx(),session.value.sessionId))).toMatchObject({ok:false});
 expect(await f.tx(()=>consumeCallSession(f.runtime,{workspaceId:f.seed.alpha.workspaceId,sessionId:session.value.sessionId,callSid:'CA'+'1'.repeat(32),identity:`client:${f.seed.alpha.admin.userId}`,at:f.policy.insideWindow}))).toMatchObject({ok:false});
 expect((await f.runtime.query('SELECT consumed_at,twilio_call_sid FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows).toEqual([{consumed_at:null,twilio_call_sid:null}]);
 await expect(f.tx(()=>f.runtime.query('UPDATE dial_tickets SET e164=$2,firm_time_zone=$3 WHERE id=$1',[before.ticket_id,p.phone,'America/New_York']))).rejects.toMatchObject({code:'23514'});
});
it('consumed provider/UNKNOWN and cadence survive source erasure; signed status reconciliation still settles the original attempt',async()=>{
 const p=await f.prepared(),session=await f.session(p);if(!session.ok)throw Error(session.reason);
 const sid='CA'+'2'.repeat(32),consumed=await f.tx(()=>consumeCallSession(f.runtime,{workspaceId:f.seed.alpha.workspaceId,sessionId:session.value.sessionId,callSid:sid,identity:`client:${f.seed.alpha.admin.userId}`,at:f.policy.insideWindow}));expect(consumed).toMatchObject({ok:true});
 const identity=(await f.runtime.query('SELECT ticket_id,reservation_id,twilio_call_sid,consumed_at FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows;
 const cadence=await readCallCadence(f.ctx(),p.firmId,new Date().toISOString());
 await erase(p.preparationId);
 expect((await f.runtime.query('SELECT ticket_id,reservation_id,twilio_call_sid,consumed_at FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows).toEqual(identity);
 expect((await f.runtime.query('SELECT state FROM provider_reservations WHERE subject_id=$1',[session.value.sessionId])).rows).toEqual([{state:'calling'}]);
 // Erasing the source-owned zone removes zone-based advisory timing, while
 // the opaque attempt count, identity and park state remain unchanged.
 expect(await readCallCadence(f.ctx(),p.firmId,new Date().toISOString())).toMatchObject({unansweredAttempts:cadence.unansweredAttempts,nextAttempt:cadence.nextAttempt,lastAttemptSessionId:cadence.lastAttemptSessionId,parked:cadence.parked,parkingHoldId:cadence.parkingHoldId});
 expect(await f.tx(()=>recordCallStatus(f.runtime,{callSid:sid,providerStatus:'completed',durationSeconds:20,priceDollars:-0.02}))).toMatchObject({known:true});
 expect((await f.runtime.query('SELECT status FROM call_sessions WHERE id=$1',[session.value.sessionId])).rows).toEqual([{status:'completed'}]);
});
it('frozen phone handoff marker is exact, source loss clears every owned binding and keeps its cadence tombstone',async()=>{
 const p=await f.prepared(true),result=await f.tx(()=>reservePhoneHandoff(f.ctx(),{...f.input(p),clientVersion:'1.4.0'}));if(!result.ok)throw Error(result.reason);
 const id=result.value.attemptId,identity=(await f.runtime.query('SELECT id,firm_id,command_id,actor_user_id,device_id,reserved_at,expires_at,calling_preparation_id FROM phone_handoff_attempts WHERE id=$1',[id])).rows;
 await expect(f.tx(()=>f.runtime.query('UPDATE phone_handoff_attempts SET erased_at=clock_timestamp() WHERE id=$1',[id]))).rejects.toMatchObject({code:'23514'});
 await erase(p.preparationId);
 expect((await f.runtime.query('SELECT id,firm_id,command_id,actor_user_id,device_id,reserved_at,expires_at,calling_preparation_id FROM phone_handoff_attempts WHERE id=$1',[id])).rows).toEqual(identity);
 expect((await f.runtime.query('SELECT e164,phone_route_id,route_version,contact_id,opportunity_id,item_id,registry_snapshot_id,registry_scrubbed_at,call_log_id FROM phone_handoff_attempts WHERE id=$1',[id])).rows).toEqual([{e164:null,phone_route_id:null,route_version:null,contact_id:null,opportunity_id:null,item_id:null,registry_snapshot_id:null,registry_scrubbed_at:null,call_log_id:null}]);
 expect(await readPhoneHandoffResult(f.ctx(),id,false)).toMatchObject({actionable:false,telUri:null});
 await expect(f.tx(()=>f.runtime.query('UPDATE phone_handoff_attempts SET e164=$2 WHERE id=$1',[id,p.phone]))).rejects.toMatchObject({code:'23514'});
});
it('already-expired original source refuses ticket consumption and never mints replacement capabilities',async()=>{
 const p=await f.prepared();
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",[p.runId]);});
 const issued=await f.ticket(p);expect(issued).toMatchObject({ok:true});if(!issued.ok)throw Error(issued.reason);
 const deadline=(await f.runtime.query<{source_expires_at:Date}>('SELECT source_expires_at FROM calling_preparations WHERE id=$1',[p.preparationId])).rows[0]!.source_expires_at;
 expect(Date.parse(issued.value.expiresAt)).toBeLessThanOrEqual(deadline.getTime());
 await expect.poll(()=>Date.now()>deadline.getTime()).toBe(true);
 expect(await f.tx(()=>consumeDialTicket(f.ctx(),{ticketId:issued.value.ticketId,deviceId:f.seed.alpha.admin.deviceId,at:f.policy.insideWindow}))).toMatchObject({ok:false});
 expect(await f.ticket(p)).toMatchObject({ok:false});
 expect((await f.runtime.query('SELECT count(*)::int n FROM dial_tickets WHERE firm_id=$1',[p.firmId])).rows).toEqual([{n:1}]);
});
