import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type * as Advisory from '../../dial/advise.ts';
import type {SessionQueryable,QueryResultRowLike} from '../../db/queryable.ts';
import {preparedExecutionFixture} from './preparationExecutionFixture.ts';
import {readPhoneHandoffResult} from '../../dial/phoneHandoff.ts';
import {readPhoneRegistryDecision} from '../../dial/registryCoverage.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
// Freeze only the advisory's documented policy test clock. This publication test
// starts from a native live-clock capability; reservation policy/window bounds
// have their own coverage in test/dial/phoneHandoff.test.ts. Source, capability,
// transaction and final publication clocks and all SQL constraints stay real.
vi.mock('../../dial/advise.ts',async original=>{const actual=await original<typeof Advisory>();return {...actual,adviseDial:(ctx:Parameters<typeof actual.adviseDial>[0],input:Parameters<typeof actual.adviseDial>[1])=>actual.adviseDial(ctx,{...input,at:'2026-09-16T14:00:00.000Z'})};});
let f:Awaited<ReturnType<typeof preparedExecutionFixture>>;
beforeEach(async()=>{f=await preparedExecutionFixture();});afterEach(async()=>f?.stop());
async function livePublicationAttempt(p:Awaited<ReturnType<typeof f.prepared>>){
 return f.tx(async()=>{
  await lockPreparationCleanup(f.ctx());
  const registry=await readPhoneRegistryDecision(f.ctx(),p.phone);if(!registry.ok)throw Error(registry.reason);
  const {commandId,deviceId}=f.input(p);
  const row=(await f.runtime.query<{id:string}>(`WITH tick AS MATERIALIZED(SELECT clock_timestamp() at)
   INSERT INTO phone_handoff_attempts(workspace_id,firm_id,actor_user_id,device_id,command_id,phone_route_id,route_version,e164,
    registry_snapshot_id,registry_scrubbed_at,reserved_at,expires_at,calling_preparation_id)
   SELECT p.workspace_id,p.firm_ref,$3,$4,$5,r.id,r.version,r.e164,$6,$7,t.at,
    LEAST(t.at+interval '15 seconds',p.source_expires_at,$8::timestamptz),p.id
   FROM tick t CROSS JOIN calling_preparations p
   JOIN phone_routes r ON r.workspace_id=p.workspace_id AND r.id=p.route_ref AND r.firm_id=p.firm_ref AND r.version=p.route_version
   JOIN devices d ON d.workspace_id=p.workspace_id AND d.id=$4 AND d.user_id=$3 AND d.status='active'
   WHERE p.workspace_id=$1 AND p.id=$2 AND p.firm_ref=$9 AND p.route_ref=$10 AND p.discovery_run_ref=$11
    AND p.state='live' AND r.version=1 RETURNING id`,
  [f.seed.alpha.workspaceId,p.preparationId,f.seed.alpha.admin.userId,deviceId,commandId,registry.snapshotId,registry.scrubbedAt,registry.freshUntil,p.firmId,p.routeId,p.runId])).rows[0];
  if(!row)throw Error('native publication capability binding missing');
  return row.id;
 });
}
it('retained handoff publication cannot use an earlier trusted clock after the final provider/advice wait crosses the unchanged source deadline',async()=>{
 const p=await f.prepared(),attemptId=await livePublicationAttempt(p);
 expect(await readPhoneHandoffResult(f.ctx(),attemptId,false)).toMatchObject({actionable:true,validForMilliseconds:15000});
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[p.runId]);});
 const original=(await f.runtime.query('SELECT reserved_at,expires_at FROM phone_handoff_attempts WHERE id=$1',[attemptId])).rows;
 const worker=await f.database.appRuntimeSession();let delayed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){if(!delayed&&sql.includes('workspace_settings')&&values?.includes('calling_provider')){delayed=true;await expect.poll(async()=>Number((await f.runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[p.preparationId])).rows[0]?.['n'])).toBe(1);}return worker.query<Row>(sql,values);}};
 expect(await readPhoneHandoffResult(f.ctx(wrapped),attemptId,false)).toMatchObject({actionable:false,e164:null,telUri:null});expect(delayed).toBe(true);
 expect((await f.runtime.query('SELECT reserved_at,expires_at FROM phone_handoff_attempts WHERE id=$1',[attemptId])).rows).toEqual(original);
});
