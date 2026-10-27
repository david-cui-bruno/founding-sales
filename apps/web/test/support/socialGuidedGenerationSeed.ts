import assert from 'node:assert/strict';
import {repositoryContext,workspaceScope} from '@fss/domain/db/workspaceScope.ts';
import {withTransaction} from '@fss/domain/db/queryable.ts';
import {updateResearchSettings} from '@fss/domain/research/settings.ts';
import {runSocialDraft} from '@fss/domain/social/draftRun.ts';
import {retireAnswerBlock} from '@fss/domain/outreach/facts.ts';
import {voiceGenerationSelection,fakeVoicePort} from '../../../../packages/domain/test/social/voiceGenerationFixtures.ts';
import type {ManualProspectApp} from './manualProspectApp.ts';
/** Authoring this fixture does not allocate a runtime. Root's fresh exclusive
 * PG/HTTPS/OIDC/installed-Chrome grant is mandatory before executing its spec. */
export async function seedSocialGuidedGeneration(app:ManualProspectApp){
 const f=app.fixture,db=await f.database.appRuntimeSession(),ctx=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'user',userId:f.alpha.admin.userId,role:'admin'}),db);
 assert.equal((await db.query('SELECT current_user')).rows[0]?.['current_user'],'app_runtime');
 await withTransaction(db,()=>updateResearchSettings(ctx,{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));
 const selection=await withTransaction(db,()=>voiceGenerationSelection(ctx));assert(selection.voiceGuideRef);assert(selection.factBlocks[0]);
 return {selection,generate:async(requestId:string)=>{
  const workerDb=await f.database.appRuntimeSession(),worker=repositoryContext(workspaceScope(f.alpha.workspaceId,{kind:'system',component:'worker'}),workerDb);
  await runSocialDraft(worker,requestId,fakeVoicePort());
  const row=(await workerDb.query<{state:string;paid_attempts:number}>('SELECT state,paid_attempts FROM social_draft_requests WHERE id=$1',[requestId])).rows[0];assert.equal(row?.state,'ready');assert.equal(row.paid_attempts,1);
 },retire:async()=>{const result=await withTransaction(db,()=>retireAnswerBlock(ctx,selection.factBlocks[0]!));assert(result.ok);}};
}
