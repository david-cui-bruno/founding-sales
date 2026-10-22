import type * as AutomaticCampaign from '../../outreach/emailCampaignAutomatic.ts';
import {beforeEach,expect,it,vi} from 'vitest';
import type {AutomaticResearchTarget} from '@fss/contracts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {admitAutomaticResearchRunToCampaign,admitQualifiedResearchFirmToCampaign} from '../../outreach/emailCampaignAdmission.ts';
const mocks=vi.hoisted(()=>({gate:vi.fn(),today:vi.fn(),campaign:vi.fn(),current:vi.fn(),provenance:vi.fn(),proof:vi.fn(),firm:vi.fn(),admit:vi.fn(),plan:vi.fn(),assessment:vi.fn(),enroll:vi.fn(),holds:vi.fn(),suppressed:vi.fn(),query:vi.fn(),events:[] as string[]}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForStopFact:mocks.gate}));
vi.mock('../../today/build.ts',()=>({lockTodayForFirmChange:mocks.today}));
vi.mock('../../crm/firms.ts',()=>({loadFirmForUpdate:mocks.firm}));
vi.mock('../../outreach/emailCampaignAuthority.ts',()=>({lockCurrentEmailCampaign:mocks.campaign,campaignAuthorityCurrent:mocks.current,campaignCandidateProvenance:mocks.provenance,campaignDatabaseNow:async()=> '2026-10-22T22:00:00.000Z'}));
vi.mock('../../outreach/emailCampaignAutomatic.ts',async original=>({...await original<typeof AutomaticCampaign>(),automaticCampaignSourceProof:mocks.proof}));
vi.mock('../../sourcing/qualifiedResearchProof.ts',()=>({researchActor:async()=>false}));
vi.mock('../../outreach/emailAdmission.ts',()=>({admitEmailCandidate:mocks.admit}));
vi.mock('../../outreach/plans.ts',()=>({createOutreachPlan:mocks.plan}));
vi.mock('../../outreach/selection.ts',()=>({assessEmailCandidate:mocks.assessment}));
vi.mock('../../sourcing/discoveryResearchFirm.ts',()=>({readCurrentDiscoveryResearchFirm:()=>{throw new Error('automatic is not discovery promotion');}}));
vi.mock('../../sequences/enrollments.ts',()=>({enrollContact:mocks.enroll}));
vi.mock('../../policy/holds.ts',()=>({listApplicableHolds:mocks.holds}));
vi.mock('../../suppression/effective.ts',()=>({firstSuppressed:mocks.suppressed}));
const id='00000000-0000-4000-8000-000000000001',runId='00000000-0000-4000-8000-000000000002';
const ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),{query:mocks.query});
const target:AutomaticResearchTarget={kind:'automatic_research',publicationId:id,publicationRevision:3,firmId:id,candidateId:id,candidateRevision:2,runId,evidenceFingerprint:'a'.repeat(64)};
const campaign={id,owner_user_id:id,mailbox_id:id,sequence_version_id:id,max_enrollments:25,daily_admission_limit:5};
const route={address:'info@example.test',sourceObservationId:id,blockId:'office',identityKind:'role'};
const pub={id,revision:3,firm_id:id,candidate_id:id,candidate_revision:2,run_id:runId,evidence_fingerprint:target.evidenceFingerprint};
beforeEach(()=>{
 vi.clearAllMocks();mocks.events.length=0;
 mocks.gate.mockImplementation(async()=>{mocks.events.push('gate');});mocks.today.mockImplementation(async()=>{mocks.events.push('today');});
 mocks.campaign.mockImplementation(async()=>{mocks.events.push('campaign');return campaign;});mocks.current.mockResolvedValue(true);mocks.provenance.mockResolvedValue({firmId:id,campaign,route});mocks.proof.mockResolvedValue({owner:id});
 mocks.firm.mockImplementation(async()=>{mocks.events.push('firm');return {id,status:'active',assigned_user_id:id};});
 mocks.admit.mockResolvedValue({ok:true,value:{firmId:id,contactId:id,routeId:id}});mocks.plan.mockResolvedValue({ok:true,value:{id}});mocks.assessment.mockResolvedValue({ok:true,value:{reviewRequired:false,route}});mocks.enroll.mockResolvedValue({ok:true,value:{enrollmentId:id}});mocks.holds.mockResolvedValue([]);mocks.suppressed.mockResolvedValue(null);
 mocks.query.mockImplementation(async(sql:string)=>{
  mocks.events.push(sql.includes('pg_advisory_xact_lock')?'identity':sql);
  if(sql.includes('count(*) FILTER'))return {rows:[{total:'0',daily:'0'}]};
  if(sql.startsWith('SELECT * FROM sourcing_automatic_research_firms'))return {rows:[pub]};
  if(sql.startsWith('SELECT id FROM sourcing_qualification_runs')&&!sql.includes('FOR UPDATE'))return {rows:[{id:runId}]};
  if(sql.startsWith('INSERT INTO outreach_email_campaign_admissions'))return {rows:[{admitted_at:new Date('2026-10-22T22:00:00.000Z')}]};
  return {rows:[],rowCount:0};
 });
});
it('registered-system reconciliation uses the existing admission/plan/enrollment owners with reviewed:false and exact automatic lineage',async()=>{
 await admitAutomaticResearchRunToCampaign(ctx,runId);
 expect(mocks.admit).toHaveBeenCalledWith(ctx,{campaignId:id,candidateId:id,qualificationRunId:runId,expectedRevision:2,expectedOwnerUserId:id,reviewed:false},target);
 expect(mocks.plan).toHaveBeenCalledWith(ctx,expect.objectContaining({firmId:id,qualificationRunId:runId,lane:'email_first'}),id,target);
 expect(mocks.enroll).toHaveBeenCalledWith(ctx,expect.objectContaining({originKind:'prospecting',subject:{kind:'outreach',outreachPlanId:id}}));
 const insert=mocks.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO outreach_email_campaign_admissions'));
 expect(insert?.[1]?.slice(9)).toEqual(['automatic_research',id,3,2,target.evidenceFingerprint]);
 expect(mocks.events.indexOf('campaign')).toBeLessThan(mocks.events.indexOf('firm'));
 const candidate=mocks.events.findIndex(sql=>sql.startsWith('SELECT id FROM sourcing_candidates'));
 expect(mocks.events.indexOf('firm')).toBeLessThan(candidate);
 expect(ctx.scope.actor).toEqual({kind:'system',component:'worker'});
});
it('unscoped system use without exact automatic authority cannot use the manual/discovery path',async()=>{
 expect(await admitQualifiedResearchFirmToCampaign(ctx,id)).toEqual({ok:false,reason:'campaign_authority_unavailable'});expect(mocks.admit).not.toHaveBeenCalled();
});
it('source selection plus a true callback is still not automatic campaign authority',async()=>{
 mocks.current.mockResolvedValue(false);
 expect(await admitQualifiedResearchFirmToCampaign(ctx,id,async()=>true,target)).toEqual({ok:false,reason:'campaign_authority_unavailable'});expect(mocks.firm).not.toHaveBeenCalled();
});
it('confirmed downstream refusal rolls back only admission and never creates enrollment or cap history',async()=>{
 mocks.admit.mockResolvedValue({ok:false,reason:'candidate_changed'});await admitAutomaticResearchRunToCampaign(ctx,runId);
 expect(mocks.events.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT email_campaign_admission','RELEASE SAVEPOINT email_campaign_admission']);expect(mocks.enroll).not.toHaveBeenCalled();
 expect(mocks.events.some(sql=>sql.startsWith('INSERT INTO outreach_email_campaign_admissions'))).toBe(false);
});
it('unknown insertion failure, even a foreign-key SQL code, propagates after rolling back admission writes',async()=>{
 const failure=Object.assign(new Error('synthetic_unknown_insertion'),{code:'23503'}),query=mocks.query.getMockImplementation()!;
 mocks.query.mockImplementation(async(sql:string,...args:unknown[])=>{if(sql.startsWith('INSERT INTO outreach_email_campaign_admissions'))throw failure;return query(sql,...args);});
 await expect(admitAutomaticResearchRunToCampaign(ctx,runId)).rejects.toBe(failure);
 expect(mocks.events.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT email_campaign_admission','RELEASE SAVEPOINT email_campaign_admission']);
});
it.each([{total:'25',daily:'0'},{total:'0',daily:'5'}])('keeps policy lifetime and owner-wide UTC daily caps across source kinds: %j',async counts=>{
 const query=mocks.query.getMockImplementation()!;mocks.query.mockImplementation(async(sql:string,...args:unknown[])=>sql.includes('count(*) FILTER')?{rows:[counts]}:query(sql,...args));
 await admitAutomaticResearchRunToCampaign(ctx,runId);expect(mocks.admit).not.toHaveBeenCalled();
});
it('a newer admission hold remains authoritative',async()=>{
 mocks.holds.mockResolvedValue([{}]);await admitAutomaticResearchRunToCampaign(ctx,runId);expect(mocks.admit).not.toHaveBeenCalled();
});
it('exact publication recovery refuses competing rows instead of choosing arbitrary lineage',async()=>{
 mocks.query.mockResolvedValue({rows:[pub,pub]});await admitAutomaticResearchRunToCampaign(ctx,runId);expect(mocks.campaign).not.toHaveBeenCalled();
});
