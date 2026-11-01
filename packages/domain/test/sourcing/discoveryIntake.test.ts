import {afterAll,beforeAll,beforeEach,expect,it} from 'vitest';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {listCandidates,reviewCandidate,deleteCandidate,saveCandidate} from '../../sourcing/candidates.ts';
import {listUsefulDiscoveryCandidates} from '../../sourcing/discoveryReview.ts';
import {requestSourceCheck} from '../../sourcing/sourceCheck.ts';
import {requestQualification} from '../../sourcing/qualificationStore.ts';
import {runQualification} from '../../sourcing/qualificationRun.ts';
import {evaluateQualification} from '../../sourcing/qualificationDecision.ts';
import {admitCandidate} from '../../sourcing/admission.ts';
import {admitCallingCandidate} from '../../sourcing/callingAdmission.ts';
import {correctCandidateName} from '../../sourcing/candidateCorrection.ts';
import {seedDiscoveryCandidate,type DiscoverySeed} from './support/discoverySeed.ts';
let database:TestDatabase,seeded:TwoWorkspaces,runtime:SessionQueryable;
function discoveryFixture(recordId='fixture-1'):DiscoverySeed {
 const source={provider:'overture_places' as const,recordId,release:'fixture-release',retrievedAt:null,sourceUrl:'https://example.test/source'};
 return {row:{source,observations:[source],firmName:'Synthetic PM',website:null,locality:null,region:'CA',sourceConfidence:0.7,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'observed_source',probableGroupKey:null},origins:[{source,sourceMetadata:{sourcesJson:'[{"dataset":"synthetic","license":"CDLA-Permissive-2.0"}]'},licenses:['CDLA-Permissive-2.0'],notices:[{label:'Fixture notice',url:'https://example.test/license',sha256:'a'.repeat(64)}]}]};
}
const context=(workspace:'alpha'|'beta'='alpha',role:'admin'|'salesperson'='admin',session=runtime)=>repositoryContext(workspaceScope(seeded[workspace].workspaceId,{kind:'user',userId:seeded[workspace][role].userId,role}),session);
const seed=(input=discoveryFixture(),workspace:'alpha'|'beta'='alpha')=>withTransaction(runtime,()=>seedDiscoveryCandidate(context(workspace),input));
beforeAll(async()=>{database=await createTestDatabase();seeded=await seedTwoWorkspaces(database.session);runtime=await database.appRuntimeSession();});
beforeEach(async()=>{await database.session.query('DELETE FROM sourcing_candidates');});
afterAll(async()=>{await database.drop();});
it('keeps stored nullable nationwide discovery and immutable provenance out of legacy and CRM admission',async()=>{
 const input=discoveryFixture(),{id}=await seed(input);
 expect(await listUsefulDiscoveryCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[{candidate:{revision:1,payload:{kind:'discovery-v1',row:input.row},origins:input.origins}}]}});
 expect(await listCandidates(context(),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[]}});
 for(const operation of [()=>reviewCandidate(context(),{id,expectedRevision:1,status:'kept'}),()=>requestSourceCheck(context(),{id,expectedRevision:1}),()=>requestQualification(context(),{candidateId:id,expectedRevision:1})])expect(await withTransaction<unknown>(runtime,operation)).toMatchObject({ok:false,reason:'candidate_format_not_supported'});
 for(const table of ['firms','opportunities','sequence_enrollments','jobs','sourcing_qualification_runs'])expect((await database.session.query(`SELECT count(*)::int n FROM ${table}`)).rows[0]?.['n']).toBe(0);
 await expect(runtime.query('UPDATE sourcing_candidate_discovery_origins SET source=source')).rejects.toMatchObject({code:'42501'});
});
it('isolates workspaces and cascades normal deletion of stored discovery origins',async()=>{
 const a=await seed(),b=await seed(discoveryFixture(),'beta');
 expect(a.id).not.toBe(b.id);expect(await listUsefulDiscoveryCandidates(context('beta'),{status:'needs_review',offset:0})).toMatchObject({ok:true,value:{candidates:[{candidate:{id:b.id}}]}});
 await withTransaction(runtime,()=>reviewCandidate(context(),{id:a.id,expectedRevision:1,status:'dismissed'}));
 await withTransaction(runtime,()=>deleteCandidate(context(),{id:a.id,expectedRevision:2}));expect((await database.session.query('SELECT count(*)::int n FROM sourcing_candidate_discovery_origins')).rows[0]?.['n']).toBe(1);
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
