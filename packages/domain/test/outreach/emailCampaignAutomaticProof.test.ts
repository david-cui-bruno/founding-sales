import {beforeEach,expect,it,vi} from 'vitest';
import type {AutomaticResearchTarget} from '@fss/contracts';
import {repositoryContext,workspaceScope,type ScopeActor} from '../../db/workspaceScope.ts';
import {automaticCampaignSourceProof,automaticCampaignTarget,type AutomaticCampaignPublication} from '../../outreach/emailCampaignAutomatic.ts';
const mocks=vi.hoisted(()=>({proof:vi.fn(),identity:vi.fn(),holds:vi.fn(),clock:vi.fn(),query:vi.fn()}));
vi.mock('../../sourcing/automaticResearchProof.ts',()=>({automaticResearchProof:mocks.proof,automaticResearchIdentity:mocks.identity}));
vi.mock('../../sourcing/automaticResearchAuthority.ts',()=>({automaticResearchNow:mocks.clock}));
vi.mock('../../policy/holds.ts',()=>({listApplicableHolds:mocks.holds}));
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',now='2026-10-22T22:00:00.000Z',expiry='2026-10-22T22:00:01.000Z';
const row:AutomaticCampaignPublication={id,revision:3,firm_id:id,candidate_id:id,candidate_revision:2,run_id:id,evidence_fingerprint:'a'.repeat(64),owner_user_id:id,source_kind:'search_hit',source_attempt_id:id,source_url:'https://example.test/'};
const snapshot={candidateId:id,candidateRevision:2,runId:id,fingerprint:row.evidence_fingerprint,owner:id,source:{source:{kind:'search_hit',attemptId:id,sourceUrl:row.source_url}},candidate:{firmName:'Example',website:row.source_url,locality:'Dallas',region:'TX'},validUntil:expiry,route:{address:'info@example.test',sourceObservationId:id,blockId:'office',identityKind:'role',displayName:'Office'}};
const context=(actor:ScopeActor={kind:'system',component:'worker'})=>repositoryContext(workspaceScope(id,actor),{query:mocks.query});
let target:AutomaticResearchTarget;
beforeEach(()=>{
 vi.clearAllMocks();target=automaticCampaignTarget(row);
 mocks.proof.mockResolvedValue(snapshot);mocks.identity.mockResolvedValue({firmId:id});mocks.holds.mockResolvedValue([]);mocks.clock.mockResolvedValue(now);mocks.query.mockResolvedValue({rows:[row],rowCount:1});
});
it.each(['worker','scheduler'] as const)('retains the actual %s scope while reloading exact current publication twice',async component=>{
 const ctx=context({kind:'system',component});
 expect(await automaticCampaignSourceProof(ctx,target)).toMatchObject({owner:id,firmId:id,publicationId:id,publicationRevision:3,route:snapshot.route});
 expect(mocks.proof).toHaveBeenCalledTimes(2);expect(mocks.proof.mock.calls.every(([actual])=>actual===ctx)).toBe(true);
 expect(mocks.query).toHaveBeenCalledTimes(2);expect(ctx.scope.actor).toEqual({kind:'system',component});
});
it.each([{kind:'system',component:'migration'},{kind:'user',role:'salesperson',userId:id},{kind:'user',role:'admin',userId:other}] as const)('rejects unrelated actors without consulting sourcing proof: %j',async actor=>{
 expect(await automaticCampaignSourceProof(context(actor),target)).toBeNull();expect(mocks.proof).not.toHaveBeenCalled();
});
it('supports only the actual currently bound admin for approval-time backlog',async()=>{
 expect(await automaticCampaignSourceProof(context({kind:'user',role:'admin',userId:id}),target)).not.toBeNull();
});
it.each([
 {publicationId:other},{publicationRevision:4},{firmId:other},{candidateId:other},{candidateRevision:3},{runId:other},{evidenceFingerprint:'b'.repeat(64)},
])('selection is not authority, exact stale or foreign target refuses: %j',async patch=>{
 expect(await automaticCampaignSourceProof(context(),{...target,...patch})).toBeNull();
});
it.each([
 {owner:other},{runId:other},{candidateRevision:3},{fingerprint:'b'.repeat(64)},{source:{source:{kind:'apollo_organization',attemptId:id,sourceUrl:row.source_url}}},{source:{source:{kind:'search_hit',attemptId:other,sourceUrl:row.source_url}}},{source:{source:{kind:'search_hit',attemptId:id,sourceUrl:'https://foreign.test/'}}},
])('rechecks current proof rather than trusting a stored publication: %j',async patch=>{
 mocks.proof.mockResolvedValueOnce(snapshot).mockResolvedValue({...snapshot,...patch});
 expect(await automaticCampaignSourceProof(context(),target)).toBeNull();
});
it('refuses deleted publication during proof waits',async()=>{
 mocks.query.mockResolvedValueOnce({rows:[row]}).mockResolvedValue({rows:[]});
 expect(await automaticCampaignSourceProof(context(),target)).toBeNull();
});
it('refuses canonical identity changes and scoped owner/Firm research holds',async()=>{
 mocks.identity.mockResolvedValueOnce({firmId:id}).mockResolvedValue({firmId:other});expect(await automaticCampaignSourceProof(context(),target)).toBeNull();
 mocks.identity.mockResolvedValue({firmId:id});mocks.holds.mockResolvedValue([{}]);expect(await automaticCampaignSourceProof(context(),target)).toBeNull();
 expect(mocks.holds).toHaveBeenLastCalledWith(expect.anything(),{actionKind:'research',channel:'research',ownerUserId:id,firmId:id});
});
it('uses the last wall clock after identity and research-hold waits, independently bounded by email expiry',async()=>{
 mocks.holds.mockImplementation(async()=>{mocks.clock.mockResolvedValue(expiry);return [];});
 expect(await automaticCampaignSourceProof(context(),target)).toBeNull();expect(mocks.clock).toHaveBeenCalledTimes(1);
});
it('does not turn an unknown database result into a confirmed refusal',async()=>{
 const failure=new Error('synthetic_unknown');mocks.query.mockRejectedValue(failure);
 await expect(automaticCampaignSourceProof(context(),target)).rejects.toBe(failure);
});
