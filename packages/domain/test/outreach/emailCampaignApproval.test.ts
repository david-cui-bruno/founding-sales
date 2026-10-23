import type * as CampaignAuthority from '../../outreach/emailCampaignAuthority.ts';
import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {approveEmailCampaign} from '../../outreach/emailCampaign.ts';
const mocks=vi.hoisted(()=>({clock:vi.fn(),actor:vi.fn(),lock:vi.fn(),authorization:vi.fn(),kind:vi.fn(),query:vi.fn(),audit:vi.fn()}));
vi.mock('../../sourcing/qualifiedResearchProof.ts',()=>({researchActor:mocks.actor}));
vi.mock('../../outreach/emailCampaignAdmission.ts',()=>({lockEmailCampaignAdmission:mocks.lock,admitQualifiedResearchFirmToCampaign:vi.fn()}));
vi.mock('../../outreach/authorization.ts',()=>({authorizationForMailbox:mocks.authorization}));
vi.mock('../../outreach/settings.ts',()=>({campaignKind:mocks.kind}));
vi.mock('../../crm/audit.ts',()=>({recordCrmAuditEvent:mocks.audit}));
vi.mock('../../outreach/emailCampaignAuthority.ts',async importOriginal=>({...await importOriginal<typeof CampaignAuthority>(),campaignDatabaseNow:mocks.clock}));
const id='00000000-0000-4000-8000-000000000001',initial='2026-10-22T17:00:00.000Z',expiresAt='2026-10-22T17:00:01.000Z';
const policy={mailboxId:id,sequenceVersionId:id,authorizationRevision:1,regions:['TX' as const],maxEnrollments:25,dailyAdmissionLimit:5,expiresAt};
const ctx=repositoryContext(workspaceScope(id,{kind:'user',userId:id,role:'admin'}),{query:mocks.query});
let now:string;
beforeEach(()=>{
 vi.clearAllMocks();now=initial;mocks.clock.mockImplementation(async()=>now);mocks.actor.mockResolvedValue(true);mocks.lock.mockResolvedValue(null);mocks.authorization.mockResolvedValue({allowed:true,revision:1});mocks.kind.mockResolvedValue('email_first');mocks.audit.mockResolvedValue(undefined);
 mocks.query.mockImplementation(async(sql:string)=>{
  if(sql.startsWith('SELECT id FROM mailboxes'))return {rows:[{id}],rowCount:1};
  if(sql.startsWith('INSERT INTO outreach_email_campaigns'))return {rows:[{id,revision:1}],rowCount:1};
  return {rows:[],rowCount:0};
 });
});
it('refuses expiry crossing the mailbox/content wait before policy writes',async()=>{
 mocks.kind.mockImplementation(async()=>{now=expiresAt;return 'email_first';});
 expect(await approveEmailCampaign(ctx,policy)).toEqual({ok:false,reason:'campaign_expiry_invalid'});
 expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO outreach_email_campaigns'))).toBe(false);
 expect(mocks.query.mock.calls.slice(-2).map(([sql])=>sql)).toEqual(['ROLLBACK TO SAVEPOINT email_campaign_policy','RELEASE SAVEPOINT email_campaign_policy']);
});
it('rolls back the approval and any composed admissions if the last acceptance wait crosses expiry',async()=>{
 mocks.audit.mockImplementation(async()=>{now=expiresAt;});
 expect(await approveEmailCampaign(ctx,policy)).toEqual({ok:false,reason:'campaign_expiry_invalid'});
 expect(mocks.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO outreach_email_campaigns'))).toBe(true);
 expect(mocks.query.mock.calls.slice(-2).map(([sql])=>sql)).toEqual(['ROLLBACK TO SAVEPOINT email_campaign_policy','RELEASE SAVEPOINT email_campaign_policy']);
});
it('accepts only when a fresh write instant and fresh acceptance instant both precede expiry',async()=>{
 expect(await approveEmailCampaign(ctx,policy)).toEqual({ok:true,value:{campaignId:id,revision:1}});
 expect(mocks.clock).toHaveBeenCalledTimes(3);
 const write=mocks.query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO outreach_email_campaigns'));
 expect(write?.[1]?.[8]).toBe(initial);
 expect(mocks.query.mock.calls.at(-1)?.[0]).toBe('RELEASE SAVEPOINT email_campaign_policy');
});
