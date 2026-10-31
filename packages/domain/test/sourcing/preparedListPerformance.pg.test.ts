import {createHash,randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeFileSync} from 'node:fs';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type QueryResultRowLike,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {listPreparedProspects} from '../../sourcing/preparedProspects.ts';
import {preparedProspectsBusinessSnapshot} from './preparedProspectsPgFixture.ts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());

/** Synthetic retained-input fixture only: no capture, model or qualification is
 * executed, and its rows are not a measurement of real prospect yield. */
async function retained(index:number){
 const website=`https://list-perf-${index}-${randomUUID()}.example.test/`,url=website.replace('https://','https://www.')+'management';
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),{firmName:`Fictional list performance ${index}`,website,sourceUrl:website,locality:'Boston',region:'MA',signal:'fit_only',evidence:'Synthetic retained list performance input',observedOn:new Date().toISOString().slice(0,10),preparedBy:'Controlled list performance fixture'}));if(!saved.ok)throw Error(saved.reason);
 const candidateId=saved.value.id,runId=randomUUID(),id=randomUUID(),retrievedAt=new Date(Date.now()-1000).toISOString();
 const blocks=[{id:'context',text:'Our property management team manages residential homes and coordinates tenant maintenance requests.'}],contentHash=createHash('sha256').update(JSON.stringify(blocks)).digest('hex');
 const source={id,url,contentHash,relevantTextHash:contentHash,retrievedAt,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks};
 const manifest={version:'prepared-source-association-v2',candidateId,candidateRevision:1,sourceUrl:website,pages:[{observationId:id,url,contentHash,relevantTextHash:contentHash,retrievedAt,redirectUrls:[website,url]}]};
 await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name,capture_policy_version)
 VALUES($1,$2,$3,1,$4,'qualification-context-v7','qualification-v5','none','prepared-source-association-v2')`,[seed.alpha.workspaceId,runId,candidateId,createHash('sha256').update(runId).digest('hex')]);
 await runtime.query("UPDATE sourcing_qualification_runs SET state='unavailable',reason='invalid_evidence',observations=$2::jsonb,prepared_capture=$3::jsonb,finished_at=clock_timestamp() WHERE id=$1",[runId,JSON.stringify([source]),JSON.stringify(manifest)]);
 return {candidateId,runId};
}
async function measure(){
 let queries=0,databaseMs=0;
 const groups=new Map<string,{calls:number;ms:number}>();
 const plans=new Map<string,{sql:string;values:readonly unknown[]|undefined}>();
 const family=(sql:string)=>sql.includes('calling_preparation_lock_held')?'capture_lifecycle':sql.includes('SELECT role,status FROM workspace_memberships')?'principal':sql.includes('SELECT id,source_reference,content_hash,retrieved_at,terms_allow_retention,retention_expires_at FROM evidence_items')?'capture_evidence':sql.includes(' AS denied,')?'capture_limit':sql.includes('preparation_context')?'priority_order':sql.includes('visible WHERE id=ANY')?'inventory_rows':sql.includes('FOR SHARE')?'row_locks':sql.includes('r.observations,r.facts,c.payload,')?'shared_snapshot':sql.includes('r.capture_policy_version,r.state AS capture_state')?'capture_current':'other';
 const session:SessionQueryable={query:async<Row extends QueryResultRowLike>(sql:string,values?:readonly unknown[])=>{queries++;const at=performance.now();try{return await runtime.query<Row>(sql,values);}finally{const ms=performance.now()-at;databaseMs+=ms;const label=family(sql),group=groups.get(label)??{calls:0,ms:0};group.calls++;group.ms+=ms;groups.set(label,group);if(['priority_order','inventory_rows'].includes(label)&&!plans.has(label))plans.set(label,{sql,values});}}};
 const at=performance.now(),result=await withTransaction(session,()=>listPreparedProspects(ctx(session),{offset:0}));
 return {queries,databaseMs,elapsedMs:performance.now()-at,result,groups:Object.fromEntries(groups),plans};
}
it('keeps the real app_runtime list50 database roundtrips bounded independently of fifty current v2 source associations',async()=>{
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const targets=[await retained(0)],one=await measure();
 expect(one.result).toMatchObject({ok:true,value:{prospects:[{target:targets[0]}],hasMore:false}});
 for(let i=1;i<50;i++)targets.push(await retained(i));
 const before=await preparedProspectsBusinessSnapshot(ctx()),fifty=await measure(),repeat=await measure();
 for(const sample of [fifty,repeat]){expect(sample.result.ok).toBe(true);if(!sample.result.ok)throw Error(sample.result.reason);expect(sample.result.value.prospects).toHaveLength(50);expect(sample.result.value.prospects.every(p=>p.state==='prepared')).toBe(true);expect(new Set(sample.result.value.prospects.map(p=>p.target.candidateId))).toEqual(new Set(targets.map(t=>t.candidateId)));}
 expect(repeat.queries).toBe(fifty.queries);expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(before);
 console.log('PREPARED_LIST_PERFORMANCE',JSON.stringify({one:{queries:one.queries,databaseMs:one.databaseMs,elapsedMs:one.elapsedMs},fifty:{queries:fifty.queries,databaseMs:fifty.databaseMs,elapsedMs:fifty.elapsedMs},repeat:{queries:repeat.queries,databaseMs:repeat.databaseMs,elapsedMs:repeat.elapsedMs}}));
 const token=randomUUID();
 await runtime.query(`INSERT INTO sourcing_candidates(workspace_id,identity_key,payload)
 SELECT $1,encode(sha256(convert_to($2::text||n::text,'UTF8')),'hex'),jsonb_build_object('firmName','Fictional retained background '||n,'website','https://background-'||$2::text||'-'||n||'.example.test/','sourceUrl','https://background-'||$2::text||'-'||n||'.example.test/','locality','Boston','region','MA','signal','fit_only','evidence','Controlled empty retained inventory','observedOn',to_char(current_date,'YYYY-MM-DD'),'preparedBy','Controlled list cardinality fixture')
 FROM generate_series(1,3139) n`,[seed.alpha.workspaceId,token]);
 // Production-shaped unrelated audit volume must not be rescanned for every
 // retained candidate. These fictional events assert no source loss.
 await runtime.query(`INSERT INTO audit_events(workspace_id,actor_kind,action,subject_kind,subject_id,detail)
 SELECT $1,'system','fixture.unrelated','fixture',n::text,'{}'::jsonb FROM generate_series(1,6433) n`,[seed.alpha.workspaceId]);
 const largeBefore=await preparedProspectsBusinessSnapshot(ctx()),large=await measure();
 expect(large.result.ok).toBe(true);if(!large.result.ok)throw Error(large.result.reason);expect(large.result.value.prospects).toHaveLength(50);expect(new Set(large.result.value.prospects.map(p=>p.target.candidateId))).toEqual(new Set(targets.map(t=>t.candidateId)));expect(await preparedProspectsBusinessSnapshot(ctx())).toEqual(largeBefore);
 const explain:Record<string,unknown>={};
 for(const [name,query] of large.plans){const plan=(await runtime.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) '+query.sql,query.values)).rows[0]?.['QUERY PLAN'];explain[name]=plan;}
 const metrics=(sample:Awaited<ReturnType<typeof measure>>)=>({queries:sample.queries,databaseMs:sample.databaseMs,elapsedMs:sample.elapsedMs,groups:sample.groups});
 const artifact=process.env['FSS_PREPARED_LIST_METRICS_FILE'];if(artifact)writeFileSync(artifact,JSON.stringify({one:metrics(one),fifty:metrics(fifty),repeat:metrics(repeat),large:metrics(large),inventoryCandidates:3189,explain},null,2),{mode:0o600});
 expect(fifty.queries).toBeLessThanOrEqual(one.queries+20);
 for(const plan of Object.values(explain)){
  const scans:{loops:number}[]=[],auditScans:{loops:number}[]=[];
  const visit=(value:unknown)=>{if(!value||typeof value!=='object')return;const node=value as Record<string,unknown>;if(node['Relation Name']==='sourcing_candidates'&&node['Alias']==='lost')scans.push({loops:Number(node['Actual Loops'])});if(node['Relation Name']==='audit_events')auditScans.push({loops:Number(node['Actual Loops'])});for(const child of Array.isArray(node['Plans'])?node['Plans']:[])visit(child);};
  visit((plan as {Plan:unknown}[])[0]?.Plan);expect(scans.length).toBeGreaterThan(0);expect(scans.reduce((n,scan)=>n+scan.loops,0)).toBeLessThanOrEqual(1);
  expect(auditScans.length).toBeGreaterThan(0);expect(auditScans.reduce((n,scan)=>n+scan.loops,0)).toBeLessThanOrEqual(1);
 }
},90000);
