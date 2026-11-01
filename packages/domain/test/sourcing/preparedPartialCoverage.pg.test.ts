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
 {text:'Our company manages residential rental homes, including leasing and rent collection for owners.',state:'prepared'},
 {text:'Our tenants use our portal to pay rent online and submit maintenance requests.',state:'prepared'},
 {text:'Our team coordinates repairs for tenants. We do not manage residential homes.',state:'needs_research'},
])('reads partial retained fields through app_runtime with contrary and no-write boundaries: $state',async({text,state})=>{
 const f=await seedPreparedProspect(ctx());
 const blocks=[{id:'retained',text}];
 const observations=f.observations.map(page=>({...page,truncated:true,blocks,relevantTextHash:createHash('sha256').update(JSON.stringify(blocks)).digest('hex')}));
 await runtime.query('UPDATE sourcing_qualification_runs SET observations=$2::jsonb,facts=$3::jsonb WHERE id=$1',[f.runId,JSON.stringify(observations),JSON.stringify(residentialFacts(observations))]);
 const before=await preparedProspectsBusinessSnapshot(ctx());
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const page=await withTransaction(runtime,()=>listPreparedProspects(ctx(),{offset:0}));if(!page.ok)throw Error(page.reason);
 expect(page.value.prospects).toHaveLength(1);expect(page.value.prospects[0]).toMatchObject({state});
 const brief=await withTransaction(runtime,()=>readPreparedProspect(ctx(),page.value.prospects[0]!.target));if(!brief.ok)throw Error(brief.reason);
 expect(brief.value).toMatchObject({state,policyVersion:'prepared-prospect-v2',coverage:'partial_retained_pages',contactAuthority:'not_granted'});
 expect(brief.value.passages).toContainEqual(expect.objectContaining({quote:text,sourceCoverage:'partial_page',blockId:'retained',url:f.website}));
 expect(brief.value.unknowns.join(' ')).toMatch(/omitted.*contrary context/iu);
 expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
});
