import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,it,expect} from 'vitest';
import type {SocialDraftRequest} from '@fss/contracts';
import {createTestDatabase,type TestDatabase} from '../../db/testing/testDatabase.ts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext} from '../../db/workspaceScope.ts';
import {standingFixture} from './standingFixture.ts';
import {readSocialDraftSourcesForWorker} from '../../social/draftSources.ts';
import {bindStandingGenerationRequest} from '../../social/standingAuthority.ts';
import {pauseSocialStandingPlan} from '../../social/standingPlan.ts';
import {runSocialDraft,type SocialDraftPort} from '../../social/draftRun.ts';
import {updateResearchSettings} from '../../research/settings.ts';
let db:TestDatabase;
beforeAll(async()=>{db=await createTestDatabase();});afterAll(async()=>db.drop());
async function queuedStanding(session:SessionQueryable){
 const f=await standingFixture(session);await withTransaction(session,()=>updateResearchSettings(f.owner,{enabled:true,dailyCostCeilingCents:100,monthlyCostCeilingCents:1000}));
 const slot=(await session.query<{id:string;input_refs:{inputId:string;revision:number}[]}>('SELECT id,input_refs FROM social_standing_slots WHERE workspace_id=$1 ORDER BY ordinal LIMIT 1',[f.w])).rows[0]!;
 const ref={planId:f.plan.planId,revision:1,slotId:slot.id},selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:slot.input_refs,founderFormat:'story',founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1'},requestId=randomUUID();
 await withTransaction(session,async()=>{
  const source=await readSocialDraftSourcesForWorker(f.worker,f.u,selection);if(!source.ok)throw Error(source.reason);
  await session.query("INSERT INTO social_draft_requests(workspace_id,id,owner_user_id,source_selection,source_hash,prompt_version,model_name) VALUES($1,$2,$3,$4::jsonb,$5,'linkedin-founder-v1','claude-haiku-4-5')",[f.w,requestId,f.u,JSON.stringify({...selection,standingPlanRef:ref}),source.value.hash]);
  const bound=await bindStandingGenerationRequest(f.worker,f.u,ref,requestId);if(!bound.ok)throw Error(bound.reason);
 });
 return {...f,requestId};
}
it.each(['count','generate'] as const)('standing %s actual transport await holds owner/plan fence, pause waits then prevents further egress or late prose',async phase=>{
 const f=await queuedStanding(db.session),runner=await db.appRuntimeSession(),stopper=await db.appRuntimeSession(),worker=repositoryContext(f.worker.scope,runner),owner=repositoryContext(f.owner.scope,stopper);
 const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>();let counts=0,generations=0;
 const port:SocialDraftPort={providerKey:'aws_bedrock.social_draft',founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1',countInputTokens:async()=>{counts++;if(phase==='count'){entered.resolve();await release.promise;}return 100;},generate:async()=>{generations++;if(phase==='generate'){entered.resolve();await release.promise;}return {raw:JSON.stringify({concepts:[{theme:'founder',factRefs:[],variants:[{platform:'linkedin',text:'I built a small local fixture today.\n\nKeeping the local experiment small helped me see what I was learning.'}]}]}),costCents:1,costEstimated:false};}};
 const running=runSocialDraft(worker,f.requestId,port);await entered.promise;
 const pid=(await stopper.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
 const pausing=withTransaction(stopper,()=>pauseSocialStandingPlan(owner,{planId:f.plan.planId,expectedRevision:1}));
 try{await expect.poll(async()=>Boolean((await db.session.query('SELECT cardinality(pg_blocking_pids($1))>0 waiting',[pid])).rows[0]?.['waiting'])).toBe(true);expect(counts).toBe(1);expect(generations).toBe(phase==='count'?0:1);}finally{release.resolve();}
 expect(await pausing).toMatchObject({ok:true});await running;
 expect(generations).toBe(phase==='count'?0:1);expect(worker.scope.actor).toEqual({kind:'system',component:'worker'});
 expect((await db.session.query('SELECT concepts FROM social_draft_requests WHERE workspace_id=$1 AND id=$2',[f.w,f.requestId])).rows[0]?.['concepts']).toBeNull();
 expect((await db.session.query('SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[f.w,f.requestId])).rows).toEqual(phase==='count'?[]:[{state:'settled'}]);
 await runSocialDraft(worker,f.requestId,port);expect(counts).toBe(1);expect(generations).toBe(phase==='count'?0:1);
});
it('a committed standing stop blocks both actual token-count and generation calls',async()=>{
 const f=await queuedStanding(db.session);await withTransaction(db.session,()=>pauseSocialStandingPlan(f.owner,{planId:f.plan.planId,expectedRevision:1}));let calls=0;
 await runSocialDraft(f.worker,f.requestId,{providerKey:'aws_bedrock.social_draft',founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1',countInputTokens:async()=>{calls++;return 100;},generate:async()=>{calls++;throw Error('No call authorized');}});
 expect(calls).toBe(0);expect((await db.session.query('SELECT state FROM provider_reservations WHERE workspace_id=$1 AND subject_id=$2',[f.w,f.requestId])).rows).toEqual([]);
});
