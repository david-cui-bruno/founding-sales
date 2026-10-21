import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {readFile,writeFile} from 'node:fs/promises';
import {discoveryIntakeSaveInputSchema} from '@fss/contracts';
import type {DiscoveryIntakeSaveInput} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable,type QueryResultRowLike} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveDiscoveryCandidate,listDiscoveryCandidates} from '../../sourcing/discoveryIntake.ts';
import {listCandidates,reviewCandidate,deleteCandidate,saveCandidate} from '../../sourcing/candidates.ts';
import {requestSourceCheck} from '../../sourcing/sourceCheck.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {admitCandidate} from '../../sourcing/admission.ts';
import {admitCallingCandidate} from '../../sourcing/callingAdmission.ts';
import {correctCandidateName} from '../../sourcing/candidateCorrection.ts';
let database:TestDatabase,seeded:TwoWorkspaces,runtime:SessionQueryable;
export function discoveryFixture(recordId='fixture-1'):DiscoveryIntakeSaveInput {
 const source={provider:'overture_places' as const,recordId,release:'fixture-release',retrievedAt:null,sourceUrl:'https://example.test/source'};
 return {row:{source,observations:[source],firmName:'Synthetic PM',website:null,locality:null,region:'CA',sourceConfidence:0.7,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'observed_source',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[{"dataset":"synthetic","license":"CDLA-Permissive-2.0"}]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'Fixture notice',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]};
}
const context=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin',session=runtime)=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace][role].userId,role}),session);
const save=(input=discoveryFixture(),session=runtime,workspace:'alpha'|'beta'='alpha')=>withTransaction(session,()=>saveDiscoveryCandidate(context(workspace,'admin',session),input));
it.skipIf(!process.env['FSS_DISCOVERY_RETAINED_INPUT'])('loads and replays an explicitly supplied retained batch only in disposable local database',async()=>{
 const started=Date.now(),inputs=JSON.parse(await readFile(process.env['FSS_DISCOVERY_RETAINED_INPUT']!,'utf8')) as unknown[];
 let created=0,duplicates=0;
 for(const raw of inputs){const result=await save(discoveryIntakeSaveInputSchema.parse(raw));expect(result.ok).toBe(true);if(result.ok)created+=result.value.newlyPersisted;}
 for(const raw of inputs){const result=await save(discoveryIntakeSaveInputSchema.parse(raw));expect(result.ok).toBe(true);if(result.ok)duplicates+=result.value.exactDuplicates;}
 let listed=0,more=true;while(more){const result=await listDiscoveryCandidates(context(),{status:'needs_review',offset:listed});if(!result.ok)throw Error(result.reason);listed+=result.value.candidates.length;more=result.value.hasMore;}
 expect(created).toBe(inputs.length);expect(duplicates).toBe(inputs.length);expect(listed).toBe(inputs.length);
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
 const metrics={rawRows:inputs.length,newlyPersisted:created,exactReplayDuplicates:duplicates,listed,elapsedMilliseconds:Date.now()-started,productionWrites:0,qualified:0,callable:0,contactAuthorized:0};
 if(process.env['FSS_DISCOVERY_RETAINED_METRICS'])await writeFile(process.env['FSS_DISCOVERY_RETAINED_METRICS'],JSON.stringify(metrics,null,2)+'\n');
},60000);
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);runtime=await database.appRuntimeSession();});
beforeEach(async()=>{await database.session.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await database.drop();});
it('retains nullable nationwide discovery and immutable provenance without legacy or CRM admission',async()=>{
 const input=discoveryFixture(),first=await save(input);expect(first).toMatchObject({ok:true,value:{revision:1,newlyPersisted:1,observationsAttached:1}});
 expect(await save(input)).toMatchObject({ok:true,value:{revision:1,newlyPersisted:0,exactDuplicates:1}});
 expect(await listDiscoveryCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[{payload:{kind:'discovery-v1',row:input.row},origins:input.origins}]}});
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
 if(!first.ok)throw Error('save');const id=first.value.id;
 for(const operation of [()=>reviewCandidate(context(),{id,expectedRevision:1,status:'kept'}),()=>requestSourceCheck(context(),{id,expectedRevision:1}),()=>requestQualification(context(),{candidateId:id,expectedRevision:1})])expect(await withTransaction<unknown>(runtime,operation)).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 for(const table of ['firms','opportunities','sequence_enrollments','jobs','sourcing_qualification_runs'])expect((await database.session.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 await expect(runtime.query('UPDATE sourcing_candidate_discovery_origins SET source=source')).rejects.toMatchObject({code:'42501'});
});
it('distinguishes exact records from probable brand groups and refuses source overwrites',async()=>{
 const one=discoveryFixture('one'),two=discoveryFixture('two');one.row.probableGroupKey=two.row.probableGroupKey='same-brand';
 expect(await save(one)).toMatchObject({ok:true,value:{newlyPersisted:1}});expect(await save(two)).toMatchObject({ok:true,value:{newlyPersisted:1}});
 const changed=structuredClone(one);changed.origins[0]!.sourceMetadata.sourcesJson='[{"dataset":"replacement"}]';expect(await save(changed)).toMatchObject({ok:false,reason:'source_conflict'});
 expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidates')).rows[0]?.['n']).toBe(2);
});
it('serializes concurrent exact replays using real runtime sessions',async()=>{
 const sessions=await Promise.all([database.appRuntimeSession(),database.appRuntimeSession(),database.appRuntimeSession()]);
 const results=await Promise.all(sessions.map(session=>save(discoveryFixture(),session)));
 expect(results.filter(result=>result.ok&&result.value.newlyPersisted===1)).toHaveLength(1);expect(results.filter(result=>result.ok&&result.value.exactDuplicates===1)).toHaveLength(2);
});
it('attaches observations only with revision, preserves primary source and rejects stale/conflicting identity',async()=>{
 const first=await save();if(!first.ok)throw Error('save');const second=discoveryFixture('second');second.attachTo={candidateId:first.value.id,expectedRevision:1};
 expect(await save(second)).toMatchObject({ok:true,value:{revision:2,observationsAttached:1,newlyPersisted:0}});
 expect(await save(second)).toMatchObject({ok:false,reason:'candidate_changed'});
 second.attachTo.expectedRevision=2;expect(await save(second)).toMatchObject({ok:true,value:{revision:2,exactDuplicates:1}});
 const third=discoveryFixture('third');third.row.firmName='Different';third.attachTo={candidateId:first.value.id,expectedRevision:2};expect(await save(third)).toMatchObject({ok:false,reason:'candidate_identity_conflict'});
 const list=await listDiscoveryCandidates(context(),{status:'needs_review',offset:0});expect(list.ok&&list.value.candidates[0]?.payload.row.observations).toHaveLength(2);
});
it('rejects forged labels, privacy fields and bounds before any mutations',async()=>{
 for(const patch of [{residentialFit:'supported'},{officePhoneEvidence:'office_supported'},{email:'person@example.test'}]){
 const value=discoveryFixture();Object.assign(value.row,patch);expect(await save(value)).toMatchObject({ok:false,reason:'invalid_input'});
 }
 const value=discoveryFixture();value.origins[0]!.sourceMetadata.sourcesJson='[{"email":"person@example.test"}]';expect(await save(value)).toMatchObject({ok:false,reason:'invalid_input'});
 value.origins[0]!.sourceMetadata.sourcesJson=JSON.stringify([{dataset:'x'.repeat(9000)}]);expect(await save(value)).toMatchObject({ok:false,reason:'invalid_input'});
 expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidates')).rows[0]?.['n']).toBe(0);
});
it('isolates workspaces, refuses salespeople and cascades normal deletion without reopening dismissal',async()=>{
 expect(await saveDiscoveryCandidate(context('alpha','salesperson'),discoveryFixture())).toMatchObject({ok:false,reason:'admin_only'});
 const a=await save(),b=await save(discoveryFixture(),runtime,'beta');if(!a.ok||!b.ok)throw Error('save');
 expect(a.value.id).not.toBe(b.value.id);expect(await listDiscoveryCandidates(context('beta'),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[{id:b.value.id}]}});
 await withTransaction(runtime,()=>reviewCandidate(context(),{id:a.value.id,expectedRevision:1,status:'dismissed'}));expect(await save()).toMatchObject({ok:true,value:{revision:2,newlyPersisted:0}});
 await withTransaction(runtime,()=>deleteCandidate(context(),{id:a.value.id,expectedRevision:2}));expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_origins')).rows[0]?.['n']).toBe(1);
});
it('paginates unverified discovery independently of legacy runtime caps',async()=>{
 for(let i=0;i<51;i++)await save(discoveryFixture(`page-${i}`));
 const first=await listDiscoveryCandidates(context(),{status:'needs_review',offset:0}),last=await listDiscoveryCandidates(context(),{status:'needs_review',offset:50});
 expect(first.ok&&first.value.candidates).toHaveLength(50);expect(first.ok&&first.value.hasMore).toBe(true);expect(last.ok&&last.value.candidates).toHaveLength(1);
});
it('rejects seventeenth origins and oversized merged payloads without partial attachments',async()=>{
 const first=await save();if(!first.ok)throw Error('save');
 for(let i=1;i<16;i++){const input=discoveryFixture(`origin-${i}`);input.attachTo={candidateId:first.value.id,expectedRevision:i};expect(await save(input)).toMatchObject({ok:true,value:{revision:i+1}});}
 const excess=discoveryFixture('origin-17');excess.attachTo={candidateId:first.value.id,expectedRevision:16};expect(await save(excess)).toMatchObject({ok:false,reason:'origin_limit'});
 expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_origins')).rows[0]?.['n']).toBe(16);
 await database.session.query('DELETE FROM sourcing_candidates');
 const large=discoveryFixture('large'.padEnd(500,'x'));large.row.source.sourceUrl=`https://example.test/${'x'.repeat(470)}`;large.row.source.release='r'.repeat(200);
 const saved=await save(large);expect(saved.ok).toBe(true);if(!saved.ok)throw Error('save');let revision=1,rejected=false;
 for(let i=0;i<16;i++){const next=discoveryFixture(`large-${i}`.padEnd(500,'x'));next.row.source.sourceUrl=large.row.source.sourceUrl;next.row.source.release=large.row.source.release;next.attachTo={candidateId:saved.value.id,expectedRevision:revision};const result=await save(next);if(!result.ok){expect(result.reason).toBe('candidate_payload_too_large');rejected=true;break;}revision=result.value.revision;}
 expect(rejected).toBe(true);expect((await database.session.query('SELECT revision FROM sourcing_candidates')).rows[0]?.['revision']).toBe(revision);
});
it('requires revision for overlapping attachments and lets only one concurrent revision win',async()=>{
 const first=await save();if(!first.ok)throw Error('save');
 const mixed=discoveryFixture();const newOrigin=discoveryFixture('additional').origins[0]!;mixed.origins.push(newOrigin);mixed.row.observations.push(newOrigin.source);
 expect(await save(mixed)).toMatchObject({ok:false,reason:'attachment_requires_revision'});
 const inputs=['race-a','race-b'].map(id=>({...discoveryFixture(id),attachTo:{candidateId:first.value.id,expectedRevision:1}}));
 const sessions=await Promise.all(inputs.map(()=>database.appRuntimeSession()));const results=await Promise.all(inputs.map((input,i)=>save(input,sessions[i]!)));
 expect(results.filter(result=>result.ok)).toHaveLength(1);expect(results.filter(result=>!result.ok&&result.reason==='candidate_changed')).toHaveLength(1);
 expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_origins')).rows[0]?.['n']).toBe(2);
});
it('checks PostgreSQL metadata byte expansion before any write',async()=>{
 const input=discoveryFixture(),metadata=input.origins[0]!.sourceMetadata;metadata.sourcesJson='[]';
 metadata.sourcesJson+=' '.repeat(8192-new TextEncoder().encode(JSON.stringify(metadata)).length);
 expect(discoveryIntakeSaveInputSchema.safeParse(input).success).toBe(true);
 expect(await save(input)).toMatchObject({ok:false,reason:'origin_payload_too_large'});
 expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidates')).rows[0]?.['n']).toBe(0);
});
it.each(['attach','delete'] as const)('returns one coherent list snapshot when %s commits before response',async operation=>{
 const first=await save();if(!first.ok)throw Error('save');const writer=await database.appRuntimeSession();let interleaved=false,reads=0;
 const readSession:SessionQueryable={query:async<Row extends QueryResultRowLike>(text:string,values?:readonly unknown[])=>{
  reads++;const result=await runtime.query<Row>(text,values);
  if(text.includes('FROM sourcing_candidates')&&text.includes('LIMIT 51')&&!interleaved){
   interleaved=true;
   if(operation==='attach'){const input=discoveryFixture('attached-during-list');input.attachTo={candidateId:first.value.id,expectedRevision:1};expect(await save(input,writer)).toMatchObject({ok:true,value:{revision:2}});}
   else expect(await withTransaction(writer,()=>deleteCandidate(context('alpha','admin',writer),{id:first.value.id,expectedRevision:1}))).toMatchObject({ok:true});
  }
  return result;
 }};
 const listed=await listDiscoveryCandidates(context('alpha','admin',readSession),{status:'needs_review',offset:0});
 expect(interleaved).toBe(true);expect(reads).toBe(1);
 expect(listed).toMatchObject({ok:true,value:{candidates:[{id:first.value.id,revision:1,payload:{row:{observations:[discoveryFixture().row.source]}},origins:discoveryFixture().origins}]}});
 if(listed.ok){expect(listed.value.candidates[0]?.origins).toHaveLength(1);expect(listed.value.candidates[0]?.payload.row.observations).toHaveLength(1);}
 const current=await listDiscoveryCandidates(context(),{status:'needs_review',offset:0});
 if(operation==='delete')expect(current).toMatchObject({ok:true,value:{candidates:[]}});
 else if(current.ok){expect(current.value.candidates[0]?.revision).toBe(2);expect(current.value.candidates[0]?.origins).toHaveLength(2);}
});
it('fences queued historical runs and all owner admission/correction commands without providers',async()=>{
 const legacy=await withTransaction(runtime,()=>saveCandidate(context(),{firmName:'Synthetic PM',website:'https://example.test/',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Synthetic',sourceUrl:'https://example.test/',observedOn:'2026-10-01',preparedBy:'Fixture'}));if(!legacy.ok)throw Error('legacy');
 const requested=await withTransaction(runtime,()=>requestQualification(context(),{candidateId:legacy.value.id,expectedRevision:1}));if(!requested.ok)throw Error(requested.reason);
 const ids={candidateId:legacy.value.id,runId:requested.value.runId};
 await database.session.query('UPDATE sourcing_candidates SET payload=$2::jsonb WHERE id=$1',[ids.candidateId,JSON.stringify({kind:'discovery-v1',row:discoveryFixture().row})]);
 await runQualification(context(),ids,{pageFetch:{providerKey:'fixture',fetchPages:async()=>{throw Error('must not fetch');}},extraction:null});
 expect(await withTransaction(runtime,()=>evaluateQualification(context(),{runId:ids.runId}))).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 expect(await withTransaction(runtime,()=>admitCandidate(context(),{candidateId:ids.candidateId,expectedRevision:1,qualificationRunId:ids.runId,mode:'reviewed'}))).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 expect(await withTransaction(runtime,()=>admitCallingCandidate(context(),{candidateId:ids.candidateId,expectedRevision:1,qualificationRunId:ids.runId,phone:'+12125550100'}))).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 expect(await withTransaction(runtime,()=>correctCandidateName(context(),{id:ids.candidateId,expectedRevision:1,qualificationRunId:ids.runId,firmName:'Other',observationId:ids.runId,blockId:'name',reason:'Synthetic correction'}))).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 expect((await database.session.query('SELECT count(*)::int n FROM provider_reservations')).rows[0]?.['n']).toBe(0);
});
