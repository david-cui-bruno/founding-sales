import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {refreshCallableRanks,workspacesWithStaleCallableRanks} from '../../sourcing/callableRanks.ts';
import {preparedProspectsBusinessSnapshot,seedPreparedProspect} from './preparedProspectsPgFixture.ts';

// ADR0034: "Callable today" is ordered across all pages by an advisory rank row refreshed in the background.
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const user=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace][role].userId,role}),runtime);
const worker=(workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'system',component:'worker'}),runtime);
const list=(input:Parameters<typeof listPreparedProspects>[1],context=user())=>withTransaction(runtime,()=>listPreparedProspects(context,input));
const refreshAll=async()=>{let total=0;for(let n=await refreshCallableRanks(worker());n>0;n=await refreshCallableRanks(worker()))total+=n;return total;};
const phone=(n:string)=>({id:'contact',text:`Questions about your rental? Call us at (617) 555-${n}.`});
const rows=async()=>(await runtime.query<{candidate_id:string;rank:number|null;company_host:string|null}>('SELECT candidate_id,rank,company_host FROM sourcing_callable_ranks ORDER BY candidate_id')).rows;
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await runtime.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>db?.drop());

it('orders callable companies across pages by rank then newest, one strongest record per host, from refreshed rank rows only',async()=>{
 const sharedSite='https://shared-host.example.test/';
 // 52 callable companies at rank 9 (business + residential); each index is one minute newer.
 const plain:{candidateId:string}[]=[];
 for(let i=0;i<52;i++)plain.push(await seedPreparedProspect(user(),i,{extraBlocks:[phone('0100')]}));
 const oldestStrong=await seedPreparedProspect(user(),100,{extraBlocks:[phone('0101'),{id:'person',text:'Jordan Reyes, Owner'}]});
 // Same host twice: the NEWER record is weaker, the OLDER one is stronger (person present).
 const sharedWeak=await seedPreparedProspect(user(),101,{website:sharedSite,extraBlocks:[phone('0102')]});
 const sharedStrong=await seedPreparedProspect(user(),102,{website:sharedSite,extraBlocks:[phone('0103'),{id:'person',text:'Avery Stone, Owner'}]});
 const bare=await seedPreparedProspect(user(),103,{onlyBlocks:[phone('0104')]});
 const noPhone=await seedPreparedProspect(user(),104);
 const all=[...plain,oldestStrong,sharedStrong,sharedWeak,bare,noPhone];
 const base=Date.parse('2026-10-31T08:00:00Z');
 for(const [index,row] of all.entries())await runtime.query('UPDATE sourcing_candidates SET created_at=$2::timestamptz WHERE id=$1',[row.candidateId,new Date(base+index*60_000).toISOString()]);
 // sharedStrong is OLDER than sharedWeak; oldestStrong is older than every plain record.
 await runtime.query('UPDATE sourcing_candidates SET created_at=$2::timestamptz WHERE id=$1',[oldestStrong.candidateId,new Date(base-60_000).toISOString()]);
 await runtime.query('UPDATE sourcing_candidates SET created_at=$2::timestamptz WHERE id=$1',[sharedStrong.candidateId,new Date(base+10*60_000).toISOString()]);
 await runtime.query('UPDATE sourcing_candidates SET created_at=$2::timestamptz WHERE id=$1',[sharedWeak.candidateId,new Date(base+90*60_000).toISOString()]);

 // Before any refresh nothing is ranked: the callable list is empty, not guessed.
 expect(await workspacesWithStaleCallableRanks(runtime,new Date().toISOString())).toEqual([seed.alpha.workspaceId]);
 expect(await list({offset:0,order:'callable'})).toMatchObject({ok:true,value:{prospects:[],hasMore:false}});
 expect(await refreshCallableRanks(user())).toBe(0);expect(await rows()).toEqual([]);

 const before=await preparedProspectsBusinessSnapshot(user());
 expect(await refreshAll()).toBe(all.length);
 expect(await workspacesWithStaleCallableRanks(runtime,new Date().toISOString())).toEqual([]);
 expect(await workspacesWithStaleCallableRanks(runtime,new Date(Date.now()+8*86_400_000).toISOString())).toEqual([seed.alpha.workspaceId]);
 const stored=await rows();expect(stored).toHaveLength(all.length);
 expect(stored.find(r=>r.candidate_id===noPhone.candidateId)).toMatchObject({rank:null});
 expect(stored.find(r=>r.candidate_id===bare.candidateId)).toMatchObject({rank:0});
 expect(stored.find(r=>r.candidate_id===oldestStrong.candidateId)).toMatchObject({rank:13});
 expect(stored.find(r=>r.candidate_id===sharedWeak.candidateId)).toMatchObject({rank:9,company_host:'shared-host.example.test'});

 const first=await list({offset:0,order:'callable'});if(!first.ok)throw Error(first.reason);
 const ids=first.value.prospects.map(p=>p.target.candidateId);
 // Globally strongest first although it is the oldest record, then the shared host's strongest record, never its weaker twin.
 expect(ids.slice(0,2).sort()).toEqual([oldestStrong.candidateId,sharedStrong.candidateId].sort());
 expect(ids[0]).toBe(sharedStrong.candidateId);expect(ids[1]).toBe(oldestStrong.candidateId);
 expect(first.value.prospects.every(p=>p.callable.state==='callable')).toBe(true);expect(first.value.hasMore).toBe(true);
 expect(ids).not.toContain(sharedWeak.candidateId);
 const second=await list({offset:50,viewRevision:first.value.viewRevision,order:'callable'});if(!second.ok)throw Error(second.reason);
 const rest=second.value.prospects.map(p=>p.target.candidateId);
 // 52 plain + oldestStrong + sharedStrong + bare = 55 distinct hosts' representatives; the bare phone-only one is last.
 expect(ids.length+rest.length).toBe(55);expect(second.value.hasMore).toBe(false);expect(rest[rest.length-1]).toBe(bare.candidateId);
 // Within one rank the newest comes first.
 const plainOrder=[...ids,...rest].filter(id=>plain.some(p=>p.candidateId===id));
 expect(plainOrder).toEqual(plain.map(p=>p.candidateId).reverse());
 expect(new Set(first.value.prospects.map(p=>p.companyHost)).size).toBe(first.value.prospects.length);
 // The order is bound into the continuation, and the page has no side effect.
 expect((await list({offset:0})).ok&&(await list({offset:0}) as {value:{viewRevision:string}}).value.viewRevision).not.toBe(first.value.viewRevision);
 expect(await list({offset:50,viewRevision:first.value.viewRevision})).toMatchObject({ok:false,reason:'view_changed'});
 expect(await preparedProspectsBusinessSnapshot(user())).toEqual(before);
});

it('drops a rank row when its run evidence changes, withholds an expired row and re-ranks a changed candidate on the next refresh',async()=>{
 const a=await seedPreparedProspect(user(),1,{extraBlocks:[phone('0100')]}),b=await seedPreparedProspect(user(),2,{extraBlocks:[phone('0101')]});
 expect(await refreshAll()).toBe(2);
 const callableIds=async()=>{const page=await list({offset:0,order:'callable'});if(!page.ok)throw Error(page.reason);return page.value.prospects.map(p=>p.target.candidateId).sort();};
 expect(await callableIds()).toEqual([a.candidateId,b.candidateId].sort());
 // New evidence on the run deletes its rank row (erasure and supersession), so the list withholds it at once.
 await runtime.query("UPDATE sourcing_qualification_runs SET observations='[]' WHERE id=$1",[a.runId]);
 expect((await rows()).map(r=>r.candidate_id)).toEqual([b.candidateId]);expect(await callableIds()).toEqual([b.candidateId]);
 // An expired row is withheld by the read and is stale again for the refresh.
 await runtime.query("UPDATE sourcing_callable_ranks SET computed_at=now()-interval '2 days',expires_at=now()-interval '1 day'");
 expect(await callableIds()).toEqual([]);
 // The emptied run has no retained research left to rank, so only the other candidate is refreshed.
 expect(await refreshAll()).toBe(1);
 expect(await callableIds()).toEqual([b.candidateId]);expect((await rows()).map(r=>r.candidate_id)).toEqual([b.candidateId]);
 // A new candidate revision never inherits the old row.
 await runtime.query('UPDATE sourcing_candidates SET revision=revision+1 WHERE id=$1',[b.candidateId]);
 expect(await callableIds()).toEqual([]);
});

it('keeps rank rows workspace-fenced, worker-only and admin-read-only',async()=>{
 await seedPreparedProspect(user(),1,{extraBlocks:[phone('0100')]});
 expect(await refreshCallableRanks(user())).toBe(0);expect(await refreshCallableRanks(worker('beta'))).toBe(0);
 expect(await refreshAll()).toBe(1);
 expect(await list({offset:0,order:'callable'},user('alpha','salesperson'))).toMatchObject({ok:false,reason:'authority_changed'});
 expect(await list({offset:0,order:'callable'},user('beta'))).toMatchObject({ok:true,value:{prospects:[],hasMore:false}});
 const lost=await runtime.query("UPDATE sourcing_candidates SET source_check='{\"state\":\"unavailable\",\"reason\":\"source_not_permitted\"}' RETURNING id");
 expect(lost.rows).toHaveLength(1);
 expect(await list({offset:0,order:'callable'})).toMatchObject({ok:true,value:{prospects:[]}});
});

it('falls back to the next record of a host when its cached winner no longer projects callable, and keeps a host with none',async()=>{
 const site='https://fallback-host.example.test/',lone='https://lone-host.example.test/';
 const winner=await seedPreparedProspect(user(),1,{website:site,extraBlocks:[phone('0100'),{id:'person',text:'Jordan Reyes, Owner'}]});
 const second=await seedPreparedProspect(user(),2,{website:site,extraBlocks:[phone('0101')]});
 const third=await seedPreparedProspect(user(),3,{website:site,extraBlocks:[phone('0102')]});
 const only=await seedPreparedProspect(user(),4,{website:lone,extraBlocks:[phone('0103')]});
 expect(await refreshAll()).toBe(4);
 const shown=async()=>{const page=await list({offset:0,order:'callable'});if(!page.ok)throw Error(page.reason);return page.value.prospects.map(p=>[p.target.candidateId,p.callable.state]);};
 expect(await shown()).toEqual([[winner.candidateId,'callable'],[only.candidateId,'callable']]);
 // The source authority behind the winner and the lone company changes without touching their runs' evidence triggers: the rank
 // rows are still current but a fresh projection finds no phone. (The trigger is bypassed to model a change it cannot see.)
 const strip=async(row:typeof winner)=>{
  const blocks=row.observations[0]!.blocks.filter(b=>b.id!=='contact'&&b.id!=='person'),hash=createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
  await db.session.query("UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1",[row.runId,JSON.stringify([{...row.observations[0],blocks,contentHash:hash,relevantTextHash:hash}])]);
 };
 await db.session.query('ALTER TABLE sourcing_qualification_runs DISABLE TRIGGER sourcing_callable_rank_run_lifecycle');
 await strip(winner);await strip(only);
 await db.session.query('ALTER TABLE sourcing_qualification_runs ENABLE TRIGGER sourcing_callable_rank_run_lifecycle');
 expect((await rows()).filter(r=>r.rank!==null)).toHaveLength(4);
 const after=await shown();
 // The host's next-ranked record (third: newer than second at equal rank) stands in, in the failed winner's place; the lone
 // company has no sibling, so its failed winner stays, marked not callable for the page to leave out.
 expect(after).toEqual([[third.candidateId,'callable'],[only.candidateId,'not_callable']]);
 expect(after.map(r=>r[0])).not.toContain(second.candidateId);
});

it('gives every failed host its own fallback rounds, so many failed hosts never starve a later host',async()=>{
 const winners:Awaited<ReturnType<typeof seedPreparedProspect>>[]=[],siblings:string[]=[];
 // Twenty hosts: a stronger winner (person) whose evidence will fail, then three callable siblings each. A global cap of three siblings per host and fifty rows would
 // spend its fifty rows on the first sixteen hosts and leave the last hosts with none.
 for(let h=0;h<20;h++){
  const site=`https://many-${String(h).padStart(2,'0')}.example.test/`;
  winners.push(await seedPreparedProspect(user(),h*10,{website:site,extraBlocks:[phone('0100'),{id:'person',text:'Jordan Reyes, Owner'}]}));
  for(let k=1;k<=3;k++)siblings.push((await seedPreparedProspect(user(),h*10+k,{website:site,extraBlocks:[phone('0101')]})).candidateId);
 }
 expect(await refreshAll()).toBe(80);
 await db.session.query('ALTER TABLE sourcing_qualification_runs DISABLE TRIGGER sourcing_callable_rank_run_lifecycle');
 for(const row of winners){
  const blocks=row.observations[0]!.blocks.filter(b=>b.id!=='contact'&&b.id!=='person'),hash=createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
  await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb WHERE id=$1',[row.runId,JSON.stringify([{...row.observations[0],blocks,contentHash:hash,relevantTextHash:hash}])]);
 }
 await db.session.query('ALTER TABLE sourcing_qualification_runs ENABLE TRIGGER sourcing_callable_rank_run_lifecycle');
 const page=await list({offset:0,order:'callable'});if(!page.ok)throw Error(page.reason);
 expect(page.value.prospects).toHaveLength(20);
 expect(page.value.prospects.every(p=>p.callable.state==='callable'&&siblings.includes(p.target.candidateId))).toBe(true);
 expect(new Set(page.value.prospects.map(p=>p.companyHost)).size).toBe(20);
});
