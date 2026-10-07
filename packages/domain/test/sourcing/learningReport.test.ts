import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {withTransaction} from '../../db/queryable.ts';
import {createFirm} from '../../crm/firms.ts';
import {attachSourcingAttribution,attributeFirmInteraction} from '../../sourcing/attribution.ts';
import {readSourcingLearning,learningRatio} from '../../sourcing/learningReport.ts';
let db:TestDatabase;let seeded:TwoWorkspaces;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),db.session);
const tx=<T>(fn:()=>Promise<T>)=>withTransaction(db.session,fn);
const range=()=>({from:new Date(Date.now()-30*86400000).toISOString(),to:new Date(Date.now()+1000).toISOString(),asOf:new Date(Date.now()+1000).toISOString()});
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);});afterAll(async()=>db.drop());
async function firm(acquisition:'warm_intro'|'manual',hypothesis:string){const r=await tx(()=>createFirm(ctx(),{name:randomUUID(),assignedUserId:seeded.alpha.admin.userId}));if(!r.ok)throw new Error(r.reason);await tx(()=>attachSourcingAttribution(ctx(),{firmId:r.value.id,candidateId:null,qualificationRunId:null,queryId:null,hypothesis,policyVersion:'manual-v1',acquisition}));return r.value.id;}
async function call(firmId:string,outcome='no_answer',daysAgo=0){const id=(await db.session.query<{id:string}>(`INSERT INTO call_logs(workspace_id,firm_id,outcome,step_effect,occurred_at,actor_user_id) VALUES($1,$2,$3,'none',now()-($4*interval '1 day'),$5) RETURNING id`,[seeded.alpha.workspaceId,firmId,outcome,daysAgo,seeded.alpha.admin.userId])).rows[0]!.id;await tx(()=>attributeFirmInteraction(ctx(),{firmId,kind:'call',subjectId:id}));return id;}
it('counts firms once, keeps warm referrals separate, and does not turn no answer into rejection',async()=>{
 const warm=await firm('warm_intro','referral');await call(warm,'interested');await call(warm,'interested');
 const manual=await firm('manual','research');await call(manual);
 const report=await tx(()=>readSourcingLearning(ctx(),range()));
 expect(report.cohorts.find(c=>c.acquisition==='warm_intro')).toMatchObject({firms:1,contacted:1,reached:1,interactions:{answeredCalls:2,confirmedPainCalls:0},qualified:0,won:0});
 expect(report.cohorts.find(c=>c.acquisition==='manual')).toMatchObject({firms:1,reached:0,unreached:1});
 expect(report.maturity.find(b=>b.ageBand==='0–6 days')?.firms).toBe(2);
 expect(learningRatio(0,0)).toBeNull();expect(learningRatio(1,2)).toBe(0.5);
});
it('uses accepted corrections, does not claim pain from interest, and excludes outcomes after the cutoff',async()=>{
 const f=await firm('manual','correction');const id=await call(f,'interested');
 const before=range();await db.session.query("UPDATE call_logs SET outcome='no_answer' WHERE workspace_id=$1 AND id=$2",[seeded.alpha.workspaceId,id]);
 const report=await tx(()=>readSourcingLearning(ctx(),before));expect(report.cohorts.find(c=>c.hypothesis==='correction')).toMatchObject({reached:0,confirmedPain:0});
 const cutoff=new Date(Date.now()-86400000).toISOString();expect((await tx(()=>readSourcingLearning(ctx(),{...range(),to:cutoff,asOf:cutoff}))).cohorts).toHaveLength(0);
});
it('does not expose another workspace or unassigned firms',async()=>{
 const other=repositoryContext(workspaceScope(seeded.beta.workspaceId,{kind:'user',userId:seeded.beta.admin.userId,role:'admin'}),db.session);
 expect((await tx(()=>readSourcingLearning(other,range()))).cohorts).toHaveLength(0);
});
it('freezes cold membership across extra signals and merges, and withdraws corrected pain feedback',async()=>{
 const {saveCandidate}=await import('../../sourcing/candidates.ts');const {requestQualification}=await import('../../sourcing/qualificationStore.ts');const {addPhoneRoute}=await import('../../crm/routes.ts');const {mergeFirms}=await import('../../crm/merges.ts');const {recordingSuppressionJournal}=await import('../../suppression/journal.ts');
 const created=await tx(()=>createFirm(ctx(),{name:'Cold source',assignedUserId:seeded.alpha.admin.userId}));if(!created.ok)throw new Error(created.reason);const f=created.value.id;
 const source=async(hypothesis:string)=>{const website=`https://source-${randomUUID()}.example.test/`;const candidate=await tx(()=>saveCandidate(ctx(),{firmName:'Cold source',website,locality:'Dallas',region:'TX',signal:'fit_only',sourceUrl:website,evidence:'Fixture only',observedOn:'2026-10-05',preparedBy:'Fixture'}));if(!candidate.ok)throw new Error(candidate.reason);const run=await tx(()=>requestQualification(ctx(),{candidateId:candidate.value.id,expectedRevision:1}));if(!run.ok)throw new Error(run.reason);const route=await tx(()=>addPhoneRoute(ctx(),{firmId:f,e164:'+12145550122',source:'website'}));if(!route.ok)throw new Error(route.reason);await db.session.query('INSERT INTO sourcing_admissions(workspace_id,candidate_id,run_id,firm_id,route_id) VALUES($1,$2,$3,$4,$5)',[seeded.alpha.workspaceId,candidate.value.id,run.value.runId,f,route.value.id]);await tx(()=>attachSourcingAttribution(ctx(),{firmId:f,candidateId:candidate.value.id,qualificationRunId:run.value.runId,queryId:'dfw',hypothesis,policyVersion:'qualification-v2',acquisition:'cold_sourced'}));return {candidateId:candidate.value.id,runId:run.value.runId};};
 const first=await source('operational_burden');await call(f,'interested');await source('help_request');await call(f,'interested');
 await db.session.query("INSERT INTO sourcing_feedback(workspace_id,candidate_id,run_id,code) VALUES($1,$2,$3,'real_pain')",[seeded.alpha.workspaceId,first.candidateId,first.runId]);
 let report=await tx(()=>readSourcingLearning(ctx(),range()));expect(report.cohorts.filter(c=>c.acquisition==='cold_sourced')).toHaveLength(1);expect(report.cohorts.find(c=>c.acquisition==='cold_sourced')).toMatchObject({firms:1,hypothesis:'operational_burden',confirmedPain:1,interactions:{answeredCalls:2,confirmedPainCalls:0}});
 await db.session.query("INSERT INTO sourcing_feedback(workspace_id,candidate_id,run_id,code) VALUES($1,$2,$3,'not_relevant')",[seeded.alpha.workspaceId,first.candidateId,first.runId]);
 const target=await firm('manual','merge');expect((await tx(()=>mergeFirms(ctx(),{sourceFirmId:f,targetFirmId:target,journal:recordingSuppressionJournal()}))).ok).toBe(true);
 report=await tx(()=>readSourcingLearning(ctx(),range()));expect(report.cohorts.find(c=>c.acquisition==='cold_sourced')).toMatchObject({firms:1,confirmedPain:0});expect(report.firms.filter(x=>x.firmId===target)).toHaveLength(1);expect(report.firms.some(x=>x.firmId===f)).toBe(false);
 const sales=repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.salesperson.userId,role:'salesperson'}),db.session);expect((await tx(()=>readSourcingLearning(sales,range()))).firms).toHaveLength(0);
});
it('counts explicitly confirmed pain on an answered call without needing a meeting, and withdraws corrections',async()=>{
 const {saveCallNeed,readCallNeed}=await import('../../sourcing/callNeed.ts');
 const f=await firm('manual','call-pain'),id=await call(f,'interested');
 let view=await readCallNeed(ctx(),{callLogId:id});expect(view).toMatchObject({answer:'unknown',revision:0,sourceRevision:0});
 const saved=await tx(()=>saveCallNeed(ctx(),{callLogId:id,expectedRevision:0,expectedSourceRevision:0,answer:'yes',commandId:randomUUID()}));expect(saved.ok).toBe(true);
 let report=await tx(()=>readSourcingLearning(ctx(),range()));expect(report.cohorts.find(c=>c.hypothesis==='call-pain')).toMatchObject({confirmedPain:1,interactions:{answeredCalls:1,confirmedPainCalls:1},booked:0});
 expect((await tx(()=>saveCallNeed(ctx(),{callLogId:id,expectedRevision:1,expectedSourceRevision:0,answer:'no',commandId:randomUUID()}))).ok).toBe(true);
 report=await tx(()=>readSourcingLearning(ctx(),range()));expect(report.cohorts.find(c=>c.hypothesis==='call-pain')?.interactions.confirmedPainCalls).toBe(0);
 await tx(()=>saveCallNeed(ctx(),{callLogId:id,expectedRevision:2,expectedSourceRevision:0,answer:'yes',commandId:randomUUID()}));
 await db.session.query("INSERT INTO audit_events(workspace_id,actor_kind,actor_user_id,action,subject_kind,subject_id,detail) VALUES($1,'user',$2,'call.outcome_corrected','call_log',$3,'{}')",[seeded.alpha.workspaceId,seeded.alpha.admin.userId,id]);
 view=await readCallNeed(ctx(),{callLogId:id});expect(view).toMatchObject({answer:'unknown',sourceRevision:1,stale:true});
 expect(await tx(()=>saveCallNeed(ctx(),{callLogId:id,expectedRevision:3,expectedSourceRevision:0,answer:'yes',commandId:randomUUID()}))).toEqual({ok:false,reason:'source_changed'});
 report=await tx(()=>readSourcingLearning(ctx(),range()));expect(report.cohorts.find(c=>c.hypothesis==='call-pain')?.interactions.confirmedPainCalls).toBe(0);
});
