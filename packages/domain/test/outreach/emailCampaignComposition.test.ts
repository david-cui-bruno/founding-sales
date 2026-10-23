import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {admitQualifiedResearchFirmToCampaign} from '../../outreach/emailCampaignAdmission.ts';
const mocks=vi.hoisted(()=>({gate:vi.fn(),today:vi.fn(),campaign:vi.fn(),current:vi.fn(),firm:vi.fn(),query:vi.fn(),events:[] as string[]}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:mocks.gate}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:mocks.today}));
vi.mock('../../crm/firms.ts',()=>({loadFirmForUpdate:mocks.firm}));
vi.mock('../../outreach/emailCampaignAuthority.ts',()=>({lockCurrentEmailCampaign:mocks.campaign,campaignAuthorityCurrent:mocks.current,campaignDatabaseNow:vi.fn(),campaignCandidateProvenance:vi.fn()}));
vi.mock('../../sourcing/qualifiedResearchProof.ts',()=>({researchActor:async()=>true}));
vi.mock('../../outreach/emailAdmission.ts',()=>({admitEmailCandidate:vi.fn()}));
vi.mock('../../outreach/plans.ts',()=>({createOutreachPlan:vi.fn()}));
vi.mock('../../outreach/selection.ts',()=>({assessEmailCandidate:vi.fn()}));
vi.mock('../../sourcing/discoveryResearchFirm.ts',()=>({readCurrentDiscoveryResearchFirm:vi.fn()}));
vi.mock('../../sequences/enrollments.ts',()=>({enrollContact:vi.fn()}));
const id='00000000-0000-4000-8000-000000000001';
const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),{query:mocks.query});
beforeEach(()=>{
 vi.clearAllMocks();mocks.events.length=0;
 mocks.gate.mockImplementation(async()=>{mocks.events.push('gate');});mocks.today.mockImplementation(async()=>{mocks.events.push('today');});
 mocks.campaign.mockImplementation(async()=>{mocks.events.push('campaign');return {id,owner_user_id:id};});mocks.current.mockResolvedValue(true);
 mocks.firm.mockImplementation(async()=>{mocks.events.push('firm');return null;});
 mocks.query.mockImplementation(async(sql:string)=>{mocks.events.push(sql.includes('pg_advisory_xact_lock')?'identity':sql);return {rows:[],rowCount:0};});
});
it('locks gate -> Today -> identity -> campaign before any Firm and rolls back a confirmed refusal only to its admission savepoint',async()=>{
 expect(await admitQualifiedResearchFirmToCampaign(ctx,id)).toEqual({ok:false,reason:'firm_changed'});
 expect(mocks.events).toEqual(['gate','today','identity','campaign','SAVEPOINT email_campaign_admission','firm','ROLLBACK TO SAVEPOINT email_campaign_admission','RELEASE SAVEPOINT email_campaign_admission']);
});
it('does not swallow an unknown database failure as an ordinary admission refusal',async()=>{
 const failure=new Error('synthetic_unknown_failure');mocks.firm.mockRejectedValue(failure);
 await expect(admitQualifiedResearchFirmToCampaign(ctx,id)).rejects.toBe(failure);
 expect(mocks.events.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT email_campaign_admission','RELEASE SAVEPOINT email_campaign_admission']);
});
it('lost request/session authority after the lock wait cannot enter admission writes',async()=>{
 const authority=vi.fn(async()=>false);
 expect(await admitQualifiedResearchFirmToCampaign(ctx,id,authority)).toEqual({ok:false,reason:'campaign_authority_unavailable'});
 expect(mocks.events).toEqual(['gate','today','identity','campaign']);expect(mocks.firm).not.toHaveBeenCalled();
});
it('no approved policy is not permission inferred from sequence or mailbox',async()=>{
 mocks.campaign.mockResolvedValue(null);
 expect(await admitQualifiedResearchFirmToCampaign(ctx,id)).toEqual({ok:false,reason:'campaign_authority_unavailable'});
 expect(mocks.current).not.toHaveBeenCalled();expect(mocks.firm).not.toHaveBeenCalled();
});
