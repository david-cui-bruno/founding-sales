import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,TEMPLATE_DATABASE_ENVIRONMENT_VARIABLE,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
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
async function fixture(){
 const input=manualOrdinaryFixture(767),saved=await withTransaction(reader,()=>saveCandidate(context(),input));if(!saved.ok)throw Error(saved.reason);
 const evidence=manualPhoneFixture('https://optional.example.test/sole-retained-authority');await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,saved.value.id,evidence);
 const source=evidence.observations[0]!;
 const id=String((await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,retrieved_at) VALUES($1,$2,'website',$3,$4,$5) RETURNING id`,[seeded.alpha.workspaceId,crm.alpha.firmId,source.url,source.contentHash,source.retrievedAt])).rows[0]?.['id']);
 return {candidateId:saved.value.id,evidenceId:id};
}
// Exact evidence-row DELETE matches commitDeletion's conflicting statement. No
// broad CRM erasure, network/provider work, or copied permission implementation.
const remove=(id:string)=>deleter.query('DELETE FROM evidence_items WHERE workspace_id=$1 AND id=$2',[seeded.alpha.workspaceId,id]);
async function waiting(pid:number){return String((await db.session.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.['wait_event_type']);}
it('holds sole retained authority through the final post-snapshot principal wait, blocking deletion until read commit',async()=>{
 const f=await fixture(),paused=signal(),release=signal();let calls=0;
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
it('rereads sole authority after a supporting-row lock wait when deletion wins, retaining only the raw prospect',async()=>{
 const f=await fixture(),readerPid=Number((await reader.query('SELECT pg_backend_pid() pid')).rows[0]?.['pid']);
 await deleter.query('BEGIN');await remove(f.evidenceId);
 const reading=withTransaction(reader,()=>listManualProspects(context(),{state:'all',offset:0}));
 try{await expect.poll(()=>waiting(readerPid),{timeout:1500}).toBe('Lock');}
 finally{await deleter.query('COMMIT');await reading;}
 expect(await reading).toMatchObject({ok:true,value:{prospects:[{candidateId:f.candidateId,observedPhone:null,phoneEvidence:{state:'not_extracted'}}]}});
 expect((await db.session.query('SELECT count(*)::int n FROM evidence_items')).rows[0]?.['n']).toBe(0);
});
