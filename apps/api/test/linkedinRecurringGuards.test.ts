import {randomUUID} from 'node:crypto';
import {it,expect} from 'vitest';
import pg from 'pg';
import {asSession,CLUSTER_URL_ENVIRONMENT_VARIABLE} from '@fss/domain/db/testing/testDatabase.ts';
import type {SessionQueryable,QueryResultRowLike} from '@fss/domain/db/queryable.ts';
import {recurringFixture,recurringBarrier,recurringCommand,recurringText} from './support/linkedinRecurringFixture.ts';

it.each(['no_input','no_funding','no_runtime','expired_runtime','unknown_bound','late_start','refused_output'] as const)('recurring %s produces no generation/publication fallback',async scenario=>{
 const h=await recurringFixture({noInput:scenario==='no_input',noFunding:scenario==='no_funding',count:scenario==='unknown_bound'?NaN:100,output:scenario==='refused_output'?'{"concepts":[]}':undefined});try{
 if(scenario==='no_runtime')h.setRuntime(null);
 if(scenario==='expired_runtime')h.setRuntime({...h.runtime!,expiresAt:new Date(Date.now()-1).toISOString()});
 if(scenario==='late_start')h.setClock(h.target);
 await h.prepare();await h.run();
 expect(h.counts).toEqual({generations:scenario==='refused_output'?1:0,submissions:0});
 expect((await h.queue()).items).toEqual([]);
 expect((await h.read()).items).toHaveLength(1);
 expect((await h.read()).items[0]!.state).toMatch(/skipped|review/);
 // Input supplied after this failed slot cannot resurrect it or create filler/catch-up.
 if(scenario==='no_input')await h.saveFact();
 await h.prepare();await h.run();expect(h.counts.submissions).toBe(0);
 }finally{await h.f.stop();}
});

async function invalidate(h:Awaited<ReturnType<typeof recurringFixture>>,change:'retire'|'revise'|'account'|'delete'|'revoke'|'budget'|'late'){
 if(change==='retire')expect((await h.call('/outreach/answer-blocks/retire',recurringCommand(h.ref!))).status).toBe(200);
 if(change==='revise')expect((await h.call('/social/linkedin-posting-policy/save',recurringCommand({...h.policy,expectedRevision:1}))).status).toBe(200);
 if(change==='account')expect((await h.call('/social/accounts/connect',recurringCommand({accountId:h.accountId,platform:'linkedin',externalId:'david-cui-589a20228',displayName:'Changed account observation',accountKind:'profile'}))).status).toBe(200);
 // Deliberate external loss fixtures only. They never provision positive authority.
 if(change==='delete')await h.f.db.query('DELETE FROM outreach_answer_block_versions WHERE workspace_id=$1 AND block_id=$2 AND version=$3',[h.f.alpha.workspaceId,h.ref!.id,h.ref!.version]);
 if(change==='revoke')expect((await h.call('/social/linkedin-posting-policy/revoke',recurringCommand({expectedRevision:1}))).status).toBe(200);
 if(change==='budget')expect((await h.call('/research/settings',recurringCommand({enabled:false}))).status).toBe(200);
 if(change==='late')h.setClock(h.target);
}

it.each(['retire','revise','revoke','account','delete','budget','late'] as const)('%s during paid generation conserves spend and refuses standing admission',async change=>{
 const b=recurringBarrier(),h=await recurringFixture({generationWait:async()=>{b.entered();await b.wait;}});let running:Promise<unknown>|undefined;try{
 await h.prepare();running=h.run();await b.arrived;await invalidate(h,change);b.release();await running;
 expect(h.counts).toEqual({generations:1,submissions:0});expect((await h.queue()).items).toEqual([]);
 expect((await h.read()).items[0]).toMatchObject({spendCents:1,postId:null});
 }finally{b.release();await running;await h.f.stop();}
});
it('source retirement during token counting prevents any paid attempt',async()=>{
 const b=recurringBarrier(),h=await recurringFixture({countWait:async()=>{b.entered();await b.wait;}});let running:Promise<unknown>|undefined;try{
 await h.prepare();running=h.run();await b.arrived;await invalidate(h,'retire');b.release();await running;
 expect(h.counts).toEqual({generations:0,submissions:0});expect((await h.read()).items[0]).toMatchObject({spendCents:0,postId:null});
 }finally{b.release();await running;await h.f.stop();}
});
it.each(['retire','revise','revoke','account','budget','late'] as const)('%s across desktop preparation wait prevents submission',async change=>{
 const h=await recurringFixture();try{await h.prepare();await h.run();const attempt=await h.submit({stage:()=>invalidate(h,change)});expect(attempt.outcome.state).toBe('not_submitted');expect(h.counts.submissions).toBe(0);expect((await h.read()).items[0]!.submissionId).toBeNull();}finally{await h.f.stop();}
});
it.each(['retire','revise','revoke','account','budget','late'] as const)('%s after durable begin response preserves unknown marker but prevents final dispatch',async change=>{
 const h=await recurringFixture();try{await h.prepare();await h.run();const attempt=await h.submit({begin:()=>invalidate(h,change)});expect(attempt.outcome.state).toBe('unknown');expect(h.counts.submissions).toBe(0);expect((await h.read()).items[0]).toMatchObject({state:'unknown_paused',submissionId:expect.any(String),spendCents:1});}finally{await h.f.stop();}
});
it('revoke stops all further eligible dispatch while original unknown marker remains inspectable and is never replayed',async()=>{
 const h=await recurringFixture();try{
 await h.prepare();await h.run();const attempt=await h.submit({unknown:true});expect(attempt.outcome).toEqual({state:'unknown'});
 const original=(await h.read()).items[0]!.submissionId;expect(original).not.toBeNull();
 expect((await h.call('/social/linkedin-posting-policy/revoke',recurringCommand({expectedRevision:1}))).status).toBe(200);
 await h.prepare();await h.run();expect(h.counts).toEqual({generations:1,submissions:1});
 expect(await h.inspect(attempt)).toEqual({state:'scheduled'});
 expect((await h.read()).items[0]).toMatchObject({state:'receipt',submissionId:original,receiptId:'controlled-inspected-receipt',spendCents:1});expect(h.counts.submissions).toBe(1);
 }finally{await h.f.stop();}
});
it('concurrent schedulers and restarted workers retain one account target across policy revision changes',async()=>{
 const h=await recurringFixture();try{
 const other=await h.f.database.appRuntimeSession();await Promise.all([h.prepare(),h.prepare(other)]);
 expect((await h.read()).items).toHaveLength(1);
 await Promise.all([h.run(),h.run(other)]);expect(h.counts.generations).toBe(1);expect((await h.queue()).items).toHaveLength(1);
 await invalidate(h,'revise');await h.prepare();await h.run();expect((await h.read()).items).toHaveLength(1);expect(h.counts.generations).toBe(1);expect((await h.queue()).items).toEqual([]);
 }finally{await h.f.stop();}
});
it('generic manual scheduler excludes recurring requests while ordinary manual requests remain selected',async()=>{
 const h=await recurringFixture();try{
 await h.prepare();expect(await h.generic()).toEqual([]);
 const second=await h.saveFact('I am planning a bounded maintenance intake experiment.');
 expect((await h.call('/social/drafts/request',recurringCommand({mode:'linkedin_grounded',sourceRefs:[],factBlocks:[second]}))).status).toBe(200);
 expect(await h.generic()).toHaveLength(1);
 }finally{await h.f.stop();}
});
it('uncertain generation usage is conservatively retained, never a free retry',async()=>{
 const h=await recurringFixture({estimated:true,output:'{"concepts":[]}'});try{await h.prepare();await h.run();const first=(await h.read()).items[0]!;expect(first.spendCents).toBeGreaterThan(0);expect(first.state).toBe('review');await h.prepare();await h.run();expect(h.counts.generations).toBe(1);}finally{await h.f.stop();}
});
it('manual approval still records a real human and never acquires standing origin implicitly',async()=>{
 const h=await recurringFixture();try{
 const save=await h.call('/social/posts/save',recurringCommand({accountId:h.accountId,text:recurringText,images:[],publishAt:h.target,zone:'America/New_York'}));const p=(save.body as {result:{postId:string;revision:number}}).result;
 expect((await h.call('/social/posts/approve',recurringCommand({postId:p.postId,expectedRevision:1}))).status).toBe(200);
 h.setRuntime(null);expect((await h.queue()).items).toHaveLength(1);
 const a=(await h.api.query<{approval_kind:string;approved_by:string}>('SELECT approval_kind,approved_by FROM social_post_approvals WHERE workspace_id=$1 AND post_id=$2',[h.f.alpha.workspaceId,p.postId])).rows[0];expect(a).toEqual({approval_kind:'manual',approved_by:h.f.alpha.admin.userId});
 expect((await h.read()).items).toEqual([]);
 }finally{await h.f.stop();}
});
it('origin constraints and catalog privileges forbid invented human approval, missing/exchanged standing slot and audit erasure',async()=>{
 const h=await recurringFixture();try{
 await h.prepare();await h.run();const s=(await h.read()).items[0]!;
 const approval=(await h.api.query<{fingerprint:string;snapshot:unknown}>('SELECT fingerprint,snapshot FROM social_post_approvals WHERE workspace_id=$1 AND post_id=$2',[h.f.alpha.workspaceId,s.postId])).rows[0]!;
 for(const [kind,approved,slot] of [['manual',null,null],['standing_policy',h.f.alpha.admin.userId,s.id],['standing_policy',null,null]] as const){
  await expect(h.api.query('INSERT INTO social_post_approvals(workspace_id,id,post_id,revision,account_revision,fingerprint,snapshot,approved_by,approval_kind,standing_slot_id) VALUES($1,$2,$3,1,1,$4,$5::jsonb,$6,$7,$8)',[h.f.alpha.workspaceId,randomUUID(),s.postId,approval.fingerprint,JSON.stringify(approval.snapshot),approved,kind,slot])).rejects.toMatchObject({code:'23514'});
 }
 const save=await h.call('/social/posts/save',recurringCommand({accountId:h.accountId,text:recurringText,images:[],publishAt:h.target,zone:'America/New_York'}));const postId=(save.body as {result:{postId:string}}).result.postId;
 await expect(h.api.query("INSERT INTO social_post_approvals(workspace_id,id,post_id,revision,account_revision,fingerprint,snapshot,approved_by,approval_kind,standing_slot_id) VALUES($1,$2,$3,1,1,$4,$5::jsonb,NULL,'standing_policy',$6)",[h.f.alpha.workspaceId,randomUUID(),postId,approval.fingerprint,JSON.stringify(approval.snapshot),s.id])).rejects.toMatchObject({code:'23503'});
 await expect(h.api.query('UPDATE linkedin_recurring_slots SET policy_revision=2 WHERE workspace_id=$1 AND id=$2',[h.f.alpha.workspaceId,s.id])).rejects.toMatchObject({code:'42501'});
 await expect(h.api.query('DELETE FROM linkedin_recurring_slots WHERE workspace_id=$1 AND id=$2',[h.f.alpha.workspaceId,s.id])).rejects.toMatchObject({code:'42501'});
 await expect(h.api.query('UPDATE social_post_approvals SET approved_by=$3 WHERE workspace_id=$1 AND post_id=$2',[h.f.alpha.workspaceId,s.postId,h.f.alpha.admin.userId])).rejects.toMatchObject({code:'42501'});
 expect((await h.read()).items).toHaveLength(1);
 }finally{await h.f.stop();}
});

it.each(['retire','account','revoke','budget','late'] as const)('owner readback reflects %s instead of a stale eligible queue',async change=>{
 const h=await recurringFixture();try{await h.prepare();await h.run();expect((await h.read()).items[0]!.state).toBe('queued');await invalidate(h,change);expect((await h.queue()).items).toEqual([]);const current=(await h.read()).items[0]!;expect(current.state).toBe(change==='revoke'?'revoked':change==='late'?'skipped':'review');expect(current.spendCents).toBe(1);expect(current.postId).not.toBeNull();}finally{await h.f.stop();}
});

it('owner membership loss during paid generation spends once without authorizing worker impersonation',async()=>{
 const b=recurringBarrier(),h=await recurringFixture({generationWait:async()=>{b.entered();await b.wait;}});let running:Promise<unknown>|undefined;try{
 await h.prepare();running=h.run();await b.arrived;await h.f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[h.f.alpha.workspaceId,h.f.alpha.salesperson.userId]);await h.f.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[h.f.alpha.workspaceId,h.f.alpha.admin.userId]);b.release();await running;expect(h.counts).toEqual({generations:1,submissions:0});expect((await h.call('/social/linkedin-recurring/read',{})).status).toBe(401);
 const rows=await h.api.query<{state:string;post_id:string|null}>('SELECT state,post_id FROM linkedin_recurring_slots WHERE workspace_id=$1',[h.f.alpha.workspaceId]);expect(rows.rows[0]).toEqual({state:'skipped',post_id:null});
 }finally{b.release();await running;await h.f.stop();}
});

it.each(['day','month','shared'] as const)('trusted maximum refuses exhausted %s allowance without laundering the posting lane',async boundary=>{
 const h=await recurringFixture();try{
 expect((await h.call('/research/settings',recurringCommand({enabled:true,dailyCostCeilingCents:boundary==='shared'?0:10000,monthlyCostCeilingCents:100000}))).status).toBe(200);
 if(boundary!=='shared')await h.f.db.query(`INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,state,settled_cents,settled_at,created_at) VALUES($1,'aws_bedrock.social_draft','social_draft',$2,1,(now() AT TIME ZONE 'America/New_York')::date,'America/New_York',$3,'claude-haiku-4-5',100,4096,'settled',$3,now(),CASE WHEN $4='month' THEN date_trunc('month',now() AT TIME ZONE 'America/New_York') AT TIME ZONE 'America/New_York' ELSE now() END)`,[h.f.alpha.workspaceId,randomUUID(),boundary==='day'?98:998,boundary]);
 await h.prepare();await h.run();expect(h.counts).toEqual({generations:0,submissions:0});expect((await h.queue()).items).toEqual([]);expect((await h.read()).items[0]!.spendCents).toBe(0);
 }finally{await h.f.stop();}
});
it('reported cost above trusted reservation remains charged and never admitted',async()=>{
 const h=await recurringFixture({cost:101});try{await h.prepare();await h.run();expect(h.counts).toEqual({generations:1,submissions:0});expect((await h.read()).items[0]!.spendCents).toBe(101);expect((await h.queue()).items).toEqual([]);await h.prepare();await h.run();expect(h.counts.generations).toBe(1);}finally{await h.f.stop();}
});
it.each(['I believe this sensitive position is right.','We shipped an unsupported result.','We saved 75% for a customer.'] as const)('unsupported generated claim stays review without fallback: %s',async claim=>{
 const h=await recurringFixture({text:recurringText+'\n\n'+claim});try{await h.prepare();await h.run();expect((await h.read()).items[0]).toMatchObject({state:'review',postId:null,spendCents:1});expect((await h.queue()).items).toEqual([]);await h.prepare();await h.run();expect(h.counts).toEqual({generations:1,submissions:0});}finally{await h.f.stop();}
});
it('actual disposable worker connection loss during paid model wait leaves durable unknown spend, restart never regenerates',async()=>{
 const b=recurringBarrier(),h=await recurringFixture({generationWait:async()=>{b.entered();await b.wait;}});
 const url=new URL(process.env[CLUSTER_URL_ENVIRONMENT_VARIABLE]!);url.pathname=`/${h.f.database.name}`;const client=new pg.Client({connectionString:url.toString()});const errors:Error[]=[];client.on('error',error=>errors.push(error));let running:Promise<unknown>|undefined;try{
 await client.connect();await client.query('SET ROLE app_runtime');const lost=asSession({query:(text,values)=>client.query(text,values),connect:async()=>{await client.connect();},end:()=>client.end()});
 await h.prepare(lost);running=h.run(lost).catch(error=>error);await b.arrived;
 const pid=(await lost.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;await h.f.db.query('SELECT pg_terminate_backend($1)',[pid]);b.release();await running;
 const original=(await h.read()).items[0]!;expect(original).toMatchObject({state:'unknown_paused',postId:null});expect(original.spendCents).toBeGreaterThan(0);
 const restarted=await h.f.database.appRuntimeSession();await h.prepare(restarted);await h.run(restarted);expect(h.counts).toEqual({generations:1,submissions:0});expect((await h.queue()).items).toEqual([]);expect((await h.read()).items[0]!.spendCents).toBe(original.spendCents);
 expect(errors.length).toBeGreaterThan(0);
 }finally{b.release();await running;await client.end();await h.f.stop();}
});
it('owner access lost after authenticated read begins cannot expose historical prior-owner queue',async()=>{
 const h=await recurringFixture(),b=recurringBarrier();let reading:Promise<unknown>|undefined;try{
 await h.prepare();await h.run();let waited=false;
 const session:SessionQueryable={async query<Row extends QueryResultRowLike=QueryResultRowLike>(text:string,values?:readonly unknown[]){if(!waited&&text.includes('pg_advisory_xact_lock')){waited=true;b.entered();await b.wait;}return h.api.query<Row>(text,values);}};
 reading=h.call('/social/linkedin-recurring/read',{},session);await b.arrived;
 await h.f.db.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[h.f.alpha.workspaceId,h.f.alpha.salesperson.userId]);
 await h.f.db.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=now() WHERE workspace_id=$1 AND user_id=$2",[h.f.alpha.workspaceId,h.f.alpha.admin.userId]);b.release();
 expect(await reading).toMatchObject({status:200,body:{holds:['owner_unavailable'],items:[]}});
 }finally{b.release();await reading;await h.f.stop();}
});
