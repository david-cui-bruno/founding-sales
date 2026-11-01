import {createHash} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listPreparedProspects,readPreparedProspect} from '../../sourcing/preparedProspects.ts';
import {seedPreparedProspect,preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
import {residentialFacts} from './support/modelSelections.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await runtime.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>db?.drop());

it.each([
 'All maintenance is taken care of promptly to support resident satisfaction and tenant retention.',
 'Our tenants submit maintenance requests through the portal.',
])('shows retained operational context through actual app_runtime list/detail without business changes: %s',async text=>{
 const f=await seedPreparedProspect(ctx());
 const blocks=[{id:'workflow-only',text},{id:'office',text:'Office: 42 Fictional Street, Boston MA 02108. General office: (617) 555-0123.'}];
 const observations=f.observations.map(page=>({...page,blocks,relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}));
 await runtime.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,facts=$3::jsonb WHERE id=$1',[f.runId,JSON.stringify(observations),JSON.stringify(residentialFacts(observations))]);
 const before=await preparedProspectsBusinessSnapshot(ctx());
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const page=await withTransaction(runtime,()=>listPreparedProspects(ctx(),{offset:0}));if(!page.ok)throw Error(page.reason);
 expect(page.value.prospects).toHaveLength(1);expect(page.value.prospects[0]).toMatchObject({state:'prepared'});
 const brief=await withTransaction(runtime,()=>readPreparedProspect(ctx(),page.value.prospects[0]!.target));if(!brief.ok)throw Error(brief.reason);
 expect(brief.value).toMatchObject({state:'prepared',contactAuthority:'not_granted',coverage:'complete_retained_pages'});
 expect(brief.value.passages).toContainEqual(expect.objectContaining({kind:'workflow',blockId:'workflow-only',quote:text,url:f.website}));
 // Residential fit is the model's residential-management selection; operations alone leave it unknown.
 expect(brief.value.unknowns.join(' ')).toMatch(/residential.*unknown/iu);expect(brief.value.unknowns.join(' ')).toMatch(/publisher.*identity.*not independently verified/iu);
 expect(brief.value.callable).toMatchObject({state:'not_callable',residential:false,missing:['no_business_context','no_published_phone']});
 expect(brief.value.summary).not.toMatch(/first.party/iu);expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});
