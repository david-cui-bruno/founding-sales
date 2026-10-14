import {it,expect} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {lockResearchBudget} from '@fss/domain/research/ceilings.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {createLinkedinRecurringComposition} from '../../worker/src/social/linkedinRecurringJobs.ts';
import {recurringFixture,recurringBarrier} from './support/linkedinRecurringFixture.ts';

async function expireComposition(h:Awaited<ReturnType<typeof recurringFixture>>){
 const current=h.runtime!;
 const expiresAt=new Date(Date.now()+1500).toISOString();
 const runtime=await createLinkedinRecurringComposition({session:h.worker,workspaceId:current.workspaceId,ownerUserId:current.ownerUserId,accountId:current.accountId,policyRevision:current.policyRevision,generation:current.generation,expiresAt,clock:current.clock,model:current.model,inspectAccount:async()=>({platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui'})});
 expect(runtime).not.toBeNull();h.setRuntime(runtime);return expiresAt;
}

for(const boundary of ['budget','commit'] as const)for(const change of ['target','expiry','valid'] as const){
 it(`registered recurring worker checks ${change} after actual ${boundary} wait before generation`,async()=>{
  const h=await recurringFixture();const blocker=await h.f.database.appRuntimeSession();
  const barrier=recurringBarrier();let running:Promise<unknown>|undefined;
  try{
   await h.prepare();const expiresAt=change==='expiry'?await expireComposition(h):null;
   const pid=(await h.worker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   const blockerPid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
   let session:SessionQueryable=h.worker;
   if(boundary==='budget'){
    await blocker.query('BEGIN');await lockResearchBudget(repositoryContext(workspaceScope(h.f.alpha.workspaceId,{kind:'system',component:'worker'}),blocker));
   }else{
    let held=false;
    session={async query<Row extends QueryResultRowLike=QueryResultRowLike>(text:string,values?:readonly unknown[]){
     const result=await h.worker.query<Row>(text,values);
     if(text==='COMMIT'&&!held){
      const persisted=await blocker.query("SELECT 1 FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='social_draft' AND state='calling'",[h.f.alpha.workspaceId]);
      if(persisted.rows.length){held=true;barrier.entered();await barrier.wait;}
     }
     return result;
    }};
   }
   running=h.run(session);
   if(boundary==='budget'){
    let blocked=false;
    for(let i=0;i<10000;i++){
     const observation=await h.api.query<{blocked:boolean}>("SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked",[pid,blockerPid]);
     if(observation.rows[0]?.blocked){blocked=true;break;}
    }
    expect(blocked).toBe(true);
   }else await barrier.arrived;
   if(change==='target')h.setClock(h.target);
   if(expiresAt)await delay(Math.max(0,Date.parse(expiresAt)-Date.now()+2));
   if(boundary==='budget')await blocker.query('ROLLBACK');else barrier.release();
   await running;
   expect(h.counts).toEqual({generations:change==='valid'?1:0,submissions:0});
   const reservations=await h.f.db.query<{state:string;settled_cents:number}>("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='social_draft'",[h.f.alpha.workspaceId]);
   if(change!=='valid'){
    expect((await h.queue()).items).toEqual([]);
    expect((await h.read()).items[0]).toMatchObject({state:'skipped',reason:change==='expiry'?'runtime_unavailable_or_expired':'slot_missed_or_not_due'});
    expect(reservations.rows.every(r=>r.state==='released'&&r.settled_cents===0)).toBe(true);
    if(boundary==='commit'){
     expect(reservations.rows).toHaveLength(1);
     expect((await h.f.db.query('SELECT state,paid_attempts FROM social_draft_requests WHERE workspace_id=$1',[h.f.alpha.workspaceId])).rows).toEqual([{state:'review',paid_attempts:1}]);
    }else expect(reservations.rows).toHaveLength(0);
    await h.prepare();await h.run();expect(h.counts.generations).toBe(0);
   }else expect(reservations.rows).toEqual([{state:'settled',settled_cents:1}]);
  }finally{
   barrier.release();await blocker.query('ROLLBACK');if(running)await running;await h.f.stop();
  }
 },20000);
}
