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
import {manualPhoneFixture,manualLiteralPhoneFixture,seedManualPhoneRun} from './support/manualPhoneFixture.ts';
let db:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable;
const ctx=(workspace:'alpha'|'beta'='alpha')=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace].admin.userId,role:'admin'}),runtime);
async function candidate(workspace:'alpha'|'beta'='alpha',index=767,literal=false){const input=manualOrdinaryFixture(index);if(literal)input.website='https://source.example.test/';const saved=await withTransaction(runtime,()=>saveCandidate(ctx(workspace),input));if(!saved.ok)throw Error(saved.reason);return {...saved.value,input};}
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
it('rechecks the live principal after a real source-lifecycle lock wait before exposing retained phones',async()=>{
 const c=await candidate();await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,manualPhoneFixture(c.input.sourceUrl));
 const blocker=await db.appRuntimeSession();await blocker.query('BEGIN');
 await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${seeded.alpha.workspaceId}`]);
 const pending=list();
 try{
  await expect.poll(async()=>Number((await db.session.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rows[0]?.['n'])).toBe(1);
  await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId]);
  await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
 }finally{await blocker.query('ROLLBACK');}
 try{expect(await pending).toMatchObject({ok:false,reason:'authority_changed'});}
 finally{
  await db.session.query("UPDATE workspace_memberships SET role='admin' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.admin.userId]);
  await db.session.query("UPDATE workspace_memberships SET role='salesperson' WHERE workspace_id=$1 AND user_id=$2",[seeded.alpha.workspaceId,seeded.alpha.salesperson.userId]);
 }
});
it('775 parses a current retained first-party original with failed facts without changing product ledgers',async()=>{
 const c=await candidate('alpha',775,true),e=manualLiteralPhoneFixture(c.input.sourceUrl),run=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);
 await db.session.query('UPDATE sourcing_qualification_runs SET facts=$2 WHERE id=$1',[run,JSON.stringify([{malformed:'model'}])]);
 const before=(await db.session.query('SELECT to_jsonb(r) row FROM sourcing_qualification_runs r ORDER BY id')).rows;
 expect(await prospect()).toMatchObject({candidateId:c.id,qualification:'unverified',contactAuthority:'not_granted',phoneEvidence:{state:'observed',value:'+12145550123',coverage:{state:'complete'},sources:[{method:'retained_original_literal',literal:'(214) 555-0123',authority:{kind:'candidate_source'},lineage:{kind:'provider_original'}}]}});
 expect((await db.session.query('SELECT to_jsonb(r) row FROM sourcing_qualification_runs r ORDER BY id')).rows).toEqual(before);
 for(const table of ['jobs','provider_reservations','sourcing_admissions','sequence_enrollments','outbound_messages'])expect((await runtime.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it.each(['hash','truncated','missing_authority','foreign_evidence','stale','latest_empty','no_match'] as const)('775 preserves raw prospect when original is %s',async mode=>{
 const c=await candidate('alpha',775,true),e=manualLiteralPhoneFixture(`${c.input.website}optional`),source=e.observations[0]!;
 if(mode==='hash')source.relevantTextHash='b'.repeat(64);if(mode==='truncated')source.truncated=true;
 if(mode==='no_match'){const empty=manualLiteralPhoneFixture(source.url,['No endpoint captured']);e.observations=empty.observations;}
 const run=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e,mode==='stale'?2:1);
 if(mode!=='missing_authority')await retain(e.observations[0]!,mode==='foreign_evidence'?'beta':'alpha');
 if(mode==='latest_empty'){await db.session.query("UPDATE sourcing_qualification_runs SET requested_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[run]);await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,{observations:[],facts:[]});}
 expect(await prospect()).toMatchObject({candidateId:c.id,observedPhone:null,phoneEvidence:{state:'not_extracted'}});
});
it('775 preserves incomplete/conflicting originals rather than selecting a surviving permitted prefix',async()=>{
 const c=await candidate('alpha',775,true),first=manualLiteralPhoneFixture(c.input.sourceUrl),second=manualLiteralPhoneFixture(`${c.input.website}alternate`,['Phone 555-0123']);
 await retain(second.observations[0]!);await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,{observations:[...first.observations,...second.observations],facts:[]});
 expect(await prospect()).toMatchObject({observedPhone:null,phoneEvidence:{state:'conflicting',reason:'unresolved_retained_literal',sources:[{},{}]}});
 let calls=0;expect(await prospect(async()=>{if(++calls===2)await runtime.query('DELETE FROM evidence_items');return true;})).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted',reason:'optional_source_changed',coverage:{state:'changed'}}});
 expect(await prospect()).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted',reason:'original_not_usable'}});
});
it('775 checks already retained interpretation ancestor/decision/revisions under app_runtime without a forbidden decision update lock',async()=>{
 const c=await candidate('alpha',775,true),e=manualLiteralPhoneFixture(c.input.sourceUrl),source=e.observations[0]!,original=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e),decision=randomUUID();
 await db.session.query(`INSERT INTO sourcing_retained_identity_decisions(workspace_id,id,candidate_id,original_run_id,original_revision,result_revision,reviewer_user_id,observation_id,block_id,content_hash,relevant_text_hash,name_start,name_end)
 VALUES($1,$2,$3,$4,1,1,$5,$6,$7,$8,$9,0,4)`,[seeded.alpha.workspaceId,decision,c.id,original,seeded.alpha.admin.userId,source.id,source.blocks[0]!.id,source.contentHash,source.relevantTextHash]);
 await db.session.query("UPDATE sourcing_qualification_runs SET requested_at=clock_timestamp()-interval '1 minute' WHERE id=$1",[original]);
 const derived=await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);await db.session.query('UPDATE sourcing_qualification_runs SET retained_identity_decision_id=$2 WHERE id=$1',[derived,decision]);
 expect(await prospect()).toMatchObject({phoneEvidence:{state:'observed',sources:[{lineage:{kind:'retained_interpretation',originalRunId:original,decisionId:decision}}]}});
 await db.session.query("UPDATE sourcing_qualification_runs SET observations='[]' WHERE id=$1",[original]);
 expect(await prospect()).toMatchObject({observedPhone:null,phoneEvidence:{state:'not_extracted',reason:'retained_ancestry_unavailable'}});
 await db.session.query('DELETE FROM sourcing_qualification_runs WHERE id=$1',[original]);expect((await prospect()).observedPhone).toBeNull();
});
it('775 revalidates literal original after a real source-check lifecycle wait without hiding unrelated raw prospect',async()=>{
 const c=await candidate('alpha',775,true),lost=await candidate('alpha',776,true),e=manualLiteralPhoneFixture(lost.input.sourceUrl);await retain(e.observations[0]!);
 await seedManualPhoneRun(db.session,seeded.alpha.workspaceId,c.id,e);
 const blocker=await db.appRuntimeSession();await blocker.query('BEGIN');await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`sourcing-discovery-review:${seeded.alpha.workspaceId}`]);
 const reading=list();try{
  await expect.poll(async()=>Number((await db.session.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT pg_advisory_xact_lock%'")).rows[0]?.['n'])).toBe(1);
  await blocker.query(`UPDATE sourcing_candidates SET source_check='{"state":"unavailable","reason":"source_not_permitted"}' WHERE id=$1`,[lost.id]);
 }finally{await blocker.query('COMMIT');}
 expect(await reading).toMatchObject({ok:true,value:{prospects:[{candidateId:c.id,observedPhone:null,phoneEvidence:{state:'not_extracted'}}]}});
});
