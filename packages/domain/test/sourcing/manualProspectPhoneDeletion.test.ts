import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {createTestDatabase,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,manualLiteralPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,reader:SessionQueryable,deleter:SessionQueryable;
const context=()=>repositoryContext(workspaceScope(seeded.alpha.workspaceId,{kind:'user',userId:seeded.alpha.admin.userId,role:'admin'}),reader);
function signal(){let resolve!:()=>void;const promise=new Promise<void>(yes=>{resolve=yes;});return {promise,resolve};}
beforeAll(async()=>{
 db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);reader=await db.appRuntimeSession();deleter=await db.appRuntimeSession();
 // The harness owns cluster cleanup. Server files/processes may be in a container.
 console.log('PHONE_DELETE_RESOURCES',JSON.stringify({database:db.name,template:process.env[TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE],backendPid:Number((await db.session.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid'])}));
});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');});
afterAll(async()=>{await db?.drop();console.log('PHONE_DELETE_DATABASE_DROPPED: owned sessions disconnected and disposable test database dropped');});
async function fixture(mode:'legacy'|'literal'|'retained'='legacy'){
 const input=manualOrdinaryFixture(775);if(mode!=='legacy')input.website='https://optional.example.test/';const saved=await withTransaction(reader,()=>saveCandidate(context(),input));if(!saved.ok)throw Error(saved.reason);
 const url='https://optional.example.test/sole-retained-authority',evidence=mode==='legacy'?manualPhoneFixture(url):manualLiteralPhoneFixture(url),original=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,saved.value.id,evidence);
 const source=evidence.observations[0]!;
 if(mode==='retained'){
  const decision=randomUUID();await db.session.query(`INSERT INTO sourcing_retained_identity_decisions(workspace_id,id,candidate_id,original_run_id,original_revision,result_revision,reviewer_user_id,observation_id,block_id,content_hash,relevant_text_hash,name_start,name_end)
   VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,0,4)`,[seeded.alpha.workspaceId,decision,saved.value.id,original,seeded.alpha.admin.userId,source.id,source.blocks[0]!.id,source.contentHash,source.relevantTextHash]);
  await db.session.query("UPDATE sourcing_qualification_runs SET requested_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[original]);
  const derived=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,saved.value.id,evidence);await db.session.query('UPDATE sourcing_qualification_runs SET retained_identity_decision_id=$2 WHERE id=$1',[derived,decision]);
 }
 const id=String((await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,retrieved_at) VALUES($1,$2,'website',$3,$4,$5) RETURNING id`,[seeded.alpha.workspaceId,crm.alpha.firmId,source.url,source.contentHash,source.retrievedAt])).rows[0]?.['id']);
 return {candidateId:saved.value.id,evidenceId:id,original};
}
// Exact evidence-row DELETE matches commitDeletion's conflicting statement. No
// broad CRM erasure, network/provider work, or copied permission implementation.
const remove=(id:string)=>deleter.query('DELETE FROM evidence_items WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,id]);
async function waiting(pid:number){return String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type']);}
it.each(['legacy','literal','retained'] as const)('holds %s authority through final principal wait, blocking deletion until read commit',async mode=>{
 const f=await fixture(mode),paused=signal(),release=signal();let calls=0;
 const deletePid=Number((await deleter.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 const reading=withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0},async()=>{if(++calls===2){paused.resolve();await release.promise;}return true;}));
 await paused.promise;let deleted=false;
 const deleting=withTransaction(deleter,()=>remove(f.evidenceId)).then(()=>{deleted=true;});
 try{await expect.poll(()=>waiting(deletePid),{timeout:1500}).toBe('Lock');expect(deleted).toBe(false);}
 finally{release.resolve();await Promise.all([reading,deleting]);}
 expect(await reading).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:'+12145550123'}]}});
 expect(deleted).toBe(true);
 expect(await withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:null,phoneEvidence:{state:'not_extracted'}}]}});
});
it.each(['legacy','literal','retained'] as const)('rereads %s authority after supporting-row wait when deletion wins, retaining raw prospect',async mode=>{
 const f=await fixture(mode),readerPid=Number((await reader.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await deleter.query('BEGIN');await remove(f.evidenceId);
 const reading=withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0}));
 try{await expect.poll(()=>waiting(readerPid),{timeout:1500}).toBe('Lock');}
 finally{await deleter.query('COMMIT');await reading;}
 expect(await reading).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:null,phoneEvidence:{state:'not_extracted'}}]}});
 expect((await db.session.query('SELECT count(*)::int n FROM evidence_items')).rows[0]?.['n']).toBe(0);
});
it('775 retained ancestor deletion is blocked through final authority wait and removes derived phone on fresh read',async()=>{
 const f=await fixture('retained'),paused=signal(),release=signal();let calls=0;
 const reading=withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0},async()=>{if(++calls===2){paused.resolve();await release.promise;}return true;}));
 await paused.promise;const pid=Number((await deleter.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 const deleting=withTransaction(deleter,()=>deleter.query('DELETE FROM sourcing_qualification_runs WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,f.original]));
 try{await expect.poll(()=>waiting(pid),{timeout:1500}).toBe('Lock');}finally{release.resolve();await Promise.all([reading,deleting]);}
 expect(await reading).toMatchObject({ok:true,value:{prospects:[{observedPhone:'+12145550123'}]}});
 expect(await withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0}))).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:null}]}});
});
it('775 expiry during final authority wait cannot publish a literal under stale clock rights',async()=>{
 const f=await fixture('literal');await db.session.query("UPDATE evidence_items SET retention_expires_at=clock_timestamp()+interval '120 milliseconds' WHERE id=$1",[f.evidenceId]);let calls=0;
 const result=await withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0},async()=>{if(++calls===2)await db.session.query('SELECT pg_sleep(0.15)');return true;}));
 expect(result).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:null,phoneEvidence:{state:'not_extracted',reason:'optional_source_changed'}}]}});
});
