import {createHash,randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {seedDiscoveryCandidate} from './support/discoverySeed.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {listManualProspects,recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {MANUAL_SOURCE_LOSS_ACTION} from '../../sourcing/manualProspectSourceLoss.ts';
import {runRetentionBatch} from '../../retention/runs.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from './support/manualProspectFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),runtime);
const list=()=>withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}));
const feedback=(id:string)=>withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:id,expectedRevision:1,state:'kept'}));
async function candidate(kind:'ordinary'|'discovery',key:string,url:string){
 const input=manualDiscoveryFixture(key);input.row.source.sourceUrl=url;input.row.observations[0]!.sourceUrl=url;input.origins[0]!.source.sourceUrl=url;
 const saved=kind==='discovery'?{ok:true as const,value:await withTransaction(runtime,()=>seedDiscoveryCandidate(ctx(),input))}:await withTransaction(runtime,()=>saveCandidate(ctx(),{...manualOrdinaryFixture(),firmName:key,sourceUrl:url}));
 if(!saved.ok)throw Error(saved.reason);return saved.value.id;
}
async function snapshot(){const results=[];for(const table of ['sourcing_candidates','sourcing_candidate_discovery_origins','sourcing_qualification_runs','jobs','firms','contacts','phone_routes','outbound_messages','sequence_enrollments'])results.push({table,rows:(await runtime.query(`SELECT to_jsonb(t) row FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows});return results;}
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');});
afterAll(async()=>{await db.drop();});
it.each([['ordinary',true],['ordinary',false],['discovery',true],['discovery',false]] as const)('does not resurrect %s list or feedback after the real expired-evidence sweep, retainable=%s',async(kind,retainable)=>{
 const url=`https://retention.example.test/${kind}/${retainable}`,id=await candidate(kind,`Expired ${kind}`,url),other=await candidate('ordinary','Still permitted',`https://allowed.example.test/${kind}`);
 await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,$5,now()-interval '1 second')`,[seeded.alpha.workspaceId,crm.alpha.firmId,url,(kind==='ordinary'?'a':'b').repeat(64),retainable]);
 const before=await snapshot();expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{candidateId:other}]}});expect(await feedback(id)).toMatchObject({ok:false,reason:'candidate_unavailable'});expect(await feedback(other)).toMatchObject({ok:true});
 const worker=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'system',component:'worker'}),runtime),period=`2026-10-${kind==='ordinary'?(retainable?'20':'21'):(retainable?'22':'23')}`;
 const result=await withTransaction(runtime,()=>runRetentionBatch(worker,{dataKind:'research_evidence',period,limit:50}));expect(result.outcome).toBe('swept');expect(result.detail['evidence_items']).toBe(1);expect((await runtime.query('SELECT * FROM evidence_items')).rows).toEqual([]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{candidateId:other}]}});expect(await feedback(id)).toMatchObject({ok:false,reason:'candidate_unavailable'});expect(await feedback(other)).toMatchObject({ok:true});expect(await snapshot()).toEqual(before);
 const hash=createHash('sha256').update(url.replace(/\/+$/u,'')).digest('hex'),markers=()=>runtime.query('SELECT subject_kind,subject_id,detail FROM audit_events WHERE workspace_id=$1 AND action=$2 AND subject_id=$3',[seeded.alpha.workspaceId,MANUAL_SOURCE_LOSS_ACTION,hash]);
 expect((await markers()).rows).toEqual([{subject_kind:'sourcing_source_hash',subject_id:hash,detail:{}}]);
 expect(await withTransaction(runtime,()=>runRetentionBatch(worker,{dataKind:'research_evidence',period,limit:50}))).toMatchObject({replayed:true,rowsDeleted:0});expect((await markers()).rows).toHaveLength(1);
 const beta=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),runtime);
 const allowed=await withTransaction(runtime,()=>saveCandidate(beta,{...manualOrdinaryFixture(),firmName:'Other workspace same exact source',sourceUrl:url}));if(!allowed.ok)throw Error(allowed.reason);
 expect(await withTransaction(runtime,()=>listManualProspects(beta,{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{candidateId:allowed.value.id}]}});
 await db.session.query('DELETE FROM sourcing_candidates WHERE id=$1',[id]);const replacement=await candidate(kind,'Re-retained same source',`${url}/`);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{candidateId:other}]}});expect(await feedback(replacement)).toMatchObject({ok:false,reason:'candidate_unavailable'});
});
it.each([['ordinary','ordinary','payload'],['ordinary','discovery','payload'],['ordinary','ordinary','lastSuccess'],['discovery','ordinary','origins'],['ordinary','ordinary','visibleLastSuccess']] as const)('refuses shared source from lost %s to visible %s via %s, not unrelated rows',async(lostKind,visibleKind,association)=>{
 const shared=`https://lost.example.test/${randomUUID()}`,lost=await candidate(lostKind,'Known unavailable',association==='lastSuccess'?'https://different.example.test/':shared),visible=await candidate(visibleKind,'Same restricted source',association==='visibleLastSuccess'?'https://visible-current.example.test/':shared),other=await candidate('ordinary','Unrelated permitted','https://unrelated.example.test/');
 const now=new Date().toISOString();await db.session.query('UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE id=$1',[lost,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:now,state:'unavailable',reason:'source_not_permitted',checkedAt:now,lastSuccess:association==='lastSuccess'?{url:shared,contentHash:'c'.repeat(64),retrievedAt:now,excerpt:'',quoteMatched:false,firstParty:false,truncated:false}:null})]);
 if(association==='visibleLastSuccess')await db.session.query('UPDATE sourcing_candidates SET source_check=$2::jsonb WHERE id=$1',[visible,JSON.stringify({checkId:randomUUID(),jobId:randomUUID(),requestedAt:now,state:'checked',reason:null,checkedAt:now,lastSuccess:{url:shared,contentHash:'d'.repeat(64),retrievedAt:now,excerpt:'',quoteMatched:false,firstParty:false,truncated:false}})]);
 const before=await snapshot();expect(await list()).toMatchObject({ok:true,value:{prospects:[{candidateId:other}]}});expect(await feedback(visible)).toMatchObject({ok:false,reason:'candidate_unavailable'});expect(await feedback(lost)).toMatchObject({ok:false,reason:'candidate_unavailable'});expect(await feedback(other)).toMatchObject({ok:true});expect(await snapshot()).toEqual(before);
});
