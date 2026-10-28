import {afterEach,beforeEach,expect,it} from 'vitest';
import type {SessionQueryable,QueryResultRowLike} from '../../db/queryable.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {preparedExecutionFixture} from './preparationExecutionFixture.ts';
import {changeCallingProvider} from '../../calling/setup.ts';
import {changePreparedCallingMemberAuthority} from '../../calling/preparationMaintenance.ts';
import {confirmCallingPreparation} from '../../calling/preparation.ts';
import {lockPreparationCleanup} from '../../calling/preparationLifecycle.ts';
import {createCallSession,consumeCallSession} from '../../calls/sessions.ts';
import {sendGateLockName} from '../../policy/sendGate.ts';
let f:Awaited<ReturnType<typeof preparedExecutionFixture>>;
beforeEach(async()=>{f=await preparedExecutionFixture();});afterEach(async()=>f?.stop());
function deferred(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
async function waiting(session:SessionQueryable){const pid=(await session.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;return ()=>expect.poll(async()=>Number((await f.database.session.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",[pid])).rows[0]?.['n']),{timeout:3000}).toBe(1);}
it.each(['issue','consume'] as const)('actual owner OFF gate wait crossing source expiry refuses %s without money/call effects or gate upgrade',async kind=>{
 const p=await f.prepared(),session=kind==='consume'?await f.session(p):null;
 if(session&&!session.ok)throw Error(session.reason);
 await f.tx(async()=>{await lockPreparationCleanup(f.ctx());await f.runtime.query("UPDATE sourcing_prospect_phone_discoveries SET expires_at=clock_timestamp()+interval '300 milliseconds' WHERE id=$1",[p.runId]);});
 const blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),wait=await waiting(worker),held=deferred(),release=deferred(),gateModes:string[]=[];
 const wrapped:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(text:string,values?:readonly unknown[]){if(values?.[0]===sendGateLockName(f.seed.alpha.workspaceId)&&text.includes('pg_advisory_xact_lock'))gateModes.push(text);return worker.query<Row>(text,values);}};
 const off=withTransaction(blocker,async()=>{expect(await changeCallingProvider(f.ctx(blocker),{expectedVersion:0,provider:'tel'},false,async()=>true)).toMatchObject({ok:true});held.resolve();await release.promise;});
 await held.promise;
 const work=withTransaction<unknown>(wrapped,async()=>kind==='issue'?createCallSession(f.ctx(wrapped),{...f.input(p),configuredCallerIdE164:'+14015550101'}):consumeCallSession(wrapped,{workspaceId:f.seed.alpha.workspaceId,sessionId:session?.ok?session.value.sessionId:'',callSid:'CA'+'3'.repeat(32),identity:`client:${f.seed.alpha.admin.userId}`,at:f.policy.insideWindow}));
 try{await wait();await expect.poll(async()=>Number((await f.runtime.query('SELECT count(*)::int n FROM calling_preparations WHERE id=$1 AND source_expires_at<=clock_timestamp()',[p.preparationId])).rows[0]?.['n'])).toBe(1);}finally{release.resolve();}
 await off;expect(await work).toMatchObject({ok:false});
 expect((await f.runtime.query('SELECT consumed_at,twilio_call_sid FROM call_sessions WHERE firm_id=$1',[p.firmId])).rows).toEqual(kind==='consume'?[{consumed_at:null,twilio_call_sid:null}]:[]);
 expect((await f.runtime.query('SELECT state FROM provider_reservations WHERE subject_id IN(SELECT id FROM call_sessions WHERE firm_id=$1)',[p.firmId])).rows).toEqual(kind==='consume'?[{state:'reserved'}]:[]);
 if(kind==='consume')expect(gateModes.every(sql=>sql.includes('pg_advisory_xact_lock_shared'))).toBe(true);
});
it('actual registered no-live-preparation member restriction wins a queued late confirmation under lifecycle before membership row',async()=>{
 const source=await f.source(),w=f.seed.alpha.workspaceId,user=f.seed.alpha.admin.userId,operator=f.seed.beta.admin.userId;
 await f.runtime.query("INSERT INTO workspace_memberships(workspace_id,user_id,role) VALUES($1,$2,'admin')",[w,operator]);
 const blocker=await f.database.appRuntimeSession(),worker=await f.database.appRuntimeSession(),wait=await waiting(worker),held=deferred(),release=deferred();
 const operatorContext=repositoryContext(workspaceScope(w,{kind:'user',userId:operator,role:'admin'}),blocker);
 const restriction=withTransaction(blocker,async()=>{expect(await changePreparedCallingMemberAuthority(operatorContext,{userId:user,role:'salesperson'},async()=>true)).toEqual({ok:true});held.resolve();await release.promise;});
 await held.promise;
 const confirmation=withTransaction(worker,()=>confirmCallingPreparation(f.ctx(worker),source.input,async()=>true));
 // Its first actual membership read already sees the committed role only after
 // the source owner commits. Either an early refusal or lifecycle wait is safe.
 try{await wait();}finally{release.resolve();}await restriction;expect(await confirmation).toMatchObject({ok:false});
 expect((await f.runtime.query('SELECT 1 FROM calling_preparations WHERE candidate_ref=$1',[source.input.selection.candidateId])).rows).toEqual([]);
 expect((await f.runtime.query('SELECT 1 FROM firms WHERE website=$1',[source.raw.website])).rows).toEqual([]);
});
