import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import type * as Advisory from '../../dial/advise.ts';
import type {SessionQueryable,QueryResultRowLike} from '../../db/queryable.ts';
import {preparedExecutionFixture} from './preparationExecutionFixture.ts';
import {reservePhoneHandoff,readPhoneHandoffResult} from '../../dial/phoneHandoff.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
// Freeze only the advisory's documented policy test clock, as reservation tests
// already do. Source, capability, transaction and final publication clocks stay
// real PostgreSQL/wall clocks. No policy switch, fixture hook or SQL lock is faked.
vi.mock('../../dial/advise.ts',async original=>{const actual=await original<typeof Advisory>();return {...actual,adviseDial:(ctx:Parameters<typeof actual.adviseDial>[0],input:Parameters<typeof actual.adviseDial>[1])=>actual.adviseDial(ctx,{...input,at:'2026-09-16T14:00:00.000Z'})};});
let f:Awaited<ReturnType<typeof preparedExecutionFixture>>;
beforeEach(async()=>{f=await preparedExecutionFixture();});afterEach(async()=>f?.stop());
it('retained handoff publication cannot use an earlier trusted clock after the final provider/advice wait crosses the unchanged source deadline',async()=>{
 const p=await f.prepared(),reserved=await f.tx(()=>reservePhoneHandoff(f.ctx(),{...f.input(p),at:new Date().toISOString(),clientVersion:'1.4.0'}));if(!reserved.ok)throw Error(reserved.reason);
 expect(await readPhoneHandoffResult(f.ctx(),reserved.value.attemptId,false)).toMatchObject({actionable:true});
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '250 milliseconds' WHERE id=$1",[p.runId]);});
 const original=(await f.runtime.query('SELECT reserved_at,expires_at FROM phone_handoff_attempts WHERE id=$1',[reserved.value.attemptId])).rows;
 const worker=await f.database.appRuntimeSession();let delayed=false;
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(sql:string,values?:readonly unknown[]){if(!delayed&&sql.includes('workspace_settings')&&values?.includes('calling_provider')){delayed=true;await expect.poll(async()=>Number((await f.runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[p.preparationId])).rows[0]?.['n'])).toBe(1);}return worker.query<Row>(sql,values);}};
 expect(await readPhoneHandoffResult(f.ctx(wrapped),reserved.value.attemptId,false)).toMatchObject({actionable:false,e164:null,telUri:null});expect(delayed).toBe(true);
 expect((await f.runtime.query('SELECT reserved_at,expires_at FROM phone_handoff_attempts WHERE id=$1',[reserved.value.attemptId])).rows).toEqual(original);
});
