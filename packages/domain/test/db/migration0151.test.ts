import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {applyMigrations,readAppliedSchemaVersion} from '../../db/migrationRunner.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {PREPARED_SOURCE_IDENTITY_CONSTRAINT_CASES} from './support/preparedSourceIdentityCases.ts';
import {reserveAttempt,markCalling} from '../../research/reservations.ts';
import {withTransaction} from '../../db/queryable.ts';
import {ensureTargetingPolicy} from '../../sourcing/targetingProposals.ts';
let db:Awaited<ReturnType<typeof createTestDatabase>>,seed:Awaited<ReturnType<typeof seedTwoWorkspaces>>,runtime:Awaited<ReturnType<typeof db.appRuntimeSession>>,before:unknown;
const candidate=randomUUID(),run=randomUUID(),attempt=randomUUID();
async function retained(){
 const result:Record<string,unknown>={};
 for(const table of ['sourcing_candidates','sourcing_qualification_runs','sourcing_targeting_versions','sourcing_discovery_settings','sourcing_search_account','sourcing_discovery_attempts','sourcing_discovery_hits','workspace_settings','research_settings','daily_counters','provider_reservations','provider_ledger'])
  result[table]=(await db.session.query(`SELECT (to_jsonb(t)-'producer_version'-'prepared_identity')::text value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows;
 return result;
}
beforeAll(async()=>{
 db=await createTestDatabase({throughVersion:150});seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();const w=seed.alpha.workspaceId;
 const ctx=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),runtime);
 await runtime.query("INSERT INTO sourcing_candidates(workspace_id,id,identity_key,payload) VALUES($1,$2,repeat('a',64),$3::jsonb)",[w,candidate,JSON.stringify({firmName:'Home | Old PM',website:'https://old-identity.example.test/',sourceUrl:'https://old-identity.example.test/',locality:'Boston',region:'MA',signal:'fit_only',evidence:'Preserved fictional original',observedOn:'2026-10-01',preparedBy:'Tavily Basic search · not verified'})]);
 await runtime.query(`INSERT INTO sourcing_qualification_runs(workspace_id,id,candidate_id,candidate_revision,fingerprint,prompt_version,policy_version,model_name)
  VALUES($1,$2,$3,1,repeat('b',64),'qualification-context-v7','qualification-v5','claude-haiku-4-5')`,[w,run,candidate]);
 await runtime.query('UPDATE sourcing_qualification_runs SET observations=$3::jsonb WHERE workspace_id=$1 AND id=$2',[w,run,JSON.stringify([{id:randomUUID(),url:'https://old-identity.example.test/',contentHash:'c'.repeat(64),relevantTextHash:'d'.repeat(64),retrievedAt:new Date().toISOString(),publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'old-original',text:'Old Property Management'}]}])]);
 await runtime.query(`INSERT INTO sourcing_discovery_settings(workspace_id,enabled,query_cursor,next_run_at,last_result,owner_user_id,auto_admission_enabled,qualification_evaluation)
  VALUES($1,false,129,'2026-11-01T12:34:56Z','unknown',$2,true,$3::jsonb)`,[w,seed.alpha.admin.userId,JSON.stringify({verifiedFirmPolicyVersion:'verified-firm-v3',policyVersion:'qualification-v5',promptVersion:'qualification-context-v7',reportSha256:'e'.repeat(64),reviewedEligible:2,falseEligible:0})]);
 await runtime.query('INSERT INTO sourcing_search_account(id,halted,daily_used,monthly_used) VALUES(true,true,7,149)');
 await withTransaction(runtime,()=>ensureTargetingPolicy(ctx));
 await runtime.query("INSERT INTO sourcing_discovery_attempts(workspace_id,id,query_id,query,policy_version,state,slot) VALUES($1,$2,'old','Preserved unresolved attempt','targeting-v1','dispatched',0)",[w,attempt]);
 await runtime.query("INSERT INTO sourcing_discovery_hits(workspace_id,source_url,attempt_id,candidate_id,native_result) VALUES($1,'https://old-identity.example.test/',$2,$3,$4::jsonb)",[w,attempt,candidate,JSON.stringify({url:'https://old-identity.example.test/',title:'Home | Old PM',snippet:'Preserved original snippet'})]);
 await runtime.query("INSERT INTO workspace_settings(workspace_id,setting_key,version,value,changed_by_user_id) VALUES($1,'sending_enabled',4,'{\"enabled\":false}'::jsonb,$2)",[w,seed.alpha.admin.userId]);
 await runtime.query('INSERT INTO research_settings(workspace_id,enabled,daily_cost_ceiling_cents,monthly_cost_ceiling_cents) VALUES($1,true,1000,20000)',[w]);
 await runtime.query("INSERT INTO daily_counters(workspace_id,subject_kind,subject_key,counter_kind,business_date,business_time_zone,count) VALUES($1,'workspace',$2,'research_firm_runs',current_date,'America/New_York',17)",[w,w]);
 await withTransaction(runtime,async()=>{const r=await reserveAttempt(ctx,{subjectKind:'sourcing_qualification',subjectId:run,attempt:1,providerKey:'google_vertex.sourcing_qualification',at:new Date().toISOString(),businessTimeZone:'America/New_York',cents:2,modelName:'gemini-3.8-flash',maxInputTokens:100,maxOutputTokens:2048});await markCalling(ctx,r.id);});
 before=await retained();await applyMigrations(db.session,{throughVersion:151});
});
afterAll(async()=>db?.drop());
it('upgrades populated150 to151 preserving old run/source/settings/OFF/attestation/caps/pacing and uncertain reservation byte-values',async()=>{
 expect(await readAppliedSchemaVersion(db.session)).toBe(151);expect(await retained()).toEqual(before);
 expect((await runtime.query('SELECT producer_version,prepared_identity,state FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,run])).rows).toEqual([{producer_version:'qualification-context-v7',prepared_identity:null,state:'pending'}]);
});
it.each(PREPARED_SOURCE_IDENTITY_CONSTRAINT_CASES)('app_runtime enforces $constraint',async entry=>{
 await runtime.query('BEGIN');
 try{await expect(entry.run({session:runtime,seeded:seed})).rejects.toMatchObject({code:'23514',constraint:entry.constraint});}
 finally{await runtime.query('ROLLBACK');}
});
