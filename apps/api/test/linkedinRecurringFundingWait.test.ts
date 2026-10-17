import {it,expect} from 'vitest';
import {setTimeout as delay} from 'node:timers/promises';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {createLinkedinRecurringComposition} from '../../worker/src/social/linkedinRecurringJobs.ts';
import {recurringFixture,recurringBarrier,recurringCommand} from './support/linkedinRecurringFixture.ts';

it.each(['disabled','ceiling','expiry','target','valid'] as const)('final standing dispatch rechecks %s after real governed fact approval wait',async change=>{
 const h=await recurringFixture();const approvalSession=await h.f.database.appRuntimeSession(),settingsSession=await h.f.database.appRuntimeSession();
 const barrier=recurringBarrier();let approval:Promise<unknown>|undefined,attempt:ReturnType<typeof h.submit>|undefined;
 try{
  await h.prepare();await h.run();expect(h.counts.generations).toBe(1);
  let expiresAt:string|null=null;
  if(change==='expiry'){
   const current=h.runtime!;expiresAt=new Date(Date.now()+1500).toISOString();
   const runtime=await createLinkedinRecurringComposition({session:h.worker,workspaceId:current.workspaceId,ownerUserId:current.ownerUserId,accountId:current.accountId,policyRevision:current.policyRevision,generation:current.generation,expiresAt,clock:current.clock,model:current.model,inspectAccount:async()=>({platform:'linkedin',externalId:'david-cui-589a20228',displayName:'David Cui'})});
   expect(runtime).not.toBeNull();h.setRuntime(runtime);
  }
  const pid=(await h.api.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  const blockerPid=(await approvalSession.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let held=false;
  const paused:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(text:string,values?:readonly unknown[]){
   if(text==='COMMIT'&&!held){held=true;barrier.entered();await barrier.wait;}
   return approvalSession.query<Row>(text,values);
  }};
  attempt=h.submit({begin:async()=>{
   // Ordinary reapproval retains the same approved content/hash but owns its
   // actual update lock until the real command transaction commits.
   approval=h.call('/outreach/answer-blocks/approve',recurringCommand(h.ref!),paused);
   await barrier.arrived;
  }});
  await barrier.arrived;
  let blocked=false;
  for(let i=0;i<10000;i++){
   const observation=await settingsSession.query<{blocked:boolean}>('SELECT $2::integer=ANY(pg_blocking_pids($1)) AS blocked',[pid,blockerPid]);
   if(observation.rows[0]?.blocked){blocked=true;break;}
  }
  expect(blocked).toBe(true);
  if(change==='disabled')expect((await h.call('/research/settings',recurringCommand({enabled:false}),settingsSession)).status).toBe(200);
  if(change==='ceiling')expect((await h.call('/research/settings',recurringCommand({enabled:true,dailyCostCeilingCents:0,monthlyCostCeilingCents:1000}),settingsSession)).status).toBe(200);
  if(change==='target')h.setClock(h.target);
  if(expiresAt)await delay(Math.max(0,Date.parse(expiresAt)-Date.now()+2));
  barrier.release();expect(await approval).toMatchObject({status:200});
  const result=await attempt;
  expect(h.counts).toEqual({generations:1,submissions:change==='valid'?1:0});
  expect(result.outcome.state).toBe(change==='valid'?'scheduled':'unknown');
  // The normal durable begin marker is preserved for inspection, not silently
  // erased or retried when final standing permission is withheld.
  const markers=await h.f.db.query<{submission_id:string|null}>('SELECT submission_id FROM social_deliveries WHERE workspace_id=$1',[h.f.alpha.workspaceId]);
  expect(markers.rows).toHaveLength(1);expect(markers.rows[0]!.submission_id).not.toBeNull();
  expect((await h.f.db.query("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1 AND subject_kind='social_draft'",[h.f.alpha.workspaceId])).rows).toEqual([{state:'settled',settled_cents:1}]);
  if(change==='valid')expect((await h.read()).items[0]).toMatchObject({state:'receipt',receiptId:'controlled-receipt'});
 }finally{
  barrier.release();if(approval)await approval;if(attempt)await attempt;await h.f.stop();
 }
},20000);
