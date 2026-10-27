import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createOutboundWorld,type OutboundWorld} from '../../../packages/domain/test/outbound/support/outboundWorld.ts';
import {routineReplyFixture} from '../../../packages/domain/test/outreach/routineFixture.ts';
import {outreachReplySource} from '../src/handlers/outreach.ts';
import {runSchedulerPass} from '../src/scheduler/schedulerPass.ts';
let world:OutboundWorld;
interface RetainedReservation extends Record<string,unknown>{state:string;settled_cents:number;settled_at:Date|null}
beforeAll(async()=>{world=await createOutboundWorld();});
afterAll(async()=>world.stop());
it('settles more than one retained expiry batch across ordinary scheduler passes without activation or repeat settlement',async()=>{
 const f=await routineReplyFixture(world),db=world.database.session,w=f.ctx.scope.workspaceId;
 const createdAt='2026-10-25T12:00:00.000Z',firstPass='2026-10-27T05:00:00.000Z',secondPass='2026-10-27T05:01:00.000Z';
 // Direct pre-retirement history, not current request creation or model authorization.
 await db.query("UPDATE outreach_reply_requests SET state='calling',created_at=$2,deadline_at=$3 WHERE id=$1",[f.requestId,createdAt,'2026-10-25T12:30:00.000Z']);
 for(let index=0;index<102;index++){
  const requestId=index===0?f.requestId:randomUUID();
  const state=index%2===0?'calling':'reserved';
  if(index>0)await db.query("INSERT INTO outreach_reply_requests(workspace_id,id,plan_id,original_message_id,source_hash,prompt_version,model_name,state,created_at,deadline_at) VALUES($1,$2,$3,$4,$5,'retained-fixture','claude-haiku-4-5',$6,$7,$8)",[w,requestId,f.plan,randomUUID(),'a'.repeat(64),state==='calling'?'calling':'queued',createdAt,new Date(Date.parse('2026-10-25T12:30:00Z')+index*1000).toISOString()]);
  await db.query("INSERT INTO provider_reservations(workspace_id,subject_kind,subject_id,provider_key,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,state,created_at) VALUES($1,'outreach_reply',$2,'aws_bedrock.outreach_reply',1,'2026-10-25','America/New_York',2,'claude-haiku-4-5',100,1024,$3,$4)",[w,requestId,state,createdAt]);
 }
 const reservations=()=>db.query<RetainedReservation>("SELECT id,subject_id,attempt,business_date::text,business_time_zone,cents,created_at,state,settled_cents,settled_at FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='outreach_reply' ORDER BY id",[w]);
 const original=(await reservations()).rows;
 const immutable=({state:_state,settled_cents:_cents,settled_at:_at,...row}:Record<string,unknown>)=>row;
 const jobs=(await db.query('SELECT id FROM jobs ORDER BY id')).rows;
 const outbound=(await db.query('SELECT id,state,attempt_token FROM outbound_messages ORDER BY id')).rows;
 expect((await db.query("SELECT id FROM outbound_messages WHERE state='sent'")).rows).toHaveLength(0);
 expect((await db.query("SELECT mail_message_id FROM mail_message_classifications WHERE layer='deterministic' AND class='human' UNION ALL SELECT mail_message_id FROM mail_reply_confirmations")).rows).toHaveLength(0);
 const pass=async(now:string)=>expect(await runSchedulerPass(db,{sources:[outreachReplySource()],now})).toMatchObject({outcome:'ran',inserted:0,alreadyPresent:0,externalActions:0});
 await pass(firstPass);
 const first=(await reservations()).rows;
 expect(first.filter(row=>row.state==='estimated'||row.state==='released')).toHaveLength(100);
 expect(first.filter(row=>row.state==='calling'||row.state==='reserved')).toHaveLength(2);
 expect((await db.query('SELECT DISTINCT state FROM outreach_reply_requests WHERE workspace_id=$1',[w])).rows).toEqual([{state:'expired'}]);
 await pass(secondPass);
 const settled=(await reservations()).rows;
 expect(settled.filter(row=>row.state==='calling'||row.state==='reserved')).toHaveLength(0);
 expect(settled.map(immutable)).toEqual(original.map(immutable));
 for(const [index,row] of settled.entries()){
  expect(row.state).toBe(original[index]!.state==='calling'?'estimated':'released');
  expect(row.settled_cents).toBe(original[index]!.state==='calling'?2:0);
  expect((row.settled_at as Date).toISOString()).toBe(first[index]!.settled_at===null?secondPass:firstPass);
 }
 const ledger=(await db.query('SELECT business_date::text,business_time_zone,cost_cents FROM provider_ledger WHERE workspace_id=$1 AND provider_key=$2',[w,'aws_bedrock.outreach_reply'])).rows;
 expect(ledger).toEqual([{business_date:'2026-10-25',business_time_zone:'America/New_York',cost_cents:102}]);
 await pass('2026-10-27T05:02:00.000Z');
 expect((await reservations()).rows).toEqual(settled);
 expect((await db.query('SELECT business_date::text,business_time_zone,cost_cents FROM provider_ledger WHERE workspace_id=$1 AND provider_key=$2',[w,'aws_bedrock.outreach_reply'])).rows).toEqual(ledger);
 expect((await db.query('SELECT id FROM jobs ORDER BY id')).rows).toEqual(jobs);
 expect((await db.query('SELECT id,state,attempt_token FROM outbound_messages ORDER BY id')).rows).toEqual(outbound);
 expect((await db.query('SELECT count(*)::int AS count FROM outreach_reply_requests WHERE workspace_id=$1',[w])).rows).toEqual([{count:102}]);
});
