import {beforeEach,expect,it,vi} from 'vitest';
import type {RepositoryContext} from '../../db/workspaceScope.ts';
import type {QualifiedResearchFirm} from '@fss/contracts';
import {openTodayActionV3,readTodayActionsV3} from '../../today/actionsV3.ts';
const mocks=vi.hoisted(()=>({active:vi.fn(),read:vi.fn(),prior:vi.fn()}));
vi.mock('../../crm/identityAccess.ts',()=>({activeIdentityActor:mocks.active}));
vi.mock('../../sourcing/qualifiedResearch.ts',()=>({readQualifiedResearchFirm:mocks.read}));
vi.mock('../../today/actionsV2.ts',()=>({readTodayActionsV2:mocks.prior}));
const id='00000000-0000-4000-8000-000000000001',now='2026-10-22T12:00:00.000Z';
const ctx={db:{query:async()=>({rows:[{firm_id:id}]})},scope:{workspaceId:id}} as unknown as RepositoryContext;
const proof={firmId:id,firmName:'Synthetic Firm',promotionId:id,selection:{discoveryCandidateId:id,discoveryRevision:1,candidateId:id,candidateRevision:1,runId:id},evidenceFingerprint:'a'.repeat(64),citations:[{retrievedAt:now}]} as QualifiedResearchFirm;
beforeEach(()=>{mocks.active.mockResolvedValue(true);mocks.read.mockResolvedValue(proof);mocks.prior.mockResolvedValue({version:2,workspaceId:id,businessTimeZone:'America/Chicago',asOf:now,actions:[],promiseCoverage:{}});});
it('projects only current linked proof and opens the complete exact target',async()=>{
 const queue=await readTodayActionsV3(ctx,{now});const action=queue!.actions[0]!;
 expect(action.kind).toBe('research');
 expect(await openTodayActionV3(ctx,{now,actionId:action.actionId,target:action.target})).toEqual({version:3,target:action.target,research:proof});
 for(const key of ['candidateRevision','discoveryRevision','evidenceFingerprint','runId','promotionId','firmId']){
  expect(await openTodayActionV3(ctx,{now,actionId:action.actionId,target:{...action.target,[key]:'changed'}})).toEqual({version:3,target:null,research:null});
 }
});
it('omits unavailable proof and refuses identity loss or late proof changes',async()=>{
 mocks.read.mockResolvedValue(null);expect((await readTodayActionsV3(ctx,{now}))!.actions).toEqual([]);
 mocks.read.mockResolvedValue(proof);const action=(await readTodayActionsV3(ctx,{now}))!.actions[0]!;
 mocks.read.mockResolvedValueOnce(proof).mockResolvedValueOnce({...proof,evidenceFingerprint:'b'.repeat(64)});
 expect(await openTodayActionV3(ctx,{now,actionId:action.actionId,target:action.target})).toEqual({version:3,target:null,research:null});
 mocks.active.mockResolvedValue(false);expect(await readTodayActionsV3(ctx,{now})).toBeNull();
});
