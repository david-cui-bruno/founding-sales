import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '@fss/domain/db/testing/testDatabase.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '@fss/domain/test/db/support/fixtures.ts';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction,type SessionQueryable} from '@fss/domain/db/queryable.ts';
import {saveCandidate} from '@fss/domain/sourcing/candidates.ts';
import {requestQualification} from '@fss/domain/sourcing/qualificationStore.ts';
import {updateResearchSettings} from '@fss/domain/research/settings.ts';
import {QUALIFICATION_MODEL_NAME} from '@fss/domain/sourcing/qualificationModel.ts';
import {qualificationRequeuePreparedCommand} from '../src/tools/fss/qualificationRequeuePrepared.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const launch={launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/fixture'};
const ctx=()=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),runtime);
const options=(extra:Record<string,string>={})=>({'--workspace-id':seed.alpha.workspaceId,'--approval-ref':'David, 1 Nov 2026, re-land AI judgment',...extra});
const command=(extra:Record<string,string>={},switches:readonly string[]=[])=>qualificationRequeuePreparedCommand({session:runtime,launch,options:options(extra),switches:new Set(switches)});
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
afterAll(async()=>db?.drop());
beforeEach(async()=>{
 for(const table of ['sourcing_candidates','jobs','daily_counters','research_settings'])await runtime.query(`DELETE FROM ${table}`);
 await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:true,dailyFirmCeiling:1000,dailyCostCeilingCents:2500,monthlyCostCeilingCents:40000,maxPagesPerFirm:4,maxPageBytes:1000000,modelName:'claude-haiku-4-5'}));
});
/** A prepared candidate whose latest finished run was made by `model`, yesterday. */
async function prepared(model:string,status:'kept'|'dismissed'='kept'){
 const website=`https://requeue-${randomUUID()}.example.test/`;
 const saved=await withTransaction(runtime,()=>saveCandidate(ctx(),{firmName:'Requeue Property Management',website,sourceUrl:website,locality:'Columbus',region:'OH',signal:'fit_only',evidence:'Fictional prepared candidate',observedOn:'2026-10-31',preparedBy:'Fixture'}));
 if(!saved.ok)throw Error(saved.reason);
 const requested=await withTransaction(runtime,()=>requestQualification(ctx(),{candidateId:saved.value.id,expectedRevision:1},{enqueue:false}));if(!requested.ok)throw Error(requested.reason);
 await runtime.query("UPDATE sourcing_qualification_runs SET model_name=$2,fingerprint=encode(sha256(random()::text::bytea),'hex'),state='unavailable',reason='invalid_evidence',requested_at=requested_at-interval '1 day',deadline_at=deadline_at-interval '1 day',finished_at=now()-interval '1 day' WHERE id=$1",[requested.value.runId,model]);
 await runtime.query("UPDATE sourcing_candidates SET status=$2,next_source_check_at=CASE WHEN $2='kept' THEN now() END WHERE id=$1",[saved.value.id,status]);
 await runtime.query('DELETE FROM daily_counters');
 return saved.value.id;
}
const audits=async()=>(await runtime.query<{detail:Record<string,unknown>}>("SELECT detail FROM audit_events WHERE action='sourcing.qualification_requeued' ORDER BY occurred_at")).rows.map(row=>row.detail);
const qualifyJobs=async()=>Number((await db.session.query<{n:string}>("SELECT count(*) n FROM jobs WHERE kind='sourcing.qualify'")).rows[0]!.n);

it('requires the audited launcher and an approval reference, and a dry run only counts',async()=>{
 await prepared('claude-haiku-4-5');
 expect(await qualificationRequeuePreparedCommand({session:runtime,options:options(),switches:new Set()})).toMatchObject({ok:false,reason:'launcher_unknown'});
 expect(await qualificationRequeuePreparedCommand({session:runtime,launch,options:{'--workspace-id':seed.alpha.workspaceId},switches:new Set()})).toMatchObject({ok:false,reason:'invalid_options'});
 expect(await command({'--limit':'1001'})).toMatchObject({ok:false,reason:'invalid_options'});
 expect(await command({},['--dry-run'])).toEqual({ok:true,value:{dryRun:true,eligible:1,limit:1000,judgmentModels:[QUALIFICATION_MODEL_NAME]}});
 expect(await qualifyJobs()).toBe(0);expect(await audits()).toEqual([]);
});
it('re-qualifies only prepared candidates whose latest run lacks the judgment, once, with one audit per invocation',async()=>{
 const old=[await prepared('claude-haiku-4-5'),await prepared('none')];
 await prepared(QUALIFICATION_MODEL_NAME);await prepared('claude-haiku-4-5','dismissed');
 expect(await command()).toEqual({ok:true,value:{dryRun:false,eligible:2,limit:1000,requested:2,stoppedBy:null,refusals:{},remaining:0,judgmentModels:[QUALIFICATION_MODEL_NAME]}});
 expect(await qualifyJobs()).toBe(2);
 const latest=(await runtime.query<{candidate_id:string;model_name:string;state:string}>(`SELECT DISTINCT ON (candidate_id) candidate_id,model_name,state FROM sourcing_qualification_runs WHERE candidate_id=ANY($1::uuid[]) ORDER BY candidate_id,requested_at DESC`,[old])).rows;
 expect(latest.map(run=>[run.model_name,run.state])).toEqual([[QUALIFICATION_MODEL_NAME,'pending'],[QUALIFICATION_MODEL_NAME,'pending']]);
 // A requested run is not selected again.
 expect(await command()).toMatchObject({ok:true,value:{eligible:0,requested:0}});
 expect(await audits()).toEqual([expect.objectContaining({requested:2,approvalRef:'David, 1 Nov 2026, re-land AI judgment',launchedBy:launch.launchedBy,taskArn:launch.taskArn}),expect.objectContaining({requested:0})]);
});
it('stops at the existing daily firm ceiling and at a limit, leaving the rest for a later day',async()=>{
 for(let i=0;i<3;i++)await prepared('claude-haiku-4-5');
 expect(await command({'--limit':'1'})).toMatchObject({ok:true,value:{eligible:3,requested:1,stoppedBy:null,remaining:2}});
 await withTransaction(runtime,()=>updateResearchSettings(ctx(),{dailyFirmCeiling:2}));
 expect(await command()).toMatchObject({ok:true,value:{eligible:2,requested:1,stoppedBy:'daily_firm_ceiling',remaining:1}});
 await withTransaction(runtime,()=>updateResearchSettings(ctx(),{enabled:false}));
 expect(await command()).toMatchObject({ok:true,value:{eligible:1,requested:0,stoppedBy:'research_disabled'}});
 expect(await qualifyJobs()).toBe(2);
});
