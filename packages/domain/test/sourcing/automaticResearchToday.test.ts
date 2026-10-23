import {beforeEach,expect,it,vi} from 'vitest';
import type {AutomaticResearchFirm,TodayActionV3} from '@fss/contracts';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import {readTodayActionsV4,openTodayActionV4} from '../../today/actionsV4.ts';
const mocks=vi.hoisted(()=>({active:vi.fn(),read:vi.fn(),prior:vi.fn(),open:vi.fn(),now:vi.fn()}));
vi.mock('../../crm/identityAccess.ts',()=>({activeIdentityActor:mocks.active}));
vi.mock('../../sourcing/automaticResearch.ts',()=>({readAutomaticResearchFirm:mocks.read}));
vi.mock('../../sourcing/automaticResearchAuthority.ts',()=>({automaticResearchNow:mocks.now}));
vi.mock('../../today/actionsV3.ts',()=>({readTodayActionsV3:mocks.prior,openTodayActionV3:mocks.open}));
const id='00000000-0000-4000-8000-000000000001',now='2026-10-22T12:00:00.000Z';
const ctx={db:{query:async()=>({rows:[{id}]})},scope:{workspaceId:id}} as unknown as RepositoryContext;
const proof={target:{kind:'automatic_research',publicationId:id,publicationRevision:1,firmId:id,candidateId:id,candidateRevision:1,runId:id,evidenceFingerprint:'a'.repeat(64)},firmName:'Synthetic Firm',validUntil:'2026-10-29T12:00:00.000Z',citations:[{retrievedAt:now}]} as AutomaticResearchFirm;
const empty={version:4,target:null,research:null,automaticResearch:null};
beforeEach(()=>{vi.clearAllMocks();mocks.active.mockResolvedValue(true);mocks.now.mockResolvedValue(now);mocks.read.mockResolvedValue(proof);mocks.prior.mockResolvedValue({version:3,workspaceId:id,businessTimeZone:'America/Chicago',asOf:now,actions:[],promiseCoverage:{}});});
it('projects and opens exact current automatic lineage without promoting discovery',async()=>{
 const action=(await readTodayActionsV4(ctx,{now}))!.actions[0]!;expect(action).toMatchObject({actionId:`automatic-research:${id}`,reason:'automatic_research_ready',target:proof.target});
 expect(await openTodayActionV4(ctx,{now,actionId:action.actionId,target:action.target})).toEqual({version:4,target:proof.target,research:null,automaticResearch:proof});
 for(const key of ['publicationRevision','candidateRevision','evidenceFingerprint','runId','publicationId','firmId','candidateId'])expect(await openTodayActionV4(ctx,{now,actionId:action.actionId,target:{...action.target,[key]:'changed'}})).toEqual(empty);
 expect(await openTodayActionV4(ctx,{now,actionId:'changed',target:action.target})).toEqual(empty);
});
it('preserves V3 action identity and original research proof on V4 open',async()=>{
 const old={actionId:'existing',target:{kind:'qualified_research'}} as TodayActionV3;
 mocks.prior.mockResolvedValue({version:3,actions:[old]});mocks.read.mockResolvedValue(null);
 expect((await readTodayActionsV4(ctx,{now}))!.actions).toEqual([old]);
 const prior={version:3,target:old.target,research:{firmId:id}};mocks.open.mockResolvedValue(prior);
 expect(await openTodayActionV4(ctx,{now,actionId:old.actionId,target:old.target})).toEqual({...prior,version:4,automaticResearch:null});
});
it('withholds unavailable, changed or expired proof and rejects authority loss',async()=>{
 mocks.read.mockResolvedValue(null);expect((await readTodayActionsV4(ctx,{now}))!.actions).toEqual([]);
 expect(await openTodayActionV4(ctx,{now,actionId:`automatic-research:${id}`,target:proof.target})).toEqual(empty);
 mocks.read.mockResolvedValueOnce(proof).mockResolvedValueOnce({...proof,target:{...proof.target,publicationRevision:2}});expect((await readTodayActionsV4(ctx,{now}))!.actions).toEqual([]);
 mocks.read.mockResolvedValue(proof);mocks.now.mockResolvedValue(proof.validUntil);expect((await readTodayActionsV4(ctx,{now}))!.actions).toEqual([]);
 expect(await openTodayActionV4(ctx,{now,actionId:`automatic-research:${id}`,target:proof.target})).toEqual(empty);
 mocks.active.mockResolvedValue(false);expect(await readTodayActionsV4(ctx,{now})).toBeNull();
 expect(await openTodayActionV4(ctx,{now,actionId:`automatic-research:${id}`,target:proof.target})).toEqual(empty);
});
