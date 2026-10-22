import {beforeEach,expect,it,vi} from 'vitest';
import type {CandidateInput,QualificationFact,SourceObservation} from '@fss/contracts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {automaticResearchProof} from '../../sourcing/automaticResearchProof.ts';
import {automaticResearchSource} from '../../sourcing/automaticResearchAuthority.ts';
import {QUALIFICATION_POLICY_VERSION,QUALIFICATION_PROMPT_VERSION} from '../../sourcing/qualificationStore.ts';
const mocks=vi.hoisted(()=>({owner:vi.fn(),settings:vi.fn(),holds:vi.fn(),policy:vi.fn()}));
vi.mock('../../sourcing/verifiedFirmPolicy.ts',()=>({verifiedFirmOwner:mocks.owner}));
vi.mock('../../research/settings.ts',()=>({readResearchSettings:mocks.settings}));
vi.mock('../../policy/holds.ts',()=>({listApplicableHolds:mocks.holds}));
vi.mock('../../sourcing/targetingProposals.ts',()=>({readTargetingPolicy:mocks.policy}));
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const now='2026-10-22T12:00:00.000Z';
const candidate:CandidateInput={firmName:'Synthetic Harbor LLC',website:'https://harbor.example.test/',sourceUrl:'https://harbor.example.test/',locality:'Arlington',region:'TX',signal:'fit_only',evidence:'Unverified search',preparedBy:'Tavily Basic search · not verified',observedOn:'2026-10-22',discoveryQuery:'Arlington Texas residential property management'};
const query={id:'arlington',query:candidate.discoveryQuery,locality:candidate.locality,region:candidate.region};
function fixture(){
 const text='Synthetic Harbor LLC provides residential property management in Arlington, TX.';
 const email='Contact Synthetic Harbor LLC office in Arlington, TX at info@harbor.example.test.';
 const native:SourceObservation={id,url:candidate.website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:now,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'native',text}]};
 const emailSource:SourceObservation={...native,id:other,blocks:[{id:'email',text:email}]};
 const facts:QualificationFact[]=[...(['firm_identity','service_area','residential_management'] as const).map(kind=>({kind,value:text,observationId:id,blockId:'native'})),{kind:'business_email',value:email,observationId:other,blockId:'email'}];
 return {row:{id,revision:1,status:'needs_review',qualification_blocked:false,payload:{...candidate}},run:{id,candidate_revision:1,prompt_version:QUALIFICATION_PROMPT_VERSION,policy_version:QUALIFICATION_POLICY_VERSION,reason:null,state:'review',facts,observations:[native,emailSource]},hits:[{attempt_id:id,source_url:candidate.website,native_result:{url:candidate.website},query_id:query.id,query:query.query,policy_version:'targeting-v1'}],origins:[] as Record<string,unknown>[],role:'admin',time:now};
}
let f:ReturnType<typeof fixture>,ctx:RepositoryContext;
beforeEach(()=>{
 f=fixture();mocks.owner.mockResolvedValue(id);mocks.settings.mockResolvedValue({enabled:true});mocks.holds.mockResolvedValue([]);mocks.policy.mockResolvedValue({version:'targeting-v1',queries:[query],rankOrder:[]});
 ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:async<Row,>(sql:string)=>{
  let rows:unknown[]=[];
  if(sql.includes('workspace_memberships'))rows=[{role:f.role,status:'active'}];
  else if(sql.includes('clock_timestamp()'))rows=[{now:new Date(f.time)}];
  else if(sql.includes('FROM sourcing_candidates'))rows=[f.row];
  else if(sql.includes('FROM sourcing_qualification_runs'))rows=[f.run];
  else if(sql.includes('FROM sourcing_discovery_hits'))rows=f.hits;
  else if(sql.includes('FROM sourcing_apollo_candidate_origins'))rows=f.origins;
  else throw new Error(`Unexpected query: ${sql}`);
  return {rows:rows as Row[],rowCount:rows.length};
 }});
});
it('accepts completed exact source native + independent email without phone or promotion',async()=>{
 const proof=await automaticResearchProof(ctx,id);expect(proof).toMatchObject({owner:id,runId:id,candidateRevision:1,source:{source:{kind:'search_hit',attemptId:id}}});expect(proof?.citations).toHaveLength(3);expect(proof?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
});
it.each(['native','email'] as const)('rechecks independent %s expiry against fresh wallclock, including exact boundary',async kind=>{
 const observation=f.run.observations[kind==='native'?0:1]!;
 observation.retrievedAt='2026-10-15T12:00:00.001Z';expect(await automaticResearchProof(ctx,id)).not.toBeNull();
 f.time='2026-10-22T12:00:00.001Z';expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it.each(['source_url','query','query_id','policy_version'] as const)('refuses changed retained search %s even with trusted preparedBy',async key=>{
 f.hits[0]![key]='changed';expect(await automaticResearchSource(ctx,id,1,candidate)).toBeNull();
});
it('refuses missing or competing sources and native discovery payloads',async()=>{
 f.hits=[];expect(await automaticResearchProof(ctx,id)).toBeNull();
 f=fixture();f.hits.push({...f.hits[0]!,attempt_id:other});expect(await automaticResearchProof(ctx,id)).toBeNull();
 f.row.payload={kind:'discovery-v1'} as unknown as CandidateInput;expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it('requires active administrator, enabled research and no applicable holds',async()=>{
 f.role='salesperson';expect(await automaticResearchProof(ctx,id)).toBeNull();f.role='admin';
 mocks.settings.mockResolvedValue({enabled:false});expect(await automaticResearchProof(ctx,id)).toBeNull();mocks.settings.mockResolvedValue({enabled:true});
 mocks.holds.mockResolvedValue([{id}]);expect(await automaticResearchProof(ctx,id)).toBeNull();mocks.holds.mockResolvedValue([]);
 mocks.owner.mockResolvedValue(null);expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it('accepts exact completed Apollo origin and refuses changed site, locality or owner-independent metadata',async()=>{
 f.hits=[];f.origins=[{attempt_id:id,candidate_revision:1,organization_name:candidate.firmName,domain:'harbor.example.test',hq_city:candidate.locality,hq_state:'TX',region:'TX'}];
 expect(await automaticResearchProof(ctx,id)).toMatchObject({source:{source:{kind:'apollo_organization'},originRevision:1}});
 f.origins[0]!['hq_city']='Austin';expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it.each(['revision','blocked','dismissed','latest','reason','policy'] as const)('refuses stale/blocked/current evidence: %s',async changed=>{
 if(changed==='revision')f.row.revision=2;if(changed==='blocked')f.row.qualification_blocked=true;if(changed==='dismissed')f.row.status='dismissed';if(changed==='latest')f.run.state='running';if(changed==='reason')f.run.reason='changed' as never;if(changed==='policy')f.run.policy_version='old';
 expect(await automaticResearchProof(ctx,id)).toBeNull();
});
