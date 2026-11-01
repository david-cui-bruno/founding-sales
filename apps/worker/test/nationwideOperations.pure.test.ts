import {beforeEach,expect,it,vi} from 'vitest';
import type {SessionQueryable} from '@fss/domain/db/queryable.ts';
import {targetingConfigureCommand} from '../src/tools/fss/targetingConfigure.ts';
import {researchSetCeilingsCommand} from '../src/tools/fss/researchSetCeilings.ts';
const m=vi.hoisted(()=>({save:vi.fn(),apply:vi.fn(),policy:vi.fn(),read:vi.fn(),update:vi.fn(),budget:vi.fn(),audit:vi.fn()}));
vi.mock('@fss/domain/sourcing/targetingProposals.ts',()=>({saveTargetingProposal:m.save,applyTargetingProposal:m.apply,readTargetingPolicy:m.policy}));
vi.mock('@fss/domain/research/settings.ts',()=>({readResearchSettings:m.read,updateResearchSettings:m.update}));
vi.mock('@fss/domain/research/ceilings.ts',()=>({lockResearchBudget:m.budget}));
vi.mock('@fss/domain/crm/audit.ts',()=>({recordCrmAuditEvent:m.audit}));
const w='00000000-0000-4000-8000-000000000001',owner='00000000-0000-4000-8000-000000000002';
const launch={launchedBy:'arn:aws:iam::123456789012:user/operator',taskArn:'arn:aws:ecs:us-east-1:123456789012:task/cluster/fixture'};
const proposal={basePolicyVersion:'targeting-v1',queryChanges:[],rankOrder:['help_request','operational_burden','investigation','fit_only'],evidenceIds:[],rationale:'Fictional targeting proposal.'};
const targetingOptions={'--workspace-id':w,'--owner-user-id':owner,'--proposal-json-base64':Buffer.from(JSON.stringify(proposal)).toString('base64')};
const researchOptions={'--workspace-id':w,'--owner-user-id':owner,'--daily-cents':'1000','--monthly-cents':'20000'};
let session:SessionQueryable,sqls:string[];
beforeEach(()=>{vi.clearAllMocks();sqls=[];session={query:async<Row,>(sql:string)=>{sqls.push(sql);const rows=sql.includes('workspace_memberships')?[{user_id:owner}]:sql.includes('FROM research_settings')?[{workspace_id:w}]:[];return {rows:rows as Row[],rowCount:rows.length};}};
 m.save.mockResolvedValue({ok:true,value:{id:w,revision:1}});m.apply.mockResolvedValue({ok:true,value:{policyVersion:'targeting-new'}});m.policy.mockResolvedValue({queries:Array(60).fill({})});
 m.read.mockResolvedValue({dailyCostCeilingCents:4000,monthlyCostCeilingCents:38750,dailyFirmCeiling:400});m.update.mockResolvedValue({ok:true,value:{}});
});
it.each(['targeting','research'] as const)('requires audited ECS launch before %s database access',async kind=>{
 const result=kind==='targeting'?await targetingConfigureCommand({session,options:targetingOptions}):await researchSetCeilingsCommand({session,options:researchOptions});
 expect(result).toMatchObject({ok:false,reason:'launcher_unknown'});expect(sqls).toEqual([]);
});
it.each(['noncanonical','whitespace','utf8','oversized','schema'] as const)('refuses bounded proposal decoding: %s',async mode=>{
 const encoded=mode==='noncanonical'?targetingOptions['--proposal-json-base64'].replace(/=+$/u,''):mode==='whitespace'?' '+targetingOptions['--proposal-json-base64']:mode==='utf8'?Buffer.from([0xff]).toString('base64'):mode==='oversized'?Buffer.alloc(49153,32).toString('base64'):Buffer.from('{}').toString('base64');
 // Ensure the noncanonical case differs even when the original happens to need no padding.
 const payload=mode==='noncanonical'?targetingOptions['--proposal-json-base64']+'=':encoded;
 expect(await targetingConfigureCommand({session,launch,options:{...targetingOptions,'--proposal-json-base64':payload}})).toMatchObject({ok:false});expect(sqls).toEqual([]);
});
it('rolls back a saved proposal when apply refuses instead of committing partial success',async()=>{
 m.apply.mockResolvedValue({ok:false,reason:'policy_changed'});
 expect(await targetingConfigureCommand({session,launch,options:targetingOptions})).toMatchObject({ok:false,reason:'policy_changed'});
 expect(sqls.at(-1)).toBe('ROLLBACK');expect(sqls).not.toContain('COMMIT');expect(m.audit).not.toHaveBeenCalled();
});
it('returns only targeting identifiers/version/count and audits the launcher separately',async()=>{
 expect(await targetingConfigureCommand({session,launch,options:targetingOptions})).toEqual({ok:true,value:{proposalId:w,policyVersion:'targeting-new',queryCount:60}});
 expect(m.audit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({detail:expect.objectContaining(launch)}));expect(sqls.at(-1)).toBe('COMMIT');
});
it.each([['1001','20000'],['1000','20001']])('refuses an unapproved money increase daily=%s monthly=%s',async(daily,monthly)=>{
 m.read.mockResolvedValue({dailyCostCeilingCents:1000,monthlyCostCeilingCents:20000,dailyFirmCeiling:400});
 expect(await researchSetCeilingsCommand({session,launch,options:{...researchOptions,'--daily-cents':daily,'--monthly-cents':monthly}})).toMatchObject({ok:false,reason:'ceiling_increase_unapproved'});
 expect(m.update).not.toHaveBeenCalled();expect(sqls.at(-1)).toBe('ROLLBACK');
});
it('passes only the two money fields to the normal research owner when no firm ceiling is given',async()=>{
 expect(await researchSetCeilingsCommand({session,launch,options:researchOptions})).toEqual({ok:true,value:{dailyCents:1000,monthlyCents:20000,dailyFirms:400}});
 expect(m.budget).toHaveBeenCalledOnce();expect(m.update).toHaveBeenCalledWith(expect.anything(),{dailyCostCeilingCents:1000,monthlyCostCeilingCents:20000});
 expect(m.audit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({detail:expect.objectContaining({approvalRef:null,before:{dailyCents:4000,monthlyCents:38750,dailyFirms:400},after:{dailyCents:1000,monthlyCents:20000,dailyFirms:400},...launch})}));
});
it.each([{},{'--approval-ref':'   '}])('refuses a firm-ceiling increase without a nonblank approval reference %o',async extra=>{
 const result=await researchSetCeilingsCommand({session,launch,options:{...researchOptions,'--daily-firms':'401',...extra}});
 expect(result).toMatchObject({ok:false,reason:'--approval-ref' in extra?'invalid_options':'ceiling_increase_unapproved'});expect(m.update).not.toHaveBeenCalled();expect(m.audit).not.toHaveBeenCalled();
});
it('passes an approved firm-ceiling increase to the normal research owner',async()=>{
 expect(await researchSetCeilingsCommand({session,launch,options:{...researchOptions,'--daily-firms':'450','--approval-ref':'approval-1'}})).toEqual({ok:true,value:{dailyCents:1000,monthlyCents:20000,dailyFirms:450}});
 expect(m.update).toHaveBeenCalledWith(expect.anything(),{dailyCostCeilingCents:1000,monthlyCostCeilingCents:20000,dailyFirmCeiling:450});
 expect(m.audit).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({action:'research.ceilings_set',detail:expect.objectContaining({approvalRef:'approval-1'})}));
});
it('refuses an unconfigured settings row before reading defaults or writing/auditing',async()=>{
 const missing:SessionQueryable={query:async<Row,>(sql:string)=>{sqls.push(sql);const rows=sql.includes('workspace_memberships')?[{user_id:owner}]:[];return {rows:rows as Row[],rowCount:rows.length};}};
 expect(await researchSetCeilingsCommand({session:missing,launch,options:{...researchOptions,'--daily-cents':'0','--monthly-cents':'0'}})).toMatchObject({ok:false,reason:'settings_unconfigured'});
 expect(m.read).not.toHaveBeenCalled();expect(m.update).not.toHaveBeenCalled();expect(m.audit).not.toHaveBeenCalled();expect(sqls.at(-1)).toBe('ROLLBACK');
});

it.each(['targeting','research'] as const)('accepts the standard --report metadata flag for %s while refusing unknown options',async kind=>{
 const command=kind==='targeting'?targetingConfigureCommand:researchSetCeilingsCommand,options=kind==='targeting'?targetingOptions:researchOptions;
 expect(await command({session,launch,options:{...options,'--report':'/tmp/fictional-operation-report.json'}})).toMatchObject({ok:true});
 const before=[...sqls];expect(await command({session,launch,options:{...options,'--unknown-option':'true'}})).toMatchObject({ok:false,reason:'invalid_options'});expect(sqls).toEqual(before);
});
