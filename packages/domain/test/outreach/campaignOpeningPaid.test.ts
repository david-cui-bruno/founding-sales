import {beforeEach,expect,it,vi} from 'vitest';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import type {SessionQueryable} from '../../db/queryable.ts';
import type {CampaignOpeningSnapshot} from '../../outreach/campaignOpening.ts';
import type {CampaignOpeningModelPort,CampaignOpeningDispatchAuthority} from '../../outreach/campaignOpeningModelPort.ts';
import {budgetedCampaignOpeningSelector} from '../../outreach/campaignOpeningPaid.ts';
import {ModelBudgetRefusal} from '../../research/modelBudget.ts';

const mocks=vi.hoisted(()=>({gate:vi.fn(),budget:vi.fn(),settings:vi.fn(),holds:vi.fn(),spend:vi.fn(),
 now:vi.fn(),zone:vi.fn(),read:vi.fn(),reserve:vi.fn(),mark:vi.fn(),settle:vi.fn()}));
vi.mock('../../policy/sendGate.ts',()=>({lockSendGateForDispatch:mocks.gate}));
vi.mock('../../research/ceilings.ts',()=>({lockResearchBudget:mocks.budget}));
vi.mock('../../research/settings.ts',()=>({readResearchSettings:mocks.settings}));
vi.mock('../../policy/holds.ts',()=>({listApplicableHolds:mocks.holds}));
vi.mock('../../research/ledger.ts',()=>({readCreditSpend:mocks.spend,workspaceBusinessZone:mocks.zone}));
vi.mock('../../policy/clock.ts',()=>({databaseNow:mocks.now}));
vi.mock('../../research/reservations.ts',()=>({readAttempt:mocks.read,reserveAttempt:mocks.reserve,
 markCalling:mocks.mark,settleAttempt:mocks.settle}));

const id='10000000-0000-4000-8000-000000000001',attemptId='20000000-0000-4000-8000-000000000002';
const snapshot:CampaignOpeningSnapshot={
 policy:{id,workspaceId:id,ownerUserId:id,campaignId:id,campaignRevision:1,sequenceVersionId:id,
  templateVersionId:id,templateContentHash:'a'.repeat(64),revision:1,mode:'approved_variant_selection_v1',firstEmailOnly:true,
  variants:[{id:'local',text:'Approved {{firm_name}} line.'}],approvedAt:'2026-10-29T00:00:00Z',expiresAt:'2026-10-30T00:00:00Z'},
 binding:{workspaceId:id,ownerUserId:id,campaignId:id,campaignRevision:1,policyId:id,sequenceVersionId:id,
  templateVersionId:id,templateContentHash:'a'.repeat(64),enrollmentId:id,executionId:id,firmId:id,
  candidateId:id,candidateRevision:1,qualificationRunId:id,sourceFingerprint:'b'.repeat(64),validUntil:'2026-10-30T00:00:00Z'},
 source:{firmName:'Fictional Homes',locality:'Dallas',region:'TX'},citationIds:['public:current'],
};
const choice={variantId:'local',citationIds:['public:current']};
const reservation={id:'reservation',businessDate:'2026-10-28',businessTimeZone:'America/New_York'};
let transaction=false,events:string[],allowed:boolean,consumed:boolean;
let clockAt:string,businessTimeZone:string;
let afterCommit:()=>void;
const session:SessionQueryable={async query(text){
 events.push(text);
 if(text==='BEGIN'){expect(transaction).toBe(false);transaction=true;}
 if(text==='COMMIT'){transaction=false;afterCommit();}
 if(text==='ROLLBACK')transaction=false;
 return {rows:[],rowCount:0};
}};
const ctx=repositoryContext(workspaceScope(id,{kind:'system',component:'worker'}),session);
const count=vi.fn(async()=>{expect(transaction).toBe(false);events.push('count');return 100;});
const select=vi.fn(async()=>{expect(transaction).toBe(false);events.push('select');return {choice,costCents:1,costEstimated:false};});
const port:CampaignOpeningModelPort={providerKey:'aws_bedrock.campaign_opening',countInputTokens:count,select};
const current=vi.fn(async()=>allowed);
const finalAuthority=vi.fn<()=>Promise<CampaignOpeningDispatchAuthority|null>>();
const run=()=>budgetedCampaignOpeningSelector(ctx,session,port,current,finalAuthority).select({...snapshot,attemptId});
beforeEach(()=>{
 vi.resetAllMocks();transaction=false;events=[];allowed=true;consumed=false;afterCommit=()=>{};
 clockAt='2026-10-29T01:00:00Z';businessTimeZone='America/New_York';
 mocks.gate.mockImplementation(async()=>{events.push('send gate');});
 mocks.budget.mockImplementation(async()=>{events.push('research lock');});
 mocks.settings.mockResolvedValue({enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000});
 mocks.holds.mockResolvedValue([]);mocks.spend.mockImplementation(async()=>({todayCents:consumed?1:0,monthToDateCents:consumed?1:0}));
 mocks.now.mockImplementation(async()=>clockAt);mocks.zone.mockImplementation(async()=>businessTimeZone);
 mocks.read.mockImplementation(async()=>consumed?{id:'reservation'}:null);
 mocks.reserve.mockImplementation(async()=>{events.push('reserve');return reservation;});
 mocks.mark.mockImplementation(async()=>{expect(transaction).toBe(true);events.push('calling');consumed=true;return true;});
 mocks.settle.mockImplementation(async()=>{expect(transaction).toBe(true);events.push('settle');return {recordedCents:1,state:'settled'};});
 current.mockImplementation(async()=>allowed);
 finalAuthority.mockImplementation(async()=>{
  events.push('final snapshot');return {authorized:allowed,at:clockAt,businessTimeZone};
 });
 count.mockImplementation(async()=>{expect(transaction).toBe(false);events.push('count');return 100;});
 select.mockImplementation(async()=>{expect(transaction).toBe(false);events.push('select');return {choice,costCents:1,costEstimated:false};});
});
it('commits the priced calling marker before one provider call and settles actual usage without source prose in accounting',async()=>{
 expect(await run()).toEqual({kind:'selected',choice});
 expect(events).toEqual(['count','BEGIN','send gate','research lock','reserve','calling','COMMIT','final snapshot','select','BEGIN','settle','COMMIT']);
 expect(finalAuthority).toHaveBeenCalledOnce();
 expect(mocks.reserve).toHaveBeenCalledWith(ctx,{subjectKind:'campaign_opening',subjectId:attemptId,attempt:1,
  providerKey:'aws_bedrock.campaign_opening',at:'2026-10-29T01:00:00Z',businessTimeZone:'America/New_York',cents:1,
  modelName:'claude-haiku-4-5',maxInputTokens:105,maxOutputTokens:256});
 expect(mocks.holds).toHaveBeenCalledWith(ctx,{actionKind:'research',firmId:id,ownerUserId:id});
 expect(mocks.settle).toHaveBeenCalledWith(ctx,{reservationId:'reservation',at:'2026-10-29T01:00:00Z',outcome:{kind:'settled',cents:1}});
 expect(count).toHaveBeenCalledWith(snapshot);expect(select).toHaveBeenCalledWith(snapshot);
 expect(JSON.stringify(mocks.reserve.mock.calls)).not.toContain('Fictional Homes');
});
it('an existing attempt never counts or selects again, including after prior successful settlement',async()=>{
 await run();expect(await run()).toEqual({kind:'refused'});
 expect(count).toHaveBeenCalledOnce();expect(select).toHaveBeenCalledOnce();expect(mocks.mark).toHaveBeenCalledOnce();
});
it.each(['owner off','after lookup','after count','inside transaction','before reserve'] as const)('refuses authority loss %s before invocation',async where=>{
 if(where==='owner off')allowed=false;
 if(where==='after lookup')mocks.read.mockImplementation(async()=>{allowed=false;return null;});
 if(where==='after count')count.mockImplementation(async()=>{allowed=false;return 100;});
 if(where==='inside transaction')mocks.budget.mockImplementation(async()=>{allowed=false;});
 if(where==='before reserve')mocks.spend.mockImplementation(async()=>{allowed=false;return {todayCents:0,monthToDateCents:0};});
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();expect(mocks.mark).not.toHaveBeenCalled();
 if(where==='owner off'||where==='after lookup')expect(count).not.toHaveBeenCalled();
});
it.each(['disabled','hold','daily','monthly','shared cap','mark refused'] as const)('keeps %s refusal inside existing budget/attempt owners',async where=>{
 if(where==='disabled')mocks.settings.mockResolvedValue({enabled:false,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000});
 if(where==='hold')mocks.holds.mockResolvedValue([{id:'hold'}]);
 if(where==='daily')mocks.spend.mockResolvedValue({todayCents:100,monthToDateCents:100});
 if(where==='monthly')mocks.spend.mockResolvedValue({todayCents:0,monthToDateCents:1000});
 if(where==='shared cap')mocks.reserve.mockRejectedValue(new ModelBudgetRefusal('credit_model_daily_ceiling'));
 if(where==='mark refused')mocks.mark.mockResolvedValue(false);
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();
 if(where==='shared cap')expect(events).toContain('ROLLBACK');
});
it('a concurrent existing reservation observed inside the transaction refuses without a second claim',async()=>{
 mocks.read.mockResolvedValueOnce(null).mockResolvedValueOnce({id:'other calling reservation'});
 expect(await run()).toEqual({kind:'refused'});expect(mocks.reserve).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
});
it.each(['authority','disabled','hold'] as const)('releases its committed calling marker if %s changes before dispatch and never reopens it',async where=>{
 afterCommit=()=>{
  if(where==='authority')allowed=false;
  if(where==='disabled')mocks.settings.mockResolvedValue({enabled:false});
  if(where==='hold')mocks.holds.mockResolvedValue([{id:'new hold'}]);
 };
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
 allowed=true;mocks.settings.mockResolvedValue({enabled:true});mocks.holds.mockResolvedValue([]);afterCommit=()=>{};
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();expect(count).toHaveBeenCalledOnce();
});
it.each(['daily','monthly'] as const)('releases the original committed reservation after its %s ceiling is lowered below open spend',async limit=>{
 afterCommit=()=>{mocks.settings.mockResolvedValue({enabled:true,dailyCostCeilingCents:limit==='daily'?0:100,
  monthlyCostCeilingCents:limit==='monthly'?0:1000});};
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
 expect(await run()).toEqual({kind:'refused'});expect(count).toHaveBeenCalledOnce();
});
it('does not add reserved cents again when newly lowered ceilings exactly cover the open obligation',async()=>{
 afterCommit=()=>{mocks.settings.mockResolvedValue({enabled:true,dailyCostCeilingCents:1,monthlyCostCeilingCents:1});};
 expect(await run()).toEqual({kind:'selected',choice});expect(select).toHaveBeenCalledOnce();
});
it.each(['date','zone'] as const)('does not move its committed reservation across a business %s change before dispatch',async change=>{
 afterCommit=()=>{
  if(change==='date')clockAt='2026-10-29T04:00:00Z';
  else businessTimeZone='Europe/London';
 };
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
 expect(mocks.reserve).toHaveBeenCalledOnce();
});
it('checks the final database snapshot after a spend-read wait crosses the original business date',async()=>{
 mocks.spend.mockImplementation(async()=>{
  if(consumed)clockAt='2026-10-29T04:00:00Z';
  return {todayCents:consumed?1:0,monthToDateCents:consumed?1:0};
 });
 expect(await run()).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
});
it('uses one final snapshot and releases without selection when OFF commits while that query is paused',async()=>{
 let enter=()=>{},release=()=>{};
 const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 finalAuthority.mockImplementation(async()=>{
  enter();await blocked;events.push('final snapshot');return {authorized:allowed,at:clockAt,businessTimeZone};
 });
 const pending=run();await entered;allowed=false;release();
 expect(await pending).toEqual({kind:'refused'});expect(select).not.toHaveBeenCalled();expect(finalAuthority).toHaveBeenCalledOnce();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
 expect(mocks.reserve).toHaveBeenCalledOnce();
});
it.each(['date','zone'] as const)('releases the original reservation after %s changes during the single final snapshot wait',async change=>{
 let enter=()=>{},release=()=>{};
 const entered=new Promise<void>(resolve=>{enter=resolve;}),blocked=new Promise<void>(resolve=>{release=resolve;});
 finalAuthority.mockImplementation(async()=>{
  enter();await blocked;return {authorized:allowed,at:clockAt,businessTimeZone};
 });
 const pending=run();await entered;
 if(change==='date')clockAt='2026-10-29T04:00:00Z';else businessTimeZone='Europe/London';
 release();expect(await pending).toEqual({kind:'refused'});
 expect(select).not.toHaveBeenCalled();expect(finalAuthority).toHaveBeenCalledOnce();expect(mocks.reserve).toHaveBeenCalledOnce();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
});
it('refuses an unavailable final snapshot without replacing the already committed reservation',async()=>{
 finalAuthority.mockResolvedValue(null);expect(await run()).toEqual({kind:'refused'});
 expect(select).not.toHaveBeenCalled();expect(finalAuthority).toHaveBeenCalledOnce();expect(mocks.reserve).toHaveBeenCalledOnce();
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'released_not_called'}}));
});
it.each([0,-1,NaN,Infinity,9524,10000])('refuses unusable or headroom-over-budget input count %s without reservation',async tokens=>{
 count.mockResolvedValue(tokens);expect(await run()).toEqual({kind:'refused'});
 expect(mocks.reserve).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
});
it('refuses unavailable token counting and keeps the largest headroom-bounded count priced',async()=>{
 count.mockRejectedValueOnce(Error('unavailable'));expect(await run()).toEqual({kind:'refused'});expect(mocks.reserve).not.toHaveBeenCalled();
 count.mockResolvedValueOnce(9523);expect(await run()).toEqual({kind:'selected',choice});
 expect(mocks.reserve).toHaveBeenCalledWith(ctx,expect.objectContaining({maxInputTokens:10000,maxOutputTokens:256}));
});
it('refuses a malformed port with missing token counting or an absent numeric count before reserving',async()=>{
 // @ts-expect-error Runtime integration failure deliberately omits the required count port.
 const incomplete:CampaignOpeningModelPort={providerKey:'aws_bedrock.campaign_opening',select};
 expect(await budgetedCampaignOpeningSelector(ctx,session,incomplete,current,finalAuthority).select({...snapshot,attemptId})).toEqual({kind:'refused'});
 // @ts-expect-error Runtime integration failure deliberately omits its token-count result.
 count.mockResolvedValue(undefined);
 expect(await run()).toEqual({kind:'refused'});expect(mocks.reserve).not.toHaveBeenCalled();expect(select).not.toHaveBeenCalled();
});
it.each([{costEstimated:true,costCents:0},{costEstimated:false,costCents:NaN},{costEstimated:false,costCents:-1}])('settles unobserved or invalid usage conservatively %#',async usage=>{
 select.mockResolvedValue({choice,...usage});expect(await run()).toEqual({kind:'selected',choice});
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'estimated'}}));
});
it('settles missing usage metadata as estimated while leaving choice validation to the opening owner',async()=>{
 // @ts-expect-error The model completed but runtime usage metadata was absent.
 select.mockResolvedValue({choice});
 expect(await run()).toEqual({kind:'selected',choice});
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'estimated'}}));
});
it('settles an unknown provider outcome as estimated before throwing, preserving consumed identity without retry',async()=>{
 const failure=Error('provider outcome unknown');select.mockRejectedValue(failure);
 await expect(run()).rejects.toBe(failure);
 expect(mocks.settle).toHaveBeenCalledWith(ctx,expect.objectContaining({outcome:{kind:'estimated'}}));
 expect(await run()).toEqual({kind:'refused'});expect(select).toHaveBeenCalledOnce();expect(count).toHaveBeenCalledOnce();
});
it('does not replace a calling marker when the reservation commit itself is uncertain',async()=>{
 afterCommit=()=>{throw Error('commit receipt lost');};
 await expect(run()).rejects.toThrow('commit receipt lost');expect(select).not.toHaveBeenCalled();
 afterCommit=()=>{};expect(await run()).toEqual({kind:'refused'});expect(count).toHaveBeenCalledOnce();
});
