import {randomUUID} from 'node:crypto';
import type {SocialDraftRequest,SocialStandingPlanSave,SocialStandingPlanView} from '@fss/contracts';
import type {SessionQueryable} from '../../db/queryable.ts';
import {withTransaction} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {seedTwoWorkspaces,type TwoWorkspaces} from '../db/support/fixtures.ts';
import {saveSocialStandingPlan} from '../../social/standingPlan.ts';
import {admitSocialStandingSlots} from '../../social/standingSlots.ts';
import {readSocialDraftSourcesForWorker} from '../../social/draftSources.ts';
import {bindStandingGenerationRequest} from '../../social/standingAuthority.ts';
import {readStandingSlot} from '../../social/standingPublication.ts';
export interface StandingFixture {seed:TwoWorkspaces;w:string;u:string;owner:RepositoryContext;worker:RepositoryContext;configuration:SocialStandingPlanSave;plan:SocialStandingPlanView;at:Date;target:Date;inputIds:string[]}
export async function standingFixture(session:SessionQueryable,admit=true):Promise<StandingFixture>{
 const seed=await seedTwoWorkspaces(session,`-standing-${randomUUID()}`),w=seed.alpha.workspaceId,u=seed.alpha.admin.userId;
 const owner=repositoryContext(workspaceScope(w,{kind:'user',userId:u,role:'admin'}),session),worker=repositoryContext(workspaceScope(w,{kind:'system',component:'worker'}),session);
 const accountId=randomUUID(),sessionId=randomUUID(),calibrationId=randomUUID(),inputIds=[randomUUID(),randomUUID(),randomUUID()];
 await session.query("INSERT INTO social_accounts(workspace_id,id,owner_user_id,platform,external_id,display_name,account_kind,state,adapter_version,verified_at,max_schedule_days) VALUES($1,$2,$3,'linkedin','https://www.linkedin.com/in/standing-fixture/','Fixture','profile','connected','linkedin-web-chromium-v1',clock_timestamp(),30)",[w,accountId,u]);
 await session.query("INSERT INTO social_publisher_sessions(workspace_id,id,owner_user_id,account_id,account_revision,external_id,encrypted_state,state,verified_at,expires_at) VALUES($1,$2,$3,$4,1,'https://www.linkedin.com/in/standing-fixture/',$5,'usable',clock_timestamp(),clock_timestamp()+interval '7 days')",[w,sessionId,u,accountId,Buffer.alloc(29)]);
 await session.query('INSERT INTO social_founder_calibrations(workspace_id,owner_user_id,id,examples) VALUES($1,$2,$3,$4::jsonb)',[w,u,calibrationId,JSON.stringify([1,2,3].map(()=>({draftId:randomUUID(),revision:1})))]);
 for(const id of inputIds)await session.query("INSERT INTO social_founder_inputs(workspace_id,owner_user_id,id,bullets,context,public_safe) VALUES($1,$2,$3,'I built a small local fixture today.','Controlled fictional source',true)",[w,u,id]);
 const target=new Date();target.setUTCDate(target.getUTCDate()+1);target.setUTCHours(12,0,0,0);const weekday=target.getUTCDay()||7;
 const configuration:SocialStandingPlanSave={expectedRevision:0,binding:{workspaceId:w,ownerUserId:u,accountId,accountRevision:1,sessionId,sessionRevision:1,externalId:'https://www.linkedin.com/in/standing-fixture/'},guideRef:null,calibrationId,inputIds,mediaScope:'none',timezone:'UTC',cadence:[12,13,14].map(hour=>({weekday,time:`${hour}:00`})),scheduledGenerationGrant:'bedrock_haiku_founder_scheduled_v1',publicationGrant:'linkedin_personal_standing_v1',cancelRemoteOnPause:true};
 const saved=await withTransaction(session,()=>saveSocialStandingPlan(owner,configuration));if(!saved.ok)throw new Error(saved.reason);
 const plan=saved.value,at=new Date(target.getTime()-7200000);if(admit)await withTransaction(session,()=>admitSocialStandingSlots(worker,u,plan.planId,plan.revision,at));
 return {seed,w,u,owner,worker,configuration,plan,at,target,inputIds};
}
export async function readyStandingFixture(session:SessionQueryable,f:StandingFixture){
 const slot=(await session.query<{id:string;input_refs:{inputId:string;revision:number}[]}>('SELECT id,input_refs FROM social_standing_slots WHERE workspace_id=$1 ORDER BY ordinal LIMIT 1',[f.w])).rows[0]!;
 const ref={planId:f.plan.planId,revision:1,slotId:slot.id},selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:slot.input_refs,founderFormat:'story',founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1'};
 await withTransaction(session,async()=>{
  const source=await readSocialDraftSourcesForWorker(f.worker,f.u,selection);if(!source.ok)throw new Error(source.reason);
  const requestId=randomUUID();await session.query("INSERT INTO social_draft_requests(workspace_id,id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3,$4::jsonb,$5,'linkedin-founder-v1','claude-haiku-4-5','ready',$6::jsonb)",[f.w,requestId,f.u,JSON.stringify({...selection,standingPlanRef:ref}),source.value.hash,JSON.stringify([{theme:'build',factRefs:[],variants:[{platform:'linkedin',text:'I built a small local fixture today. Here is what I learned.'}]}])]);
  const bound=await bindStandingGenerationRequest(f.worker,f.u,ref,requestId);if(!bound.ok)throw new Error(bound.reason);
  await session.query("UPDATE social_standing_slots SET state='queued',text='I built a small local fixture today. Here is what I learned.',revision=revision+1 WHERE workspace_id=$1 AND id=$2",[f.w,slot.id]);
 });
 return (await readStandingSlot(f.worker,slot.id))!;
}
