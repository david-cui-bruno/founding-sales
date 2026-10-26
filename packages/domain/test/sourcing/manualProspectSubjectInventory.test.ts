import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {MANUAL_ACTIVITY_RAW_SQL} from '../../sourcing/manualProspectActivityAccess.ts';
import {readManualProspectSubject} from '../../sourcing/manualProspectRows.ts';
import {projectManualProspect,type ManualProspectRow} from '../../sourcing/manualProspectProjection.ts';
import {phoneDiscoveryContext} from '../../sourcing/prospectPhoneDiscoveryAuthority.ts';
import {requestProspectPhoneDiscovery,runProspectPhoneDiscovery} from '../../sourcing/prospectPhoneDiscovery.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from '../../sourcing/manualProspectSourceLoss.ts';
import type {PageFetchProvider} from '../../research/providers.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const count=2800;
const fixture=Array.from({length:count},(_,index)=>{
 const id=randomUUID(),discovery=index%2===1,raw=manualDiscoveryFixture(`inventory-${index}`);
 raw.row.website=`https://inventory-${index}.example.test/`;
 return {id,identity:createHash('sha256').update(`subject-inventory-${index}`).digest('hex'),payload:discovery?{kind:'discovery-v1',row:raw.row}:manualOrdinaryFixture(index+10000),origin:discovery?raw.origins[0]:null};
});
const ctx=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
interface PlanNode {
 'Node Type':string;'Actual Rows':number;'Actual Loops':number;
 'Relation Name'?:string;Alias?:string;Plans?:PlanNode[];
}
interface Plan extends Record<string,unknown> {Plan:PlanNode;'Execution Time':number}
function nodes(plan:PlanNode):PlanNode[] {return [plan,...(plan.Plans??[]).flatMap(nodes)];}
function work(plan:Plan):number {return nodes(plan.Plan).reduce((sum,node)=>sum+node['Actual Rows']*node['Actual Loops'],0);}
beforeAll(async()=>{
 db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 await withTransaction(runtime,async()=>{
  await runtime.query(`INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload)
   SELECT $1,id,identity,payload FROM jsonb_to_recordset($2::jsonb) AS f(id uuid,identity text,payload jsonb)`,[seed.alpha.workspaceId,JSON.stringify(fixture)]);
  await runtime.query(`INSERT INTO sourcing_candidate_discovery_origins(workspace_id,candidate_id,provider,release,record_id,source,source_metadata,licenses,notices)
   SELECT $1,id,origin->'source'->>'provider',origin->'source'->>'release',origin->'source'->>'recordId',origin->'source',origin->'sourceMetadata',origin->'licenses',origin->'notices'
   FROM jsonb_to_recordset($2::jsonb) AS f(id uuid,origin jsonb) WHERE origin IS NOT NULL AND origin<>'null'::jsonb`,[seed.alpha.workspaceId,JSON.stringify(fixture)]);
  await runtime.query("UPDATE sourcing_candidates SET source_check='{\"state\":\"unavailable\",\"reason\":\"source_unavailable\"}' WHERE id=$1",[fixture[count-2]!.id]);
  const firm=(await runtime.query<{id:string}>('INSERT INTO firms(workspace_id,name,assigned_user_id) VALUES($1,$2,$3) RETURNING id',[seed.alpha.workspaceId,'Synthetic inventory source custody',seed.alpha.admin.userId])).rows[0]!.id;
  await runtime.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at)
   SELECT $1,$2,'website','https://unrelated.example.test/evidence-'||i,encode(sha256(convert_to('synthetic-evidence-'||i,'UTF8')),'hex'),true,clock_timestamp()+interval '1 day' FROM generate_series(1,300) i`,[seed.alpha.workspaceId,firm]);
  await runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail)
   SELECT $1,'user',$2,$3,'sourcing_source_hash',encode(sha256(convert_to('https://unrelated.example.test/lost-'||i,'UTF8')),'hex'),'{}'::jsonb FROM generate_series(1,128) i`,[seed.alpha.workspaceId,seed.alpha.admin.userId,MANUAL_SOURCE_LOSS_ACTION]);
 });
 await db.session.query('ANALYZE sourcing_candidates');await db.session.query('ANALYZE sourcing_candidate_discovery_origins');await db.session.query('ANALYZE evidence_items');await db.session.query('ANALYZE audit_events');
 console.log('SUBJECT_INVENTORY_RESOURCE',JSON.stringify({database:db.name,template:process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],candidates:count,origins:count/2,evidence:300,sourceAudits:128}));
},60_000);
afterAll(async()=>{await db?.drop();console.log('SUBJECT_INVENTORY_DATABASE_DROPPED');});
it('exact ordinary/discovery authority matches old lookup with bounded subject work at 2800 retained records',async()=>{
 expect((await runtime.query('SELECT count(*)::int n FROM sourcing_candidates WHERE workspace_id=$1',[seed.alpha.workspaceId])).rows[0]?.['n']).toBe(count);
 for(const index of [0,1]) {
  const target=fixture[index]!,oldSql=`SELECT * FROM (${MANUAL_ACTIVITY_RAW_SQL}) permitted WHERE id=$3 AND revision=$4`,oldValues=[seed.alpha.workspaceId,'all',target.id,1];
  const beforeOld=performance.now(),oldRow=(await runtime.query<ManualProspectRow & {source_urls:string[]}>(oldSql,oldValues)).rows[0]!;
  const oldMilliseconds=performance.now()-beforeOld;expect(projectManualProspect(oldRow)).not.toBeNull();
  const captured:{text:string;values:readonly unknown[]|undefined}[]=[];
  const observed:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{captured.push({text,values});return await runtime.query<Row>(text,values);}};
  const beforeNew=performance.now(),subject=await readManualProspectSubject(ctx(observed),{candidateId:target.id,expectedRevision:1}),newMilliseconds=performance.now()-beforeNew;
  expect(subject).not.toBeNull();
  for(const field of ['id','revision','payload','origins','manual_state','source_urls'])expect(subject?.[field]).toEqual(oldRow[field]);
  expect(captured).toHaveLength(1);const exact=captured[0]!;
  const oldPlan=(await runtime.query<{'QUERY PLAN':Plan[]}>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+oldSql,oldValues)).rows[0]!['QUERY PLAN'][0]!;
  const newPlan=(await runtime.query<{'QUERY PLAN':Plan[]}>('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+exact.text,exact.values)).rows[0]!['QUERY PLAN'][0]!;
  const oldNodes=nodes(oldPlan.Plan),newNodes=nodes(newPlan.Plan),base=newNodes.filter(node=>node['Relation Name']==='sourcing_candidates'&&node.Alias==='c');
  expect(oldNodes.some(node=>node['Node Type']==='WindowAgg'&&node['Actual Rows']>2000)).toBe(true);
  expect(newNodes.some(node=>node['Node Type']==='WindowAgg')).toBe(false);expect(base.length).toBeGreaterThan(0);
  for(const node of base)expect(node['Actual Rows']*node['Actual Loops']).toBeLessThanOrEqual(1);
  expect(work(newPlan)).toBeLessThan(work(oldPlan));
  console.log('SUBJECT_INVENTORY_PLAN',JSON.stringify({kind:index===0?'ordinary':'discovery',oldMilliseconds,newMilliseconds,oldPlanMilliseconds:oldPlan['Execution Time'],newPlanMilliseconds:newPlan['Execution Time'],oldRowsWork:work(oldPlan),newRowsWork:work(newPlan),base,oldPlan,newPlan}));
 }
},120_000);
it('unchanged per-URL current-authority gates complete a controlled capture within the existing provider budget',async()=>{
 const target=fixture[0]!,context=await phoneDiscoveryContext(ctx(),target.id,1);expect(context).not.toBeNull();
 const request=await withTransaction(runtime,()=>requestProspectPhoneDiscovery(ctx(),{candidateId:target.id,expectedRevision:1}));if(!request.ok)throw Error(request.reason);
 let gates=0,providerMilliseconds=0;
 const pageFetch:PageFetchProvider={providerKey:'controlled-local-no-network',fetchPages:async input=>{
  const start=performance.now();expect(input.shouldContinue).toBeTypeOf('function');expect(input.mayFetchUrl).toBeTypeOf('function');
  // Exercise both unmodified callbacks for robots, the page and a discovered page.
  for(const url of [`${context!.website}robots.txt`,context!.website,`${context!.website}contact`]) {
   expect(await input.shouldContinue!()).toBe(true);expect(await input.mayFetchUrl!(url)).toBe(true);gates+=2;
  }
  providerMilliseconds=performance.now()-start;expect(providerMilliseconds).toBeLessThan(30_000);
  const body=new TextEncoder().encode('Office phone: (214) 555-0123');
  return {ok:true,costCents:0,value:{pages:[{url:`${context!.website}contact`,body,contentType:'text/plain',contentHash:createHash('sha256').update(body).digest('hex'),retrievedAt:new Date().toISOString(),firstParty:true}],skipped:{}}};
 }};
 await runProspectPhoneDiscovery(repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'system',component:'worker'}),runtime),{runId:request.value.runId},{pageFetch});
 expect(gates).toBe(6);
 const saved=(await runtime.query<{state:string;reason:string|null;content:{observations:{url:string;blocks:{text:string}[]}[]};dispatch_finished_at:Date|null}>('SELECT state,reason,content,dispatch_finished_at FROM sourcing_prospect_phone_discoveries WHERE id=$1',[request.value.runId])).rows[0]!;
 expect(saved.state).toBe('complete');expect(saved.reason).toBeNull();expect(saved.dispatch_finished_at).not.toBeNull();
 expect(saved.content.observations[0]?.url).toBe(`${context!.website}contact`);expect(saved.content.observations[0]?.blocks.some(block=>block.text.includes('(214) 555-0123'))).toBe(true);
 console.log('SUBJECT_INVENTORY_CONTROLLED_CAPTURE',JSON.stringify({candidates:count,gates,providerMilliseconds,state:saved.state}));
},60_000);
