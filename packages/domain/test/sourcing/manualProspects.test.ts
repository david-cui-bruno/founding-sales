import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveDiscoveryCandidate} from '../../sourcing/discoveryIntake.ts';
import {saveCandidate,deleteCandidate} from '../../sourcing/candidates.ts';
import {listManualProspects,recordManualProspectFeedback} from '../../sourcing/manualProspects.ts';
import {TABLE_RETENTION_COVERAGE} from '../../retention/coverage.ts';
import {manualDiscoveryFixture,manualOrdinaryFixture} from './support/manualProspectFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,runtime:SessionQueryable;
const context=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin',session=runtime)=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace][role].userId,role}),session);
const list=(state:'all'|'new'|'kept'|'skipped'|'wrong_number'='all',offset=0)=>withTransaction(runtime,()=>listManualProspects(context(),{state,offset}));
async function discovery(input=manualDiscoveryFixture()){const saved=await withTransaction(runtime,()=>saveDiscoveryCandidate(context(),input));if(!saved.ok)throw Error(saved.reason);return saved.value.id;}
const feedback=(id:string,state:'kept'|'skipped'|'wrong_number',revision=1)=>withTransaction(runtime,()=>recordManualProspectFeedback(context(),{candidateId:id,expectedRevision:revision,state}));
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await db.drop();});
it('shows raw discovery AND ordinary with no owner, evaluation, phone, need or canonical keep',async()=>{
 const id=await discovery();await withTransaction(runtime,()=>saveCandidate(context(),manualOrdinaryFixture()));
 expect((await runtime.query('SELECT current_user')).rows).toEqual([{current_user:'app_runtime'}]);
 const result=await list();expect(result).toMatchObject({ok:true,value:{hasMore:false}});if(!result.ok)throw Error(result.reason);
 expect(result.value.prospects).toHaveLength(2);for(const p of result.value.prospects)expect(p).toMatchObject({observedPhone:null,phoneBasis:'unknown',state:'new',qualification:'unverified',contactAuthority:'not_granted'});
 expect(result.value.prospects.find(p=>p.candidateId===id)?.sourceNotices).toEqual([{label:'CDLA-Permissive-2.0',url:null},{label:'Retained synthetic notice',url:'https://source.example.test/license'}]);
 for(const table of ['sourcing_qualification_runs','jobs','firms','contacts','phone_routes','sequence_enrollments','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('feedback only updates separate state, stays reversible, and cascade erases it without changing canonical revision',async()=>{
 const id=await discovery(),before=(await runtime.query('SELECT * FROM sourcing_candidates')).rows;
 for(const state of ['kept','skipped','wrong_number','kept'] as const){expect(await feedback(id,state)).toMatchObject({ok:true,value:{candidateId:id,revision:1,state}});expect(await list(state)).toMatchObject({ok:true,value:{prospects:[{candidateId:id,state}]}});}
 expect((await runtime.query('SELECT * FROM sourcing_candidates')).rows).toEqual(before);
 expect(TABLE_RETENTION_COVERAGE['sourcing_manual_prospect_states']?.dispositions).toEqual(['deletion_removes']);
 expect(await withTransaction(runtime,()=>deleteCandidate(context(),{id,expectedRevision:1}))).toMatchObject({ok:true});
 expect((await runtime.query('SELECT * FROM sourcing_manual_prospect_states')).rows).toEqual([]);
});
it('refuses stale, foreign, absent, nonadmin and post-wait session/member authority',async()=>{
 const id=await discovery();expect(await feedback(id,'kept',2)).toMatchObject({ok:false,reason:'candidate_changed'});
 expect(await withTransaction(runtime,()=>recordManualProspectFeedback(context('beta'),{candidateId:id,expectedRevision:1,state:'kept'}))).toMatchObject({ok:false,reason:'candidate_unavailable'});
 expect(await listManualProspects(context('alpha','salesperson'),{state:'all',offset:0})).toMatchObject({ok:false,reason:'admin_only'});
 expect(await recordManualProspectFeedback(context('alpha','salesperson'),{candidateId:id,expectedRevision:1,state:'kept'})).toMatchObject({ok:false,reason:'admin_only'});
 expect(await withTransaction(runtime,()=>recordManualProspectFeedback(context(),{candidateId:id,expectedRevision:1,state:'kept'},async()=>false))).toMatchObject({ok:false,reason:'authority_changed'});
 expect(await withTransaction(runtime,()=>listManualProspects(context(),{state:'all',offset:0},async()=>false))).toMatchObject({ok:false,reason:'authority_changed'});
 await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId]);
 await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
 try{expect(await feedback(id,'kept')).toMatchObject({ok:false,reason:'admin_only'});}finally{await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId]);}
 expect((await runtime.query('SELECT * FROM sourcing_manual_prospect_states')).rows).toEqual([]);
});
it('replacement paging is bounded and conservative dedup warns without merging absent website identities',async()=>{
 for(let i=0;i<51;i++)await discovery(manualDiscoveryFixture(`page-${i}`));
 const input=manualDiscoveryFixture('duplicate-a');input.row.website='https://duplicate.example.test/';input.row.firmName='Same name';await discovery(input);
 const duplicate=manualDiscoveryFixture('duplicate-b');duplicate.row.website=input.row.website;duplicate.row.firmName=input.row.firmName;await discovery(duplicate);
 const a=await list(),b=await list('all',50);expect(a.ok&&a.value.prospects).toHaveLength(50);expect(a.ok&&a.value.hasMore).toBe(true);expect(b.ok&&b.value.prospects).toHaveLength(2);
 expect(a.ok&&a.value.prospects.find(p=>p.observedName==='Same name')?.possibleDuplicateCount).toBe(1);
 expect((await runtime.query('SELECT count(*)::int n FROM sourcing_candidates')).rows[0]?.['n']).toBe(53);
});
it('missing origins, junk and known restricted source refuse projection and feedback, deleted candidates stay absent',async()=>{
 const id=await discovery();await runtime.query('DELETE FROM sourcing_candidate_discovery_origins WHERE candidate_id=$1',[id]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[]}});expect(await feedback(id,'kept')).toMatchObject({ok:false,reason:'candidate_unavailable'});
 await db.session.query('DELETE FROM sourcing_candidates');const junk=manualDiscoveryFixture('junk');junk.row.firmName='---';await discovery(junk);expect(await list()).toMatchObject({ok:true,value:{prospects:[]}});
 await db.session.query('DELETE FROM sourcing_candidates');const ordinary=await withTransaction(runtime,()=>saveCandidate(context(),manualOrdinaryFixture()));if(!ordinary.ok)throw Error(ordinary.reason);
 await runtime.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[ordinary.value.id]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[]}});expect(await feedback(ordinary.value.id,'skipped')).toMatchObject({ok:false,reason:'candidate_unavailable'});
});
it('does not apply old revision manual state to changed observations',async()=>{
 const id=await discovery();await feedback(id,'wrong_number');await runtime.query('UPDATE sourcing_candidates SET revision=2 WHERE id=$1',[id]);
 expect(await list()).toMatchObject({ok:true,value:{prospects:[{candidateId:id,revision:2,state:'new'}]}});expect(await feedback(id,'kept')).toMatchObject({ok:false,reason:'candidate_changed'});
});
