import {afterAll,beforeAll,beforeEach,afterEach,describe,it,expect} from 'vitest';
import {createHash} from 'node:crypto';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {databaseNow} from '../../policy/clock.ts';
import {beginFirmResearch,ensureResearchCalling,finishFirmResearch,runFirmResearch} from '../../research/enrichment.ts';
import {readFirmOfficeAssessment} from '../../research/officeAssessmentStore.ts';
import {officeProviders,officeHtml} from '../support/officeProviders.ts';
import {listRuns,nextRevision} from '../../research/runs.ts';
import {enqueueFirmResearch} from '../../research/enqueue.ts';
import {readCallBrief,countFailedTries} from '../../research/brief.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {sweepOfficeSources} from '../../retention/officeAssessments.ts';
import {createFirm} from '../../crm/firms.ts';
import {mergeFirms} from '../../crm/merges.ts';
import {recordSuppression} from '../../suppression/events.ts';
import {openHold} from '../../policy/holds.ts';
import {selectFirmsForSweep} from '../../research/sweep.ts';
let database:TestDatabase,members:TwoWorkspaces,crm:SeededCrm,ctx:RepositoryContext;
beforeAll(async()=>{database=await createTestDatabase();members=await seedTwoWorkspaces(database.session);crm=await seedCrm(database.session,members);ctx=repositoryContext(workspaceScope(members.alpha.workspaceId,{kind:'user',role:'admin',userId:members.alpha.admin.userId}),database.session);});
afterAll(async()=>{await database.drop();});
beforeEach(async()=>{await database.session.query('BEGIN');await database.session.query('INSERT INTO research_settings(workspace_id,enabled) VALUES($1,true) ON CONFLICT(workspace_id) DO UPDATE SET enabled=true',[members.alpha.workspaceId]);});
afterEach(async()=>{await database.session.query('ROLLBACK');});
async function input(){return {firmId:crm.alpha.firmId,revision:1,trigger:'user_request' as const,requestedByUserId:members.alpha.admin.userId,purpose:'office_evidence' as const,at:await databaseNow(ctx)};}
const read=()=>readFirmOfficeAssessment(ctx,{firmId:crm.alpha.firmId});
async function assess(options:Parameters<typeof officeProviders>[0]={}){const providers=officeProviders({retrievedAt:await databaseNow(ctx),...options});const result=await runFirmResearch(ctx,{...await input(),...providers});expect(result.ok).toBe(true);return providers;}
async function sources(){return (await database.session.query<{evidence_id:string;observation:unknown;facts:unknown}>(`SELECT evidence_id,observation,facts FROM firm_office_assessment_sources WHERE workspace_id=$1`,[members.alpha.workspaceId])).rows;}
describe('existing manual firm strict office assessment',()=>{
 it('rebuilds persisted source-owned proof without ordinary writes or route authority',async()=>{
  const before=(await database.session.query('SELECT * FROM phone_routes WHERE workspace_id=$1',[members.alpha.workspaceId])).rows;
  const providers=await assess();expect(await read()).toMatchObject({status:'supported',sourceCount:1});expect(providers.stats()).toEqual({fetches:1,counts:1,calls:1});expect(providers.requests[0]).toEqual(providers.requests[1]);
  expect(Object.keys(providers.requests[0]!.candidate)).toEqual(['firmName','website','locality','region']);
  expect(await listRuns(ctx,crm.alpha.firmId)).toEqual([]);expect(await readCallBrief(ctx,crm.alpha.firmId)).toBeNull();expect(await countFailedTries(ctx,crm.alpha.firmId)).toBe(0);
  expect((await database.session.query('SELECT * FROM phone_routes WHERE workspace_id=$1',[members.alpha.workspaceId])).rows).toEqual(before);
  for(const table of ['firm_facts','firm_judgments','sourcing_candidates','sourcing_admissions'])expect((await database.session.query(`SELECT count(*)::integer AS n FROM ${table} WHERE workspace_id=$1`,[members.alpha.workspaceId])).rows[0]?.['n']).toBe(0);
  expect((await sources())[0]?.facts).toBeTruthy();
  expect((await database.session.query('SELECT purpose,brief,facts_recorded FROM research_runs WHERE workspace_id=$1',[members.alpha.workspaceId])).rows).toEqual([{purpose:'office_evidence',brief:null,facts_recorded:0}]);
 });
 it.each([
  ['contradictory',officeHtml.replace('</main>','<p>We do not manage residential properties.</p></main>')],
  ['foreign geography',officeHtml.replaceAll('Providence','Boston').replaceAll('RI','MA')],
  ['service-area without office',officeHtml.replace('123 Main Street, Providence, RI 02903','Service area Providence, RI')],
  ['ambiguous phones',officeHtml.replace('</section>','<p>Office: (401) 555-0188</p></section>')],
  ['mismatched phone',officeHtml.replace('555-0187','555-0188')],
 ])('fails closed on %s',async(_label,html)=>{await assess({html});expect((await read()).status).not.toBe('supported');});
 it('refuses overbudget without trimming, extra count or model call',async()=>{const providers=await assess({count:1_000_000});expect(providers.stats()).toEqual({fetches:1,counts:1,calls:0});expect((await read()).status).not.toBe('supported');});
 it('records unknown model cost without a repair attempt',async()=>{const providers=await assess({throwExtract:true});expect(providers.stats().calls).toBe(1);expect((await database.session.query("SELECT state,settled_cents FROM provider_reservations WHERE workspace_id=$1",[members.alpha.workspaceId])).rows[0]).toMatchObject({state:'estimated'});expect((await read()).status).not.toBe('supported');});
 it('does not reopen a calling strict reservation after fencing loss',async()=>{const request=await input();const start=await beginFirmResearch(ctx,request);if(!start.ok||start.value.kind!=='reserved')throw new Error('start failed');const permission=await ensureResearchCalling(ctx,{runId:start.value.runId,at:request.at,maxReservations:3,hasExtraction:true});expect(permission.kind).toBe('calling');expect((await ensureResearchCalling(ctx,{runId:start.value.runId,at:request.at,maxReservations:3,hasExtraction:true})).kind).toBe('closed');expect((await database.session.query('SELECT state FROM provider_reservations WHERE workspace_id=$1',[members.alpha.workspaceId])).rows).toEqual([{state:'estimated'}]);});
 it('invalidates route correction during token await before dispatch',async()=>{const providers=await assess({beforeCount:async()=>{await database.session.query('UPDATE phone_routes SET version=version+1 WHERE workspace_id=$1',[members.alpha.workspaceId]);}});expect(providers.stats().calls).toBe(0);expect((await read()).status).not.toBe('supported');});
 it('settles incurred cost but never publishes identity changes during model await',async()=>{await assess({beforeExtract:async()=>{await database.session.query("UPDATE firms SET name='Changed identity' WHERE workspace_id=$1 AND id=$2",[members.alpha.workspaceId,crm.alpha.firmId]);}});expect(await sources()).toEqual([]);expect((await read()).status).not.toBe('supported');expect((await database.session.query('SELECT state FROM provider_reservations WHERE workspace_id=$1',[members.alpha.workspaceId])).rows).toEqual([{state:'settled'}]);});
 it('source deletion erases all copied facts and cannot fallback to older support',async()=>{await assess();const source=(await sources())[0]!;await database.session.query('DELETE FROM evidence_items WHERE workspace_id=$1 AND id=$2',[members.alpha.workspaceId,source.evidence_id]);expect(await sources()).toEqual([]);expect(await read()).toMatchObject({status:'stale',reason:'source_lost'});});
 it('source terms invalidate read immediately and expiry sweep erases copied bodies',async()=>{await assess();await database.session.query("UPDATE evidence_items SET retention_expires_at=now()-interval '1 second' WHERE workspace_id=$1",[members.alpha.workspaceId]);expect((await read()).status).toBe('stale');expect(await sweepOfficeSources(ctx,{now:await databaseNow(ctx),limit:10})).toBe(1);expect(await sources()).toEqual([]);});
 it('contact deletion preview and actual source erasure agree',async()=>{await assess();const preview=await previewDeletion(ctx,{targetKind:'contact',firmId:crm.alpha.firmId,contactId:crm.alpha.contactId});if(!preview.ok)throw new Error(preview.reason);expect(preview.value.removes['firm_office_assessment_sources']).toBe(1);const result=await commitDeletion(ctx,{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:'office-contact-erasure',journal:recordingSuppressionJournal()});expect(result.ok).toBe(true);expect(await sources()).toEqual([]);expect((await read()).status).not.toBe('supported');});
 it('ordinary pending job gets a different global revision, strict duplicate reuses its job',async()=>{const ordinary=await enqueueFirmResearch(ctx,{firmId:crm.alpha.firmId,trigger:'user_request',requestedByUserId:members.alpha.admin.userId});const strict=await enqueueFirmResearch(ctx,{...await input()});expect(ordinary.ok&&ordinary.value.revision).toBe(1);expect(strict.ok&&strict.value.revision).toBe(2);const duplicate=await enqueueFirmResearch(ctx,{...await input()});expect(duplicate.ok&&duplicate.value).toMatchObject({revision:2,inserted:false,purpose:'office_evidence'});expect(await nextRevision(ctx,crm.alpha.firmId)).toBe(3);});
 it('queued newer strict intent hides prior supported result',async()=>{await assess();expect((await read()).status).toBe('supported');await enqueueFirmResearch(ctx,{...await input()});expect(await read()).toMatchObject({status:'pending',reason:'queued',assessmentId:null});});
 it('does not reuse an outstanding job whose strict run is already terminal',async()=>{await enqueueFirmResearch(ctx,{...await input()});await assess();const next=await enqueueFirmResearch(ctx,{...await input()});expect(next.ok&&next.value).toMatchObject({revision:2,inserted:true,purpose:'office_evidence'});});
 it('crossworkspace and colleague reads never disclose proof',async()=>{await assess();const foreign=repositoryContext(workspaceScope(members.beta.workspaceId,{kind:'system',component:'worker'}),database.session);expect((await readFirmOfficeAssessment(foreign,{firmId:crm.alpha.firmId})).status).toBe('not_evaluated');const colleague=repositoryContext(workspaceScope(members.alpha.workspaceId,{kind:'user',role:'salesperson',userId:members.beta.salesperson.userId}),database.session);expect((await readFirmOfficeAssessment(colleague,{firmId:crm.alpha.firmId})).status).toBe('not_evaluated');});
 it('staged strict run does not recapture after route change between chunks',async()=>{const request=await input();const started=await beginFirmResearch(ctx,request);if(!started.ok||started.value.kind!=='reserved')throw new Error('start failed');await database.session.query('UPDATE phone_routes SET version=version+1 WHERE workspace_id=$1',[members.alpha.workspaceId]);const permission=await ensureResearchCalling(ctx,{runId:started.value.runId,at:request.at,maxReservations:3,hasExtraction:true});if(permission.kind!=='calling')throw new Error('permission failed');const providers=officeProviders();await finishFirmResearch(ctx,{...request,...providers,runId:started.value.runId,attempt:1,mayCall:true});expect(providers.stats()).toEqual({fetches:0,counts:0,calls:0});expect((await read()).status).not.toBe('supported');});
 it('does not infer a target when two eligible routes exist',async()=>{
  await database.session.query(`INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550188','research_provider',now(),1,'passed','usable','test')`,[members.alpha.workspaceId,crm.alpha.firmId]);
  const p=await assess();expect(p.stats()).toEqual({fetches:0,counts:0,calls:0});expect(await read()).toMatchObject({status:'stale',reason:'target_ambiguous'});
 });
 it('refuses stale fetched evidence before count and never repairs it with a second call',async()=>{const p=await assess({retrievedAt:new Date(Date.parse(await databaseNow(ctx))-8*86400000).toISOString()});expect(p.stats()).toEqual({fetches:1,counts:0,calls:0});expect(await sources()).toEqual([]);});
 it('rechecks source terms after counting and before dispatch',async()=>{const p=await assess({beforeCount:async()=>{await database.session.query('UPDATE evidence_items SET terms_allow_retention=false,retention_expires_at=now()-interval \'1 second\' WHERE workspace_id=$1',[members.alpha.workspaceId]);}});expect(p.stats().calls).toBe(0);expect(await sources()).toEqual([]);});
 it('rebuilds literal facts and version guards rather than trusting stored positive status',async()=>{
  await assess();await database.session.query(`UPDATE firm_office_assessment_sources SET facts=jsonb_set(facts,'{0,value}','"invented quote"') WHERE workspace_id=$1`,[members.alpha.workspaceId]);expect(await read()).toMatchObject({status:'stale',reason:'invalid_evidence'});
  await database.session.query("UPDATE firm_office_assessments SET assessment_version='future-policy' WHERE workspace_id=$1",[members.alpha.workspaceId]);expect(await read()).toMatchObject({status:'stale',reason:'policy_changed'});
 });
 it('strict completion does not suppress an ordinary never-researched firm from refresh',async()=>{await assess();const due=await selectFirmsForSweep(ctx,{at:await databaseNow(ctx),limit:5,extractionConfigured:true});expect(due.map(f=>f.firmId)).toContain(crm.alpha.firmId);});
 it('a firm stop during token await prevents dispatch',async()=>{const p=await assess({beforeCount:async()=>{expect((await recordSuppression(ctx,{scope:'firm',firmId:crm.alpha.firmId,source:'salesperson_manual',channel:'all',journal:recordingSuppressionJournal()})).ok).toBe(true);}});expect(p.stats().calls).toBe(0);expect(await sources()).toEqual([]);});
 it('an owner research hold during model await settles cost but prevents publication',async()=>{await assess({beforeExtract:async()=>{await openHold(ctx,{scopeKind:'owner',scopeKey:members.alpha.salesperson.userId,reasonCode:'scoped_pause',blockedActionKinds:['research'],sourceEventKind:'office-test'});}});expect(await sources()).toEqual([]);expect((await read()).status).not.toBe('supported');});
 it('merge preserves source ownership and never rebinds a supported assessment to the survivor',async()=>{
  await assess();const target=await createFirm(ctx,{name:'Merge survivor'});if(!target.ok)throw new Error(target.reason);
  const source=(await sources())[0]!;const merged=await mergeFirms(ctx,{sourceFirmId:crm.alpha.firmId,targetFirmId:target.value.id,journal:recordingSuppressionJournal()});expect(merged.ok).toBe(true);
  expect((await database.session.query('SELECT firm_id FROM evidence_items WHERE id=$1',[source.evidence_id])).rows).toEqual([{firm_id:crm.alpha.firmId}]);expect((await read()).status).not.toBe('supported');expect((await readFirmOfficeAssessment(ctx,{firmId:target.value.id})).status).toBe('not_evaluated');
 });
 it('loss of an unselected source invalidates the full result even when the remaining source proves an office',async()=>{
  const p=officeProviders({retrievedAt:await databaseNow(ctx)}),fetch=p.pageFetch.fetchPages;
  const second=`${officeHtml}<p>Contact office information.</p>`;
  p.pageFetch.fetchPages=async request=>{const answer=await fetch(request);return answer.ok?{...answer,value:{...answer.value,pages:[...answer.value.pages,{...answer.value.pages[0]!,url:'https://northwind.example.test/contact',body:new TextEncoder().encode(second),contentHash:createHash('sha256').update(second).digest('hex')}]}}:answer;};
  await runFirmResearch(ctx,{...await input(),...p});expect(await read()).toMatchObject({status:'supported',sourceCount:2});
  await database.session.query("DELETE FROM evidence_items WHERE workspace_id=$1 AND source_reference LIKE '%/contact'",[members.alpha.workspaceId]);expect(await sources()).toHaveLength(1);expect(await read()).toMatchObject({status:'stale',reason:'source_lost'});
 });
 it('a dropped page fails closed before count and a long literal block is never trimmed into positive evidence',async()=>{
  const p=officeProviders({retrievedAt:await databaseNow(ctx)}),fetch=p.pageFetch.fetchPages;
  p.pageFetch.fetchPages=async request=>{const answer=await fetch(request);return answer.ok?{...answer,value:{...answer.value,skipped:{too_large:1}}}:answer;};
  await runFirmResearch(ctx,{...await input(),...p});expect(p.stats().counts).toBe(0);expect((await read()).status).not.toBe('supported');
  const long=officeProviders({retrievedAt:await databaseNow(ctx),html:`${officeHtml}<p>${'x'.repeat(5000)}</p>`});await runFirmResearch(ctx,{...await input(),revision:2,...long});expect(long.stats().counts).toBe(0);expect((await read()).status).not.toBe('supported');
 });
 it('does not refresh an immutable capture after a thirty minute chunk wait',async()=>{
  const request=await input(),started=await beginFirmResearch(ctx,request);if(!started.ok||started.value.kind!=='reserved')throw new Error('start failed');
  await database.session.query("UPDATE firm_office_assessments SET captured_at=captured_at-interval '31 minutes',expires_at=expires_at-interval '31 minutes' WHERE workspace_id=$1",[members.alpha.workspaceId]);
  await ensureResearchCalling(ctx,{runId:started.value.runId,at:request.at,maxReservations:3,hasExtraction:true});const p=officeProviders();await finishFirmResearch(ctx,{...request,...p,runId:started.value.runId,attempt:1,mayCall:true});expect(p.stats().fetches).toBe(0);expect((await read()).status).not.toBe('supported');
 });
 it('merge during a token-count await prevents model dispatch and does not rebind the pending target',async()=>{
  const target=await createFirm(ctx,{name:'Pending merge survivor'});if(!target.ok)throw new Error(target.reason);
  const p=await assess({beforeCount:async()=>{expect((await mergeFirms(ctx,{sourceFirmId:crm.alpha.firmId,targetFirmId:target.value.id,journal:recordingSuppressionJournal()})).ok).toBe(true);}});expect(p.stats().calls).toBe(0);expect(await sources()).toEqual([]);expect((await readFirmOfficeAssessment(ctx,{firmId:target.value.id})).status).toBe('not_evaluated');
 });
 it('observes an elapsed capture deadline after token await even though transaction now() is unchanged',async()=>{
  const p=await assess({beforeCount:async()=>{await database.session.query("UPDATE firm_office_assessments SET captured_at=clock_timestamp()-interval '30 minutes'+interval '100 milliseconds' WHERE workspace_id=$1",[members.alpha.workspaceId]);await database.session.query('SELECT pg_sleep(0.15)');}});expect(p.stats()).toEqual({fetches:1,counts:1,calls:0});expect(await sources()).toEqual([]);
 });
 it('a source deleted during model await cannot leave copied blocks or publish support',async()=>{await assess({beforeExtract:async()=>{await database.session.query('DELETE FROM evidence_items WHERE workspace_id=$1',[members.alpha.workspaceId]);}});expect(await sources()).toEqual([]);expect((await read()).status).not.toBe('supported');expect((await database.session.query('SELECT state FROM provider_reservations WHERE workspace_id=$1',[members.alpha.workspaceId])).rows).toEqual([{state:'settled'}]);});
 it('reports an early refused strict intent without falling back to previous support',async()=>{await assess();await database.session.query(`INSERT INTO research_runs(workspace_id,firm_id,revision,purpose,trigger,requested_by_user_id,outcome,refusal_code,completed_at) VALUES($1,$2,2,'office_evidence','user_request',$3,'refused','daily_cost_ceiling',now())`,[members.alpha.workspaceId,crm.alpha.firmId,members.alpha.admin.userId]);expect(await read()).toMatchObject({status:'pending',reason:'daily_cost_ceiling',assessmentId:null});});
 it('cannot attach another workspace evidence to an existing source child',async()=>{
  await assess();const foreign=(await database.session.query<{id:string}>(`INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash) VALUES($1,$2,'company_page','https://northwind.example.test',$3) RETURNING id`,[members.beta.workspaceId,crm.beta.firmId,'f'.repeat(64)])).rows[0]!.id;
  await database.session.query('SAVEPOINT wrong_evidence_owner');await expect(database.session.query('UPDATE firm_office_assessment_sources SET evidence_id=$1 WHERE workspace_id=$2',[foreign,members.alpha.workspaceId])).rejects.toMatchObject({constraint:'office_source_evidence_fkey'});await database.session.query('ROLLBACK TO SAVEPOINT wrong_evidence_owner');expect((await read()).status).toBe('supported');
 });
 it('contact erasure between committed capture and dispatch cannot restore a new copy',async()=>{
  const request=await input(),started=await beginFirmResearch(ctx,request);if(!started.ok||started.value.kind!=='reserved')throw new Error('start failed');
  const preview=await previewDeletion(ctx,{targetKind:'contact',firmId:crm.alpha.firmId,contactId:crm.alpha.contactId});if(!preview.ok)throw new Error(preview.reason);expect((await commitDeletion(ctx,{requestId:preview.value.requestId,previewHash:preview.value.previewHash,commandId:'pending-office-erasure',journal:recordingSuppressionJournal()})).ok).toBe(true);
  await ensureResearchCalling(ctx,{runId:started.value.runId,at:request.at,maxReservations:3,hasExtraction:true});const p=officeProviders();await finishFirmResearch(ctx,{...request,...p,runId:started.value.runId,attempt:1,mayCall:true});expect(p.stats().calls).toBe(0);expect(await sources()).toEqual([]);expect((await read()).status).not.toBe('supported');
 });
});
