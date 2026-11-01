import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {preparedProspectsBusinessSnapshot,seedPreparedProspect} from './preparedProspectsPgFixture.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable,seeded:{candidateId:string}[];
const ctx=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace][role].userId,role}),runtime);
const list=(input:Parameters<typeof listPreparedProspects>[1],context=ctx())=>withTransaction(runtime,()=>listPreparedProspects(context,input));
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{
 await runtime.query('DELETE FROM sourcing_candidates');seeded=[];
 // Index 50 is the newest discovery record and the only one with a published phone.
 for(let i=0;i<51;i++)seeded.push(await seedPreparedProspect(ctx(),i,i===50?{extraBlocks:[{id:'contact',text:'Questions about your rental? Call us at (617) 555-0100.'}]}:{}));
 for(const [index,row] of seeded.entries())await runtime.query("UPDATE sourcing_candidates SET created_at=timestamptz '2026-10-31T08:00:00Z'+$2::integer*interval '1 minute' WHERE id=$1",[row.candidateId,index]);
});
afterAll(async()=>db?.drop());

it('pages newest discovery records first in bounded pages with an order-bound continuation and no writes',async()=>{
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const before=await preparedProspectsBusinessSnapshot(ctx());
 const first=await list({offset:0,order:'newest'});if(!first.ok)throw Error(first.reason);
 expect(first.value.prospects).toHaveLength(50);expect(first.value.hasMore).toBe(true);
 expect(first.value.prospects.map(p=>p.target.candidateId)).toEqual(seeded.slice(1).reverse().map(s=>s.candidateId));
 expect(first.value.prospects[0]!.callable).toEqual({state:'callable',missing:[],phone:'(617) 555-0100',person:null,residential:true});
 expect(first.value.prospects.slice(1).every(p=>p.callable.state==='not_callable'&&p.callable.missing.includes('no_published_phone'))).toBe(true);
 const second=await list({offset:50,viewRevision:first.value.viewRevision,order:'newest'});if(!second.ok)throw Error(second.reason);
 expect(second.value.prospects.map(p=>p.target.candidateId)).toEqual([seeded[0]!.candidateId]);expect(second.value.hasMore).toBe(false);
 const priority=await list({offset:0});if(!priority.ok)throw Error(priority.reason);
 expect(priority.value.viewRevision).not.toBe(first.value.viewRevision);
 expect(await list({offset:50,viewRevision:first.value.viewRevision})).toMatchObject({ok:false,reason:'view_changed'});
 expect(await list({offset:50,viewRevision:priority.value.viewRevision,order:'newest'})).toMatchObject({ok:false,reason:'view_changed'});
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});

it('keeps newest continuation, source loss, workspace and admin fences unchanged',async()=>{
 const first=await list({offset:0,order:'newest'});if(!first.ok)throw Error(first.reason);
 expect(await list({offset:0,order:'newest'},ctx('alpha','salesperson'))).toMatchObject({ok:false,reason:'authority_changed'});
 expect(await list({offset:0,order:'newest'},ctx('beta'))).toMatchObject({ok:true,value:{prospects:[],hasMore:false}});
 const offPage=seeded[0]!.candidateId;
 await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[offPage]);
 expect(await list({offset:50,viewRevision:first.value.viewRevision,order:'newest'})).toMatchObject({ok:false,reason:'view_changed'});
 const refreshed=await list({offset:0,order:'newest'});if(!refreshed.ok)throw Error(refreshed.reason);
 expect(refreshed.value.hasMore).toBe(false);expect(refreshed.value.prospects.map(p=>p.target.candidateId)).not.toContain(offPage);
 expect(refreshed.value.prospects[0]!.target.candidateId).toBe(seeded[50]!.candidateId);
});
