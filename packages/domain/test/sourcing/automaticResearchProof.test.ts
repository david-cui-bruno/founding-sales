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
 return {retained:false,row:{id,revision:1,status:'needs_review',qualification_blocked:false,payload:{...candidate}},run:{id,candidate_revision:1,prompt_version:QUALIFICATION_PROMPT_VERSION,policy_version:QUALIFICATION_POLICY_VERSION,reason:null,state:'review',facts,observations:[native,emailSource]},hits:[{attempt_id:id,source_url:candidate.website,native_result:{url:candidate.website},query_id:query.id,query:query.query,policy_version:'targeting-v1'}],origins:[] as Record<string,unknown>[],history:[] as Record<string,unknown>[],role:'admin',time:now};
}
let f:ReturnType<typeof fixture>,ctx:RepositoryContext;
beforeEach(()=>{
 f=fixture();mocks.owner.mockResolvedValue(id);mocks.settings.mockResolvedValue({enabled:true});mocks.holds.mockResolvedValue([]);mocks.policy.mockResolvedValue({version:'targeting-v1',queries:[query],rankOrder:[]});
 ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:async<Row,>(sql:string)=>{
  let rows:unknown[]=[];
  if(sql==='SELECT id FROM sourcing_retained_identity_decisions WHERE workspace_id=$1 AND candidate_id=$2 LIMIT 1')rows=f.retained?[{id}]:[];
  else if(sql.includes('workspace_memberships'))rows=[{role:f.role,status:'active'}];
  else if(sql.includes('clock_timestamp()'))rows=[{now:new Date(f.time)}];
  else if(sql.includes('FROM sourcing_candidates'))rows=[f.row];
  else if(sql.includes('FROM sourcing_qualification_runs'))rows=[f.run];
  else if(sql.includes('FROM sourcing_discovery_hits'))rows=f.hits;
  else if(sql.includes('FROM sourcing_targeting_versions'))rows=f.history;
  else if(sql.includes('FROM sourcing_apollo_candidate_origins'))rows=f.origins;
  else throw new Error(`Unexpected query: ${sql}`);
  return {rows:rows as Row[],rowCount:rows.length};
 }});
});
it('refuses retained-only candidates before consulting owner, evidence or acquisition authority',async()=>{
 f.retained=true;expect(await automaticResearchProof(ctx,id)).toBeNull();expect(mocks.owner).not.toHaveBeenCalled();expect(mocks.policy).not.toHaveBeenCalled();
});
it('accepts completed exact source native + independent email without phone or promotion',async()=>{
 const proof=await automaticResearchProof(ctx,id);expect(proof).toMatchObject({owner:id,runId:id,candidateRevision:1,source:{source:{kind:'search_hit',attemptId:id}}});expect(proof?.citations).toHaveLength(3);expect(proof?.fingerprint).toMatch(/^[a-f0-9]{64}$/u);
});
it('retains the exact pre-US legacy proof fingerprint and native interpretation',async()=>{
 const proof=await automaticResearchProof(ctx,id);
 expect(proof?.nativePolicyVersion).toBe('native-firm-eligibility-v1');
 expect(proof?.fingerprint).toBe('498de84eaf596510b8043ee55cdaca0be3799bac41a57963f1f6c9735973df49');
});
it('accepts current CA preparation only from full-state native evidence and its exact already-approved query/source',async()=>{
 const payload={...candidate,region:'CA' as const,locality:'Los Angeles',discoveryQuery:'Los Angeles California residential property management'};
 f.row.payload=payload;
 const currentQuery={id:'los-angeles',query:payload.discoveryQuery,locality:payload.locality,region:payload.region};
 mocks.policy.mockResolvedValue({version:'targeting-us-fixture',queries:[currentQuery],rankOrder:[]});
 f.hits=[{attempt_id:id,source_url:payload.website,native_result:{url:payload.website},query_id:currentQuery.id,query:currentQuery.query,policy_version:'targeting-us-fixture'}];
 const native='Synthetic Harbor LLC provides residential property management in Los Angeles, California.';
 const email='Contact Synthetic Harbor LLC office in Los Angeles, CA at info@harbor.example.test.';
 for(const fact of f.run.facts)fact.value=fact.kind==='business_email'?email:native;
 f.run.observations[0]!.blocks[0]!.text=native;f.run.observations[1]!.blocks[0]!.text=email;
 const proof=await automaticResearchProof(ctx,id);
 expect(proof).toMatchObject({nativePolicyVersion:'native-firm-eligibility-us-v1',route:{address:'info@harbor.example.test'}});
 expect(proof?.fingerprint).not.toBe('498de84eaf596510b8043ee55cdaca0be3799bac41a57963f1f6c9735973df49');
 mocks.policy.mockResolvedValue({version:'targeting-v1',queries:[query],rankOrder:[]});
 expect(await automaticResearchProof(ctx,id)).toBeNull();
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
it('supplies the resolved owner to research hold matching, not an unrelated owner',async()=>{
 mocks.holds.mockImplementation(async(_ctx,subject)=>subject.actionKind==='research'&&subject.ownerUserId===id?[{id}]:[]);
 expect(await automaticResearchProof(ctx,id)).toBeNull();
 expect(mocks.holds).toHaveBeenCalledWith(ctx,{actionKind:'research',channel:'research',ownerUserId:id});
 mocks.holds.mockImplementation(async(_ctx,subject)=>subject.ownerUserId===other?[{id}]:[]);
 expect(await automaticResearchProof(ctx,id)).not.toBeNull();
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

it('nationwide continuity preserves exact old fingerprint after additive and ranking-only policy changes',async()=>{
 const ranks=['help_request','operational_burden','investigation','fit_only'];
 mocks.policy.mockResolvedValue({version:'targeting-v1',queries:[query],rankOrder:ranks});
 const old=await automaticResearchProof(ctx,id);
 f.history=[{version:'targeting-v1',queries:[query],rank_order:['help_request','operational_burden','investigation','fit_only']}];
 for(const current of [{version:'targeting-added',queries:[query,{...query,id:'new-query',locality:'Austin'}],rankOrder:['fit_only']},{version:'targeting-ranked',queries:[query],rankOrder:['fit_only','investigation']}]){
  mocks.policy.mockResolvedValue(current);const proof=await automaticResearchProof(ctx,id);
  expect(proof?.fingerprint).toBe(old?.fingerprint);expect(proof).toMatchObject({targetingVersion:current.version,source:old?.source});
 }
});
it.each(['missing','foreign','id','query','locality','region'] as const)('nationwide continuity refuses unavailable or changed historical tuple: %s',async changed=>{
 mocks.policy.mockResolvedValue({version:'targeting-new',queries:[query],rankOrder:[]});
 const historical={...query};if(changed==='id')historical.id='another';if(changed==='query')historical.query='Other query';if(changed==='locality')historical.locality='Austin';if(changed==='region')historical.region='MA';
 f.history=changed==='missing'?[]:[{version:changed==='foreign'?'targeting-foreign':'targeting-v1',queries:[historical],rank_order:['help_request','operational_burden','investigation','fit_only']}];
 expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it.each(['id','query','locality','region'] as const)('nationwide continuity refuses a changed current approved tuple: %s',async changed=>{
 const current={...query};if(changed==='id')current.id='another';if(changed==='query')current.query='Other query';if(changed==='locality')current.locality='ARLINGTON';if(changed==='region')current.region='MA';
 f.history=[{version:'targeting-v1',queries:[query],rank_order:['help_request','operational_burden','investigation','fit_only']}];mocks.policy.mockResolvedValue({version:'targeting-new',queries:[current],rankOrder:[]});
 expect(await automaticResearchProof(ctx,id)).toBeNull();
});
it('nationwide continuity requires a single exact retained source even after query removal and re-addition',async()=>{
 f.history=[{version:'targeting-v1',queries:[query],rank_order:['help_request','operational_burden','investigation','fit_only']}];
 mocks.policy.mockResolvedValue({version:'targeting-removed',queries:[],rankOrder:[]});expect(await automaticResearchProof(ctx,id)).toBeNull();
 f.hits=[];mocks.policy.mockResolvedValue({version:'targeting-readded',queries:[query],rankOrder:[]});expect(await automaticResearchProof(ctx,id)).toBeNull();
 f.hits=fixture().hits;f.hits.push({...f.hits[0]!,attempt_id:other});expect(await automaticResearchProof(ctx,id)).toBeNull();
 f.hits=fixture().hits;f.hits[0]!.native_result.url='https://other.example.test/';expect(await automaticResearchProof(ctx,id)).toBeNull();
});

it.each(['nonarray','null_query','missing_field','duplicate','ranks','whitespace'] as const)('nationwide continuity refuses malformed/ambiguous or raw-changed acquisition policy: %s',async changed=>{
 const historical:Record<string,unknown>={version:'targeting-v1',queries:[query],rank_order:['help_request','operational_burden','investigation','fit_only']};
 if(changed==='nonarray')historical['queries']={};if(changed==='null_query')historical['queries']=[null];if(changed==='missing_field')historical['queries']=[{id:query.id,query:query.query}];
 if(changed==='duplicate')historical['queries']=[query,{...query,locality:'Austin'}];if(changed==='ranks')historical['rank_order']=[];if(changed==='whitespace')historical['queries']=[{...query,locality:query.locality+' '}];
 f.history=[historical];mocks.policy.mockResolvedValue({version:'targeting-new',queries:[query],rankOrder:[]});
 expect(await automaticResearchProof(ctx,id)).toBeNull();
});
