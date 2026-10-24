import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedRetainedRecovery} from './retainedRecoveryFixture.ts';
import {decideRetainedIdentity,interpretRetainedQualification} from '../../sourcing/retainedRecovery.ts';
import {readQualification} from '../../sourcing/qualificationStore.ts';
import {deleteCandidate} from '../../sourcing/candidates.ts';

let db:TestDatabase,seed:TwoWorkspaces,runtime:SessionQueryable;
const context=(session:SessionQueryable)=>repositoryContext(workspaceScope(seed.alpha.workspaceId,{kind:'user',userId:seed.alpha.admin.userId,role:'admin'}),session);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('TRUNCATE sourcing_candidates,firms,jobs,daily_counters CASCADE');});
afterAll(async()=>{await db.drop();});
async function fixture(){return withTransaction(db.session,()=>seedRetainedRecovery(context(db.session)));}
async function decide(f:Awaited<ReturnType<typeof fixture>>){
 const result=await withTransaction(runtime,()=>decideRetainedIdentity(context(runtime),f.identity));
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);return result.value.decisionId;
}

it('completes identity and retained interpretation as app_runtime without granting immutable updates',async()=>{
 const f=await fixture(),original=(await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows[0];
 expect((await runtime.query('SELECT current_user AS role')).rows[0]?.['role']).toBe('app_runtime');
 const decisionId=await decide(f);
 await expect(runtime.query('UPDATE sourcing_retained_identity_decisions SET name_start=name_start WHERE id=$1',[decisionId])).rejects.toMatchObject({code:'42501'});
 const result=await withTransaction(runtime,()=>interpretRetainedQualification(context(runtime),f.interpretation(decisionId)));
 expect(result.ok).toBe(true);if(!result.ok)throw Error(result.reason);
 expect(await readQualification(context(runtime),{candidateId:f.candidateId})).toMatchObject({runId:result.value.runId,status:'eligible',interpretationOrigin:'human_retained'});
 expect((await db.session.query('SELECT * FROM sourcing_qualification_runs WHERE id=$1',[f.runId])).rows[0]).toEqual(original);
 await expect(runtime.query('UPDATE sourcing_retained_identity_decisions SET name_start=name_start WHERE id=$1',[decisionId])).rejects.toMatchObject({code:'42501'});
 for(const table of ['jobs','provider_reservations','daily_counters','firms'])expect((await runtime.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});

it('candidate serialization permits only one concurrent app_runtime interpretation',async()=>{
 const f=await fixture(),decisionId=await decide(f),second=await db.appRuntimeSession(),input=f.interpretation(decisionId);
 const results=await Promise.all([withTransaction(runtime,()=>interpretRetainedQualification(context(runtime),input)),withTransaction(second,()=>interpretRetainedQualification(context(second),input))]);
 expect(results.filter(result=>result.ok)).toHaveLength(1);
 expect(results.filter(result=>!result.ok)).toHaveLength(1);
 expect((await runtime.query('SELECT id FROM sourcing_qualification_runs WHERE retained_identity_decision_id=$1',[decisionId])).rows).toHaveLength(1);
});

it('holds candidate and original lifecycle locks through interpretation, then cascades deletion as app_runtime',async()=>{
 const f=await fixture(),decisionId=await decide(f),second=await db.appRuntimeSession();
 const result=await withTransaction(runtime,()=>interpretRetainedQualification(context(runtime),f.interpretation(decisionId),async()=>{
  // A different transaction cannot delete either locked ancestor while the immutable decision is read.
  for(const [table,id] of [['sourcing_candidates',f.candidateId],['sourcing_qualification_runs',f.runId]]){
   await expect(second.query(`SELECT id FROM ${table} WHERE id=$1 FOR UPDATE NOWAIT`,[id])).rejects.toMatchObject({code:'55P03'});
  }
  return true;
 }));
 expect(result.ok).toBe(true);
 expect(await withTransaction(second,()=>deleteCandidate(context(second),{id:f.candidateId,expectedRevision:2}))).toMatchObject({ok:true});
 expect((await runtime.query('SELECT id FROM sourcing_retained_identity_decisions WHERE id=$1',[decisionId])).rows).toHaveLength(0);
 expect((await runtime.query('SELECT id FROM sourcing_qualification_runs WHERE candidate_id=$1',[f.candidateId])).rows).toHaveLength(0);
});
