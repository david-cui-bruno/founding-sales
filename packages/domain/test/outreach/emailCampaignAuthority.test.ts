import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {campaignAuthorityCurrent,campaignCandidateProvenance,campaignView,type EmailCampaignRow} from '../../outreach/emailCampaignAuthority.ts';
const mocks=vi.hoisted(()=>({actor:vi.fn(),proof:vi.fn(),lineage:vi.fn(),authorization:vi.fn(),kind:vi.fn(),query:vi.fn()}));
vi.mock('../../sourcing/qualifiedResearchProof.ts',()=>({researchActor:mocks.actor,readQualifiedResearchCandidate:mocks.proof}));
vi.mock('../../sourcing/discoveryResearchFirm.ts',()=>({readCurrentDiscoveryResearchFirm:mocks.lineage}));
vi.mock('../../outreach/authorization.ts',()=>({authorizationForMailbox:mocks.authorization}));
vi.mock('../../outreach/settings.ts',()=>({campaignKind:mocks.kind}));
const id='00000000-0000-4000-8000-000000000001',now='2026-10-22T17:00:00.000Z';
const policy:EmailCampaignRow={id,owner_user_id:id,mailbox_id:id,sequence_version_id:id,authorization_revision:3,regions:['TX'],max_enrollments:25,daily_admission_limit:5,approved_at:new Date(now),expires_at:new Date('2026-10-23T17:00:00Z'),revision:1,revoked_at:null};
const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),{query:mocks.query});
let current:EmailCampaignRow,clock:string;
beforeEach(()=>{
 vi.clearAllMocks();current={...policy};clock=now;
 mocks.actor.mockResolvedValue(true);mocks.authorization.mockResolvedValue({allowed:true,revision:3});mocks.kind.mockResolvedValue('email_first');
 mocks.proof.mockResolvedValue({selection:{candidateId:id,runId:id,candidateRevision:2},validUntil:'2026-10-23T17:00:00Z',emailFit:'eligible',region:'TX',locality:'Dallas'});
 mocks.lineage.mockResolvedValue({promotionId:id,discoveryCandidateId:id,candidate:{revision:2},firm:{id,region_code:'TX',locality:'Dallas'}});
 mocks.query.mockImplementation(async(sql:string)=>{
  if(sql==='SELECT clock_timestamp() AS now')return {rows:[{now:new Date(clock)}],rowCount:1};
  if(sql.startsWith('SELECT * FROM outreach_email_campaigns'))return {rows:[current],rowCount:1};
  if(sql.startsWith('SELECT l.firm_id'))return {rows:[{firm_id:id}],rowCount:1};
  throw new Error('unexpected_campaign_query');
 });
});
it('requires persisted current owner, exact mailbox authorization revision and approved five-email content',async()=>{
 expect(await campaignAuthorityCurrent(ctx,policy)).toBe(true);
 mocks.authorization.mockResolvedValue({allowed:true,revision:4});expect(await campaignAuthorityCurrent(ctx,policy)).toBe(false);
 mocks.authorization.mockResolvedValue({allowed:true,revision:3});mocks.kind.mockResolvedValue('reply');expect(await campaignAuthorityCurrent(ctx,policy)).toBe(false);
});
it('uses wall database time after waits rather than transaction-start time',async()=>{
 mocks.kind.mockImplementation(async()=>{clock='2026-10-24T17:00:00Z';return 'email_first';});
 expect(await campaignAuthorityCurrent(ctx,policy)).toBe(false);
 expect(mocks.query.mock.calls.filter(([sql])=>sql==='SELECT clock_timestamp() AS now')).toHaveLength(2);
});
it.each(['revoked','revision','owner'] as const)('rejects changed persisted %s authority',async change=>{
 if(change==='revoked')current={...current,revoked_at:new Date(now),revision:2};
 if(change==='revision')current={...current,revision:2};
 if(change==='owner')mocks.actor.mockResolvedValue(false);
 expect(await campaignAuthorityCurrent(ctx,policy)).toBe(false);
});
it('requires exact current canonical source provenance, not just a policy identifier',async()=>{
 expect(await campaignCandidateProvenance(ctx,{campaignId:id,candidateId:id,qualificationRunId:id})).toEqual({firmId:id,campaign:policy});
 mocks.proof.mockResolvedValue(null);expect(await campaignCandidateProvenance(ctx,{campaignId:id,candidateId:id,qualificationRunId:id})).toBeNull();
});
it.each([
 {emailFit:'unresolved'}, {region:'MA'}, {validUntil:now}, {selection:{candidateId:id,runId:'different',candidateRevision:2}},
])('refuses stale, wrong-region or unresolved research: %j',async patch=>{
 mocks.proof.mockResolvedValue({...await mocks.proof(),...patch});
 expect(await campaignCandidateProvenance(ctx,{campaignId:id,candidateId:id,qualificationRunId:id})).toBeNull();
});
it('rechecks canonical candidate revision after the proof wait',async()=>{
 mocks.lineage.mockResolvedValueOnce({promotionId:id,discoveryCandidateId:id,candidate:{revision:2},firm:{id,region_code:'TX',locality:'Dallas'}}).mockResolvedValue({promotionId:id,candidate:{revision:3}});
 expect(await campaignCandidateProvenance(ctx,{campaignId:id,candidateId:id,qualificationRunId:id})).toBeNull();
});
it('reports expired historical policy without silently reviving or discarding counts',()=>{
 expect(campaignView(policy,'2026-10-24T17:00:00Z',5)).toMatchObject({state:'expired',admittedCount:5,revision:1});
 expect(campaignView({...policy,revoked_at:new Date(now),revision:2},now,5)).toMatchObject({state:'revoked',admittedCount:5,revision:2});
});
