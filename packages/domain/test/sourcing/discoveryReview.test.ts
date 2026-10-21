import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import type {DiscoveryReviewInput} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {seedCrm,type SeededCrm} from '../db/support/crmFixtures.ts';
import {saveDiscoveryCandidate,listDiscoveryCandidates} from '../../sourcing/discoveryIntake.ts';
import {recordDiscoveryReview,listUsefulDiscoveryCandidates,readVisibleDiscoveryReview} from '../../sourcing/discoveryReview.ts';
import {eraseDiscoveryReviewsForSources,sweepDiscoveryReviews} from '../../sourcing/discoveryReviewVisibility.ts';
import {deleteCandidate,reviewCandidate,listCandidates,saveCandidate} from '../../sourcing/candidates.ts';
import {requestSourceCheck,runSourceCheck} from '../../sourcing/sourceCheck.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {retentionTargetFor} from '../../retention/targets.ts';
import {DISCOVERY_REVIEW_CONSTRAINT_CASES} from '../db/support/discoveryReviewCases.ts';
import {discoveryReviewCandidate,discoveryHumanReview,retainedDiscoveryExcerpts} from './support/discoveryReviewFixtures.ts';
let database:TestDatabase,seeded:TwoWorkspaces,crm:SeededCrm,runtime:SessionQueryable;
const context=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin',session=runtime)=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace][role].userId,role}),session);
const record=(input:DiscoveryReviewInput,session=runtime)=>withTransaction(session,()=>recordDiscoveryReview(context('alpha','admin',session),input));
const useful=async()=>{const result=await listUsefulDiscoveryCandidates(context(),{status:'needs_review',offset:0});if(!result.ok)throw Error(result.reason);return result.value;};
async function create(index=0,suffix=''){const result=await withTransaction(runtime,()=>saveDiscoveryCandidate(context(),discoveryReviewCandidate(index,suffix)));if(!result.ok)throw Error(result.reason);return result.value.id;}
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);crm=await seedCrm(database.session,seeded);runtime=await database.appRuntimeSession();});
beforeEach(async()=>{await database.session.query('DELETE FROM sourcing_candidates');await database.session.query('DELETE FROM evidence_items');await database.session.query("DELETE FROM jobs WHERE kind='sourcing.check'");});
afterAll(async()=>{await database.drop();});

it.each(DISCOVERY_REVIEW_CONSTRAINT_CASES)('migration127 rejects $constraint',async test=>{
  await database.session.query('BEGIN');
  try{await expect(test.run({session:database.session,seeded})).rejects.toMatchObject({constraint:test.constraint});}finally{await database.session.query('ROLLBACK');}
});
it('covers every review table constraint and denies runtime update while preserving cascade deletion',async()=>{
  const constraints=await database.session.query<{conname:string}>("SELECT conname FROM pg_constraint WHERE conrelid='sourcing_candidate_discovery_reviews'::regclass");
  expect(new Set(constraints.rows.map(row=>row.conname))).toEqual(new Set(DISCOVERY_REVIEW_CONSTRAINT_CASES.map(test=>test.constraint)));
  const id=await create(),saved=await record(discoveryHumanReview(id));expect(saved.ok).toBe(true);
  await expect(runtime.query('UPDATE sourcing_candidate_discovery_reviews SET evidence=evidence')).rejects.toMatchObject({code:'42501'});
  expect(await withTransaction(runtime,()=>deleteCandidate(context(),{id,expectedRevision:1}))).toMatchObject({ok:true});
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);
});
it('keeps Tree and Implicity review-first with identity unknown, heading-only Crosstown tentative and raw unchanged',async()=>{
  for(const index of [0,1,2]){const id=await create(index);expect(await record(discoveryHumanReview(id,index))).toMatchObject({ok:true,value:{review:{candidateRevision:1,assessment:{websiteAssociation:'unknown'}}}});}
  const rows=(await useful()).candidates;
  expect(rows.map(row=>[row.candidate.payload.row.firmName,row.band])).toEqual([['Implicity Management','review_first'],['Tree Realty','review_first'],['Crosstown Properties','tentative']]);
  expect(rows.every(row=>!row.admissionAuthorized&&!row.runtimeCallable)).toBe(true);
  expect(await listDiscoveryCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:expect.arrayContaining([expect.objectContaining({revision:1,payload:{kind:'discovery-v1',row:expect.objectContaining({residentialFit:'unknown',websiteAssociation:'unknown'})}})])}});
  expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
  expect(await withTransaction(runtime,()=>requestQualification(context(),{candidateId:rows[0]!.candidate.id,expectedRevision:1}))).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
  for(const table of ['sourcing_qualification_runs','sourcing_admissions','sequence_enrollments','jobs'])expect((await database.session.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
});
it('deduplicates canonical content across fresh commands and concurrent sessions, corrections append',async()=>{
  const id=await create(),input=discoveryHumanReview(id),first=await record(input);if(!first.ok)throw Error(first.reason);
  const reordered={...input,assessment:{...input.assessment,unknowns:[...input.assessment.unknowns].reverse()}};
  expect(await record(reordered)).toMatchObject({ok:true,value:{alreadyRecorded:true,review:{id:first.value.review.id}}});
  const sessions=await Promise.all([database.appRuntimeSession(),database.appRuntimeSession()]);
  const corrected={...input,assessment:{...input.assessment,serviceSignal:'tentative' as const}};
  const answers=await Promise.all(sessions.map(session=>record(corrected,session)));expect(answers.filter(answer=>answer.ok&&!answer.value.alreadyRecorded)).toHaveLength(1);
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(2);
  expect((await useful()).candidates[0]?.band).toBe('tentative');
});
it('supersession boundary refuses A/B/A while retaining canonical current dedupe',async()=>{
  const id=await create(),a=discoveryHumanReview(id),first=await record(a);if(!first.ok)throw Error(first.reason);
  const b={...a,assessment:{...a.assessment,serviceSignal:'contradicted' as const}},second=await record(b);if(!second.ok)throw Error(second.reason);
  expect(await record(a)).toEqual({ok:false,reason:'review_superseded'});
  expect(await record(b)).toMatchObject({ok:true,value:{alreadyRecorded:true,review:{id:second.value.review.id}}});
  expect((await useful()).candidates[0]).toMatchObject({band:'contradicted',review:{id:second.value.review.id}});
  expect((await runtime.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_review_decisions')).rows[0]?.['n']).toBe(2);
});
it('supersession boundary survives differential current expiry and bounded post-sweep erasure',async()=>{
  const id=await create(),a=discoveryHumanReview(id),first=await record(a);if(!first.ok)throw Error(first.reason);
  const b=structuredClone(a);b.assessment.serviceSignal='contradicted';b.evidence[0]!.retrievedAt=new Date(Date.now()-7*86400000+60000).toISOString();
  const second=await record(b);if(!second.ok)throw Error(second.reason);
  expect((await useful()).candidates[0]?.band).toBe('contradicted');
  await database.session.query("UPDATE sourcing_candidate_discovery_reviews SET evidence=jsonb_set(evidence,'{0,retrievedAt}',to_jsonb((now()-interval '7 days')::text)) WHERE id=$1",[second.value.review.id]);
  expect((await useful()).candidates[0]).toMatchObject({review:null,band:'unreviewed'});
  expect(await withTransaction(runtime,()=>sweepDiscoveryReviews(context(),{now:new Date().toISOString(),limit:1}))).toBe(1);
  expect((await useful()).candidates[0]).toMatchObject({review:null,band:'unreviewed'});
  expect(await readVisibleDiscoveryReview(context(),second.value.review.id)).toBeNull();
  expect((await runtime.query('SELECT id FROM sourcing_candidate_discovery_reviews')).rows).toEqual([{id:first.value.review.id}]);
  expect(await record(a)).toEqual({ok:false,reason:'review_superseded'});
});
it('supersession boundary survives selective source loss without retaining erased content',async()=>{
  const id=await create(),a=discoveryHumanReview(id),first=await record(a);if(!first.ok)throw Error(first.reason);
  const b=structuredClone(a);b.assessment.serviceSignal='contradicted';b.evidence[0]!.url='https://example.test/correction';
  const second=await record(b);if(!second.ok)throw Error(second.reason);
  expect(await withTransaction(runtime,()=>eraseDiscoveryReviewsForSources(context(),[b.evidence[0]!.url]))).toBe(1);
  expect((await useful()).candidates[0]).toMatchObject({review:null,band:'unreviewed'});
  expect(await readVisibleDiscoveryReview(context(),second.value.review.id)).toBeNull();
  expect((await runtime.query('SELECT id FROM sourcing_candidate_discovery_reviews')).rows).toEqual([{id:first.value.review.id}]);
  const columns=await runtime.query<{column_name:string}>("SELECT column_name FROM information_schema.columns WHERE table_name='sourcing_candidate_discovery_review_decisions' ORDER BY ordinal_position");
  expect(columns.rows.map(row=>row.column_name)).toEqual(['workspace_id','candidate_id','review_id','reviewed_at']);
  await expect(runtime.query('UPDATE sourcing_candidate_discovery_review_decisions SET review_id=review_id')).rejects.toMatchObject({code:'42501'});
  await expect(runtime.query('DELETE FROM sourcing_candidate_discovery_review_decisions')).rejects.toMatchObject({code:'42501'});
  await withTransaction(runtime,()=>deleteCandidate(context(),{id,expectedRevision:1}));
  expect((await runtime.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_review_decisions')).rows[0]?.['n']).toBe(0);
});
it('checks admin/workspace/current revision/status/origin before writes and rejects duplicate or conflicting page claims',async()=>{
  const id=await create(),input=discoveryHumanReview(id);
  expect(await recordDiscoveryReview(context('alpha','salesperson'),input)).toMatchObject({ok:false,reason:'admin_only'});
  expect(await withTransaction(runtime,()=>recordDiscoveryReview(context('beta'),input))).toMatchObject({ok:false,reason:'not_found'});
  expect(await record({...input,expectedRevision:2})).toMatchObject({ok:false,reason:'candidate_changed'});
  const foreign=structuredClone(input);foreign.evidence[0]!.source.recordId='foreign';expect(await record(foreign)).toMatchObject({ok:false,reason:'source_not_member'});
  expect(await record({...input,evidence:[...input.evidence,...input.evidence]})).toMatchObject({ok:false,reason:'duplicate_or_conflicting_page'});
  const conflict=structuredClone(input.evidence[0]!);conflict.contentHash='f'.repeat(64);expect(await record({...input,evidence:[...input.evidence,conflict]})).toMatchObject({ok:false,reason:'duplicate_or_conflicting_page'});
  await withTransaction(runtime,()=>reviewCandidate(context(),{id,expectedRevision:1,status:'dismissed'}));
  expect(await record({...input,expectedRevision:2})).toMatchObject({ok:false,reason:'candidate_dismissed'});
  expect(await listUsefulDiscoveryCandidates(context('alpha','salesperson'),{status:'needs_review',offset:0})).toMatchObject({ok:false,reason:'admin_only'});
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);
});
it('refuses future, expired, private URL and heading-as-paragraph evidence before writes',async()=>{
  const id=await create(),input=discoveryHumanReview(id);
  for(const [patch,reason] of [[{retrievedAt:new Date(Date.now()+60000).toISOString()},'retrieval_in_future'],[{retrievedAt:new Date(Date.now()-7*86400000).toISOString()},'evidence_expired'],[{url:'https://127.0.0.1/private'},'invalid_input']] as const){const bad=structuredClone(input);Object.assign(bad.evidence[0]!,patch);expect(await record(bad)).toMatchObject({ok:false,reason});}
  const bad=structuredClone(input);bad.evidence[0]!.blocks[0]!.kind='heading';expect(await record(bad)).toMatchObject({ok:false,reason:'invalid_input'});
  const raw={...input,body:'private message'};expect(await record(raw)).toMatchObject({ok:false,reason:'invalid_input'});
});
it('caps ambiguous association tentative, leaves unknown/no-evidence unreviewed and contradictions never dismiss',async()=>{
  const id=await create(),input=discoveryHumanReview(id);input.evidence[0]!.association='ambiguous';expect((await record(input)).ok).toBe(true);expect((await useful()).candidates[0]?.band).toBe('tentative');
  input.assessment.serviceSignal='contradicted';expect((await record(input)).ok).toBe(true);expect((await useful()).candidates[0]).toMatchObject({band:'contradicted',candidate:{status:'needs_review'}});
  input.assessment.serviceSignal='unknown';input.evidence=[];expect((await record(input)).ok).toBe(true);expect((await useful()).candidates[0]?.band).toBe('unreviewed');
});
it('hides stale current review before sweep, never falls back, erases all copied historical excerpts and preserves origins',async()=>{
  const id=await create(),input=discoveryHumanReview(id),saved=await record(input);if(!saved.ok)throw Error(saved.reason);
  await record({...input,assessment:{...input.assessment,serviceSignal:'tentative'}});
  await database.session.query("UPDATE sourcing_candidate_discovery_reviews SET evidence=jsonb_set(evidence,'{0,retrievedAt}',to_jsonb((now()-interval '7 days')::text))");
  expect((await useful()).candidates[0]).toMatchObject({band:'unreviewed',review:null});expect(await readVisibleDiscoveryReview(context(),saved.value.review.id)).toBeNull();
  expect(await withTransaction(runtime,()=>sweepDiscoveryReviews(context(),{now:new Date().toISOString(),limit:50}))).toBe(2);
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_origins')).rows[0]?.['n']).toBe(1);
});
it('invalidates a review on new origin revision without changing retained provenance',async()=>{
  const id=await create(),input=discoveryHumanReview(id),saved=await record(input);if(!saved.ok)throw Error(saved.reason);
  const extra=discoveryReviewCandidate(0,'-additional');extra.attachTo={candidateId:id,expectedRevision:1};expect(await withTransaction(runtime,()=>saveDiscoveryCandidate(context(),extra))).toMatchObject({ok:true,value:{revision:2}});
  expect((await useful()).candidates[0]).toMatchObject({band:'unreviewed',review:null});expect(await readVisibleDiscoveryReview(context(),saved.value.review.id)).toBeNull();
  expect(await record(input)).toMatchObject({ok:false,reason:'candidate_changed'});
});
it('hides same-workspace known access loss and erases history with the actual existing source-check completion hook',async()=>{
  const id=await create(),input=discoveryHumanReview(id);await record(input);await record({...input,assessment:{...input.assessment,serviceSignal:'tentative'}});
  const url=retainedDiscoveryExcerpts[0].url;
  const legacy=await withTransaction(runtime,()=>saveCandidate(context(),{firmName:'Legacy source check control',website:url,locality:'Austin',region:'TX',signal:'fit_only',evidence:retainedDiscoveryExcerpts[0].text,sourceUrl:url,observedOn:'2026-10-21',preparedBy:'Controlled fixture'}));if(!legacy.ok)throw Error(legacy.reason);
  await withTransaction(runtime,()=>requestSourceCheck(context(),{id:legacy.value.id,expectedRevision:1}));
  const job=(await runtime.query<{payload:{candidateId:string;checkId:string}}>("SELECT payload FROM jobs WHERE kind='sourcing.check'")).rows[0]!.payload;
  await withTransaction(runtime,()=>runSourceCheck(context(),job,{providerKey:'fixture',fetchPages:async()=>({ok:false,costCents:0,failureCode:'controlled_source_unavailable'})}));
  expect((await useful()).candidates[0]).toMatchObject({review:null,band:'unreviewed'});
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);
  expect(await record(input)).toMatchObject({ok:false,reason:'source_unavailable'});
});
it('hides known terms expiry before sweep, clears review copies before original deletion and stays workspace isolated',async()=>{
  const id=await create(),input=discoveryHumanReview(id),saved=await record(input);if(!saved.ok)throw Error(saved.reason);
  const url=input.evidence[0]!.url;
  const evidence=async(workspace:'alpha'|'beta')=>database.session.query("INSERT INTO evidence_items(workspace_id,firm_id,provider,source_reference,content_hash,terms_allow_retention,retention_expires_at) VALUES($1,$2,'website',$3,$4,false,now()-interval '1 second')",[seeded[workspace].workspaceId,crm[workspace].firmId,url,'e'.repeat(64)]);
  await evidence('beta');expect((await useful()).candidates[0]?.band).toBe('review_first');await evidence('alpha');
  expect((await useful()).candidates[0]).toMatchObject({review:null,band:'unreviewed'});expect(await readVisibleDiscoveryReview(context(),saved.value.review.id)).toBeNull();expect(await record(input)).toMatchObject({ok:false,reason:'source_unavailable'});
  const sweep=retentionTargetFor('research_evidence')?.sweep;if(!sweep)throw Error('sweep');
  const result=await withTransaction(runtime,()=>sweep(context(),{now:new Date().toISOString(),boundaryAt:null,limit:50}));expect(result.detail['sourcing_candidate_discovery_reviews']).toBe(1);
  expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);expect((await useful()).candidates[0]?.review).toBeNull();
});
it('source erasure is workspace scoped and review/delete races cannot retain an orphan excerpt',async()=>{
  const id=await create(),input=discoveryHumanReview(id);await record(input);
  expect(await withTransaction(runtime,()=>eraseDiscoveryReviewsForSources(context('beta'),[input.evidence[0]!.url]))).toBe(0);
  const sessions=await Promise.all([database.appRuntimeSession(),database.appRuntimeSession()]);
  const outcomes=await Promise.all([record({...input,assessment:{...input.assessment,serviceSignal:'tentative'}},sessions[0]!),withTransaction(sessions[1]!,()=>deleteCandidate(context('alpha','admin',sessions[1]),{id,expectedRevision:1}))]);
  expect(outcomes[1]).toMatchObject({ok:true});expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_reviews')).rows[0]?.['n']).toBe(0);expect((await useful()).candidates).toEqual([]);
  expect(await record(input)).toMatchObject({ok:false,reason:'not_found'});
});
it('stable 50-row pages and optional band filtering do not depend on phones, locality, confidence or receipts',async()=>{
  for(let n=0;n<52;n++)await create(0,`-page-${n}`);
  const first=await useful(),again=await useful(),second=await listUsefulDiscoveryCandidates(context(),{status:'needs_review',offset:50});
  expect(first.candidates).toHaveLength(50);expect(first.hasMore).toBe(true);expect(again).toEqual(first);expect(second).toMatchObject({ok:true,value:{candidates:expect.any(Array),hasMore:false}});
  if(!second.ok)throw Error(second.reason);expect(second.value.candidates).toHaveLength(2);expect(new Set([...first.candidates,...second.value.candidates].map(row=>row.candidate.id)).size).toBe(52);
  expect(await listUsefulDiscoveryCandidates(context(),{status:'needs_review',offset:0,band:'review_first'})).toMatchObject({ok:true,value:{candidates:[],hasMore:false}});
  const id=first.candidates[0]!.candidate.id;const row=first.candidates[0]!.candidate.payload.row;const input=discoveryHumanReview(id);input.evidence[0]!.source={provider:row.source.provider,release:row.source.release,recordId:row.source.recordId};await record(input);
  expect(await listUsefulDiscoveryCandidates(context(),{status:'needs_review',offset:0,band:'review_first'})).toMatchObject({ok:true,value:{candidates:[{candidate:{id},band:'review_first'}],hasMore:false}});
});
