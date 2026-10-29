import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {listProspectPriority,saveProspectPriority,considerProspectPriority,currentProspectPriorityAuthority,readProspectPriorityLearning} from '../../sourcing/prospectPriority.ts';
import {sweepProspectPriorities} from '../../sourcing/prospectPriorityRetention.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
import {prospectPriorityListInputSchema} from '@fss/contracts';
let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const ctx=(role:'admin'|'salesperson'='admin',session=runtime)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha[role].userId,role}),session);
const list=(offset=0,viewRevision?:string)=>withTransaction(runtime,()=>listProspectPriority(ctx(),{state:'all',offset,...(viewRevision?{viewRevision}:{})}));
async function candidate(index=1){const result=await withTransaction(runtime,()=>saveCandidate(ctx(),manualOrdinaryFixture(index)));if(!result.ok)throw Error(result.reason);return result.value.id;}
const save=(id:string,index=1,revision=0,fit:'positive'|'negative'|'unknown'='positive')=>withTransaction(runtime,()=>saveProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:revision,fit,value:'unknown',timing:'unknown',roles:[],sourceUrl:manualOrdinaryFixture(index).sourceUrl}));
const consider=(id:string,revision=0,disposition:'considered'|'selected'='considered')=>withTransaction(runtime,async()=>{const input={candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:revision,disposition};const r=await considerProspectPriority(ctx(),input);if(r.ok)await currentProspectPriorityAuthority(ctx(),{...input,considerationId:r.value.considerationId},async()=>true);return r;});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await db.drop();});
it('retains unknowns and wrong-fit records without qualification, contact or acquisition side effects',async()=>{
 const a=await candidate(),b=await candidate(2);expect(await save(b,2,0,'negative')).toMatchObject({ok:true});
 const page=await list();expect(page).toMatchObject({ok:true,value:{prospects:[{prospect:{candidateId:a,qualification:'unverified',contactAuthority:'not_granted'},priority:{fit:'unknown',roles:[],roleState:'unknown',nextAction:'review_fit'}},{prospect:{candidateId:b},priority:{band:'wrong_fit'}}]}});
 for(const table of ['firms','contacts','phone_routes','jobs','outbound_messages','sourcing_qualification_runs'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('globally interleaves four supported then one ordinary, preserves pagination context and rotates considered records',async()=>{
 const ids:string[]=[];for(let i=1;i<=56;i++)ids.push(await candidate(i));
 for(let i=0;i<8;i++)expect(await save(ids[i]!,i+1)).toMatchObject({ok:true});
 const first=await list();if(!first.ok)throw Error(first.reason);expect(first.value.prospects.slice(0,5).map(p=>p.priority.band)).toEqual(['evidence_supported','evidence_supported','evidence_supported','evidence_supported','ordinary']);
 expect(first.value.prospects).toHaveLength(50);expect(first.value.hasMore).toBe(true);
 const second=await list(50,first.value.viewRevision);expect(second.ok&&second.value.prospects).toHaveLength(6);
 expect(prospectPriorityListInputSchema.safeParse({state:'all',offset:50}).success).toBe(false);
 expect(await consider(ids[0]!,1)).toMatchObject({ok:true});
 expect(await list(50,first.value.viewRevision)).toMatchObject({ok:false,reason:'view_changed'});
 const after=await list();if(!after.ok)throw Error(after.reason);expect(after.value.prospects[0]?.prospect.candidateId).not.toBe(ids[0]);
 expect((await runtime.query('SELECT count(*)::integer n FROM sourcing_prospect_considerations')).rows[0]?.['n']).toBe(1);
});
it('same URL with changed source identity withholds assessment, allows unknown consideration and has real CAS revision',async()=>{
 const id=await candidate();await save(id);
 await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"available","lastSuccess":{"url":"https://source.example.test/ordinary-1","contentHash":"changed"}}' WHERE id=$1`,[id]);
 const page=await list();expect(page).toMatchObject({ok:true,value:{prospects:[{priority:{fit:'unknown',assessmentRevision:1,reasons:[]}}]}});
 expect(await consider(id,1,'selected')).toMatchObject({ok:true});
 expect((await runtime.query('SELECT fit FROM sourcing_prospect_considerations')).rows).toEqual([{fit:'unknown'}]);
 expect(await save(id,1,1)).toMatchObject({ok:true,value:{assessmentRevision:2}});
});
it('expired optional assessment never blocks raw consideration and normal retention deletes expired metadata',async()=>{
 const id=await candidate();await save(id);
 await db.session.query("UPDATE sourcing_prospect_priorities SET decided_at=statement_timestamp()-interval '31 days',expires_at=statement_timestamp()-interval '1 day' WHERE candidate_id=$1",[id]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{priority:{fit:'unknown',assessmentRevision:1}}]}});
 expect(await consider(id,1,'selected')).toMatchObject({ok:true});
 expect(await withTransaction(runtime,()=>sweepProspectPriorities(ctx(),{limit:50}))).toBe(1);
});
it('refuses unsupported role IDs, stale revisions, foreign source and post-wait principal loss',async()=>{
 const id=await candidate();expect(await save(id,1,2)).toMatchObject({ok:false,reason:'assessment_changed'});
 await expect(withTransaction(runtime,()=>listProspectPriority(ctx('salesperson'),{state:'all',offset:0}))).rejects.toThrow();
 expect(await withTransaction(runtime,()=>saveProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:0,fit:'positive',value:'unknown',timing:'unknown',roles:[],sourceUrl:'https://wrong.example.test/'}))).toMatchObject({ok:false,reason:'source_unavailable'});
 await expect(withTransaction(runtime,()=>saveProspectPriority(ctx(),{candidateId:id,expectedCandidateRevision:1,expectedAssessmentRevision:0,fit:'positive',value:'unknown',timing:'unknown',roles:[],sourceUrl:manualOrdinaryFixture().sourceUrl},async()=>false))).rejects.toThrow();
 expect((await runtime.query('SELECT * FROM sourcing_prospect_priorities')).rows).toEqual([]);
});
it('preserves minimal selected context through benign candidate revision progression and reports honest windows',async()=>{
 const id=await candidate();await save(id);await consider(id,1,'selected');
 const sourceBefore=(await runtime.query('SELECT source_key FROM sourcing_prospect_considerations WHERE candidate_id=$1',[id])).rows[0]?.['source_key'];
 await runtime.query("UPDATE sourcing_candidates SET revision=revision+1,payload=jsonb_set(payload,'{firmName}',to_jsonb('Corrected same-source name'::text)) WHERE id=$1",[id]);
 expect((await runtime.query('SELECT source_key FROM sourcing_prospect_considerations WHERE candidate_id=$1',[id])).rows[0]?.['source_key']).toBe(sourceBefore);
 expect((await runtime.query('SELECT candidate_revision,fit FROM sourcing_prospect_considerations')).rows).toEqual([{candidate_revision:1,fit:'positive'}]);
 const from=new Date(Date.now()-10000).toISOString(),to=new Date(Date.now()+10000).toISOString();
 const report=await withTransaction(runtime,()=>readProspectPriorityLearning(ctx(),{from,to}));
 expect(report).toMatchObject({ok:true,value:{considered:1,selected:1,observations:{unknown:1},appropriatePerson:'unavailable',paidAdoption:'unavailable',retention:'unavailable',cohorts:[{fit:'positive',selected:1}]}});
 await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[id]);
 expect((await runtime.query('SELECT * FROM sourcing_prospect_considerations')).rows).toEqual([]);
});

it('drops optional phone revoked during a later authority await while preserving the raw prospect',async()=>{
 const id=await candidate();const evidence=manualPhoneFixture(manualOrdinaryFixture().sourceUrl);
 const run=await seedManualPhoneRun(runtime,seed.alpha.workspaceId,id,evidence);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{prospect:{observedPhone:'+12145550123'}}]}});
 let calls=0;
 const answer=await withTransaction(runtime,()=>listProspectPriority(ctx(),{state:'all',offset:0},async()=>{
  calls++;if(calls===2){await runtime.query('SELECT pg_sleep(0.01)');await runtime.query('DELETE FROM sourcing_qualification_runs WHERE id=$1',[run]);}return true;
 }));
 expect(answer).toMatchObject({ok:true,value:{prospects:[{prospect:{candidateId:id,observedPhone:null,phoneEvidence:{state:'not_extracted'}}}]}});
});
