import {afterAll,beforeAll,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {listManualProspects,recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {manualDiscoveryFixture} from './support/manualProspectFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable;
const ctx=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),runtime);
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);runtime=await db.appRuntimeSession();});
afterAll(async()=>{await db.drop();});
it.each(['expired','not_retainable'] as const)('known %s evidence source is hidden without qualification gating or authority leakage',async restriction=>{
 const input=manualDiscoveryFixture(`terms-${restriction}`),saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),input));if(!saved.ok)throw Error(saved.reason);
 const url=input.row.source.sourceUrl;
 await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,$5,now()-interval '1 second')`,[seeded.alpha.workspaceId,crm.alpha.firmId,url,(restriction==='expired'?'e':'f').repeat(64),restriction==='expired']);
 const listed=await withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0}));expect(listed).toMatchObject({ok:true,value:{prospects:[]}});
 expect(await withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:saved.value.id,expectedRevision:1,state:'kept'}))).toMatchObject({ok:false,reason:'candidate_unavailable'});
 expect((await runtime.query('SELECT * FROM sourcing_manual_prospect_states')).rows).toEqual([]);
});
it('rechecks membership after a real candidate lock wait before any state write',async()=>{
 const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(ctx(),manualDiscoveryFixture('lock-wait')));if(!saved.ok)throw Error(saved.reason);
 const blocker=await db.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT id FROM sourcing_candidates WHERE id=$1 FOR UPDATE',[saved.value.id]);
 const pending=withTransaction(runtime,()=>recordManualProspectFeedback(ctx(),{candidateId:saved.value.id,expectedRevision:1,state:'kept'}));
 try{
  await expect.poll(async()=>Number((await db.session.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT revision FROM sourcing_candidates%'")).rows[0]?.['n'])).toBe(1);
  await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId]);
  await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
 }finally{await blocker.query('ROLLBACK');}
 expect(await pending).toMatchObject({ok:false,reason:'authority_changed'});expect((await runtime.query('SELECT * FROM sourcing_manual_prospect_states')).rows).toEqual([]);
});
