import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveCandidate} from '../../sourcing/candidates.ts';
import {listManualProspects} from '../../sourcing/manualProspects.ts';
import {rememberExpiredManualSources} from '../../sourcing/manualProspectSourceLoss.ts';
import {manualOrdinaryFixture} from './support/manualProspectFixture.ts';
import {manualPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable;
const ctx=(workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace].admin.userId,role:'admin'}),runtime);
async function candidate(workspace:'alpha'|'beta'='alpha',index=767){const input=manualOrdinaryFixture(index),saved=await withTransaction(runtime,()=>saveCandidate(ctx(workspace),input));if(!saved.ok)throw Error(saved.reason);return {...saved.value,input};}
const list=(authority?:()=>Promise<boolean>)=>withTransaction(runtime,()=>listManualProspects(ctx(),{state:'all',offset:0},authority));
async function prospect(authority?:()=>Promise<boolean>){const result=await list(authority);if(!result.ok)throw Error(result.reason);expect(result.value.prospects).toHaveLength(1);return result.value.prospects[0]!;}
async function retain(source:ReturnType<typeof manualPhoneFixture>['observations'][number],workspace:'alpha'|'beta'='alpha'){
 await db.session.query(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,retrieved_at) VALUES($1,$2,'website',$3,$4,$5)`,[seeded[workspace].workspaceId,crm[workspace].firmId,source.url,source.contentHash,source.retrievedAt]);
}
beforeAll(async()=>{db=await createTestDatabase();seeded=await seedTwoWorkspaces(db.session);crm=await seedCrm(db.session,seeded);runtime=await db.appRuntimeSession();});
beforeEach(async()=>{await db.session.query('DELETE FROM sourcing_candidates');await db.session.query('DELETE FROM evidence_items');});
afterAll(async()=>{await db.drop();});
it('composes a current grounded phone on its retained candidate source without qualification/owner/office/fit gates',async()=>{
 const c=await candidate(),e=manualPhoneFixture(c.input.sourceUrl),run=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);
 expect(await prospect()).toMatchObject({candidateId:c.id,observedPhone:'+12145550123',phoneEvidence:{state:'observed',sources:[{runId:run,observationId:e.observations[0]!.id,blockId:'phone-0',url:c.input.sourceUrl,retrievedAt:e.observations[0]!.retrievedAt}]},qualification:'unverified',contactAuthority:'not_granted'});
 for(const table of ['jobs','provider_reservations','sourcing_admissions','sequence_enrollments','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('requires a separate exact retained source association for an optional URL, not readQualification or site similarity',async()=>{
 const c=await candidate(),e=manualPhoneFixture(`${c.input.website}contact`);await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);
 expect(await prospect()).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted'}});
 await retain(e.observations[0]!);expect((await prospect()).observedPhone).toBe('+12145550123');
 await db.session.query("UPDATE evidence_items SET content_hash=$1",['b'.repeat(64)]);expect((await prospect()).observedPhone).toBeNull();
 await db.session.query('UPDATE evidence_items SET content_hash=$1,retrieved_at=retrieved_at-interval \'1 second\'',['a'.repeat(64)]);expect((await prospect()).observedPhone).toBeNull();
});
it.each(['expired','deleted','source_loss','restricted','foreign_retention','future','stale_revision','foreign_candidate','run_source_loss'] as const)('optional %s evidence cannot hide the raw queue or leak a phone',async mode=>{
 const c=await candidate(),e=manualPhoneFixture(`https://optional.example.test/phone/${randomUUID()}`);
 const foreign=mode==='foreign_candidate'?await candidate('beta'):null;
 const run=await seedManualPhoneRun(db.session,seeded[foreign?'beta':'alpha'].workspaceId,foreign?.id??c.id,e,mode==='stale_revision'?2:1);
 await retain(e.observations[0]!,mode==='foreign_retention'?'beta':'alpha');
 if(mode==='expired')await db.session.query("UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second'");
 if(mode==='deleted')await db.session.query('DELETE FROM evidence_items');
 if(mode==='source_loss')await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[e.observations[0]!.url]));
 if(mode==='restricted'){
  const lost=await candidate('alpha',768);await db.session.query(`UPDATE sourcing_candidates SET source_check=jsonb_build_object('state','unavailable','reason','source_not_permitted','lastSuccess',jsonb_build_object('url',$2::text)) WHERE id=$1`,[lost.id,e.observations[0]!.url]);
 }
 if(mode==='future'){e.observations[0]!.retrievedAt=new Date(Date.now()+86400000).toISOString();await db.session.query('UPDATE sourcing_qualification_runs SET observations=$2 WHERE id=$1',[run,JSON.stringify(e.observations)]);}
 if(mode==='run_source_loss')await db.session.query("UPDATE sourcing_qualification_runs SET reason='source_not_permitted' WHERE id=$1",[run]);
 expect(await prospect()).toMatchObject({candidateId:c.id,observedPhone:null,phoneEvidence:{state:'not_extracted'}});
});
it('applies each optional observation URL fence independently, not just the raw candidate URL',async()=>{
 const c=await candidate(),good=manualPhoneFixture(c.input.sourceUrl),bad=manualPhoneFixture('https://optional.example.test/restricted',['2145550124']);
 const evidence={observations:[...good.observations,...bad.observations],facts:[...good.facts,...bad.facts]};
 await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,evidence);await retain(bad.observations[0]!);
 expect(await prospect()).toMatchObject({observedPhone:null,phoneEvidence:{state:'conflicting',sources:[{},{}]}});
 await withTransaction(runtime,()=>rememberExpiredManualSources(ctx(),[bad.observations[0]!.url]));
 expect(await prospect()).toMatchObject({observedPhone:'+12145550123',phoneEvidence:{state:'observed',sources:[{url:good.observations[0]!.url}]}});
});
it.each(['changed','deleted','expired','principal'] as const)('revalidates optional evidence and authority after a wait: %s',async mode=>{
 const c=await candidate(),e=manualPhoneFixture('https://optional.example.test/wait');const run=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);await retain(e.observations[0]!);
 let calls=0;
 const result=await list(async()=>{
  calls++;if(calls!==1)return true;
  if(mode==='changed')await runtime.query('UPDATE sourcing_qualification_runs SET facts=\'[]\' WHERE id=$1',[run]);
  if(mode==='deleted')await runtime.query('DELETE FROM sourcing_qualification_runs WHERE id=$1',[run]);
  if(mode==='expired')await runtime.query("UPDATE evidence_items SET retention_expires_at=clock_timestamp()-interval '1 second'");
  return mode!=='principal';
 });
 if(mode==='principal')expect(result).toMatchObject({ok:false,reason:'authority_changed'});
 else expect(result).toMatchObject({ok:true,value:{prospects:[{candidateId:c.id,observedPhone:null,phoneEvidence:{state:'not_extracted'}}]}});
});
it('malformed optional phone evidence and bare assertions leave raw list usable',async()=>{
 const c=await candidate(),e=manualPhoneFixture(c.input.sourceUrl);e.facts[0]!.observationId=randomUUID();await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);
 expect((await prospect()).observedPhone).toBeNull();
 await db.session.query(`UPDATE sourcing_qualification_runs SET observations='[{"url":"https://source.example.test/", "retrievedAt":"invalid"}]'`);
 expect((await prospect()).observedPhone).toBeNull();
});
