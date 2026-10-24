import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedRetainedRecovery} from '../sourcing/retainedRecoveryFixture.ts';
import {decideRetainedIdentity,interpretRetainedQualification} from '../../sourcing/retainedRecovery.ts';
import {deleteCandidate} from '../../sourcing/candidates.ts';
import {retainedFirmOnly} from '../../sourcing/retainedAcquisition.ts';
import {TABLE_RETENTION_COVERAGE} from '../../retention/coverage.ts';
import {RETENTION_TARGETS} from '../../retention/targets.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
let db:TestDatabase,seed:TwoWorkspaces;
const ctx=(workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seed[workspace].workspaceId,{kind:'user',userId:seed[workspace].admin.userId,role:'admin'}),db.session);
const tx=<T>(work:()=>Promise<T>)=>withTransaction(db.session,work);
beforeAll(async()=>{db=await createTestDatabase();seed=await seedTwoWorkspaces(db.session);});
beforeEach(async()=>{await db.session.query('TRUNCATE sourcing_candidates,firms CASCADE');});
afterAll(async()=>{await db.drop();});
async function fixture(){
 const f=await tx(()=>seedRetainedRecovery(ctx())),d=await tx(()=>decideRetainedIdentity(ctx(),f.identity));if(!d.ok)throw Error(d.reason);
 const interpreted=await tx(()=>interpretRetainedQualification(ctx(),f.interpretation(d.value.decisionId)));if(!interpreted.ok)throw Error(interpreted.reason);
 const firmId=randomUUID();
 await db.session.query("INSERT INTO firms(workspace_id,id,name,assigned_user_id) VALUES($1,$2,'Controlled retained lifecycle',$3)",[seed.alpha.workspaceId,firmId,seed.alpha.admin.userId]);
 await db.session.query('INSERT INTO sourcing_retained_firm_acquisition_fences(workspace_id,firm_id,decision_id,candidate_id) VALUES($1,$2,$3,$4)',[seed.alpha.workspaceId,firmId,d.value.decisionId,f.candidateId]);
 return {...f,firmId,decisionId:d.value.decisionId,interpretationId:interpreted.value.runId};
}
it('classifies original-bound decisions separately from surviving-Firm fences and no scheduled sweep removes either',async()=>{
 const f=await fixture(),before=(await db.session.query('SELECT * FROM sourcing_retained_identity_decisions')).rows;
 expect(TABLE_RETENTION_COVERAGE['sourcing_retained_identity_decisions']?.dispositions).toEqual(['deletion_removes']);
 expect(TABLE_RETENTION_COVERAGE['sourcing_retained_firm_acquisition_fences']?.dispositions).toEqual(['retained']);
 for(const target of RETENTION_TARGETS){
  expect(target.tables).not.toContain('sourcing_retained_identity_decisions');expect(target.tables).not.toContain('sourcing_retained_firm_acquisition_fences');
  if(target.sweep)await tx(()=>target.sweep!(ctx(),{now:'2040-01-01T00:00:00.000Z',boundaryAt:'2039-01-01T00:00:00.000Z',limit:500}));
 }
 expect((await db.session.query('SELECT * FROM sourcing_retained_identity_decisions')).rows).toEqual(before);
 expect(await retainedFirmOnly(ctx(),f.firmId)).toBe(true);expect(await retainedFirmOnly(ctx('beta'),f.firmId)).toBe(false);
});
it.each(['candidate','original'] as const)('erases original-bound lineage on %s deletion without lifting the surviving-Firm fence',async kind=>{
 const f=await fixture();
 if(kind==='candidate')expect(await tx(()=>deleteCandidate(ctx(),{id:f.candidateId,expectedRevision:2}))).toMatchObject({ok:true});
 else await db.session.query('DELETE FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,f.runId]);
 expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions WHERE id=$1',[f.decisionId])).rows).toEqual([]);
 expect((await db.session.query('SELECT id FROM sourcing_qualification_runs WHERE id=$1',[f.interpretationId])).rows).toEqual([]);
 expect(await retainedFirmOnly(ctx(),f.firmId)).toBe(true);
});
it('keeps the acquisition barrier through ordinary Firm erasure',async()=>{
 const f=await fixture(),preview=await tx(()=>previewDeletion(ctx(),{targetKind:'firm',firmId:f.firmId}));if(!preview.ok)throw Error(preview.reason);
 expect(await tx(()=>commitDeletion(ctx(),{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:randomUUID(),journal:recordingSuppressionJournal()}))).toMatchObject({ok:true});
 expect(await retainedFirmOnly(ctx(),f.firmId)).toBe(true);
});
it('keeps wanted lineage and the Firm fence after reviewer membership revocation',async()=>{
 const f=await fixture(),before=(await db.session.query('SELECT * FROM sourcing_retained_identity_decisions WHERE id=$1',[f.decisionId])).rows;
 await db.session.query('BEGIN');
 try{
  await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.salesperson.userId]);
  await db.session.query("UPDATE workspace_memberships SET status='inactive',deactivated_at=clock_timestamp() WHERE workspace_id=$1 AND user_id=$2",[seed.alpha.workspaceId,seed.alpha.admin.userId]);
  expect((await db.session.query('SELECT * FROM sourcing_retained_identity_decisions WHERE id=$1',[f.decisionId])).rows).toEqual(before);
  expect(await retainedFirmOnly(ctx(),f.firmId)).toBe(true);
  expect(await interpretRetainedQualification(ctx(),f.interpretation(f.decisionId))).toMatchObject({ok:false});
 }finally{await db.session.query('ROLLBACK');}
});
it('cascades the barrier only with physical Firm deletion, not its independent candidate decision',async()=>{
 const f=await fixture();
 await db.session.query('DELETE FROM firms WHERE workspace_id=$1 AND id=$2',[seed.alpha.workspaceId,f.firmId]);expect(await retainedFirmOnly(ctx(),f.firmId)).toBe(false);
 expect((await db.session.query('SELECT id FROM sourcing_retained_identity_decisions WHERE id=$1',[f.decisionId])).rows).toHaveLength(1);
});
