import {randomUUID} from 'node:crypto';
import type {SocialDraftRequest} from '@fss/contracts';
import type {SocialStandingRef} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {currentStandingConfiguration} from './standingAuthority.ts';
import {standingWeekSlots,standingWeek} from './standingCadence.ts';
import {readApprovedSocialMediaForOwner} from './approvedMedia.ts';
import {readSocialDraftSourcesForWorker} from './draftSources.ts';
import type {SocialDraftRow} from './drafts.ts';
export interface StandingGenerationAdmission { (ctx:RepositoryContext,owner:string,ref:SocialStandingRef,selection:SocialDraftRequest,deadline:Date):Promise<SocialResult<{requestId:string}>> }
export async function admitSocialStandingSlots(ctx:RepositoryContext,owner:string,planId:string,revision:number,at:Date):Promise<void>{
 const c=await currentStandingConfiguration(ctx,owner,{planId,revision});if(!c)return;
 const budgetZone=(await ctx.db.query<{budget_timezone:string}>('SELECT budget_timezone FROM social_standing_plans WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,planId])).rows[0]!.budget_timezone;
 const horizon=new Date(at.getTime()+86400000),bases=standingWeek(at,c.timezone)===standingWeek(horizon,c.timezone)?[at]:[at,horizon],cadence=[...c.cadence].sort((a,b)=>a.weekday-b.weekday||a.time.localeCompare(b.time));
 const windows=bases.map(basis=>({basis,week:standingWeek(basis,c.timezone),targets:standingWeekSlots(basis,c)}));
 for(const {basis,week,targets} of windows)for(const [index,slot] of cadence.entries()){
  if(targets.some(t=>t.ordinal===index+1))continue;const date=new Date(`${week}T12:00:00Z`);date.setUTCDate(date.getUTCDate()+slot.weekday-1);
  const end=new Date(`${week}T12:00:00Z`);end.setUTCDate(end.getUTCDate()+7);
  const count=(await ctx.db.query<{count:string}>('SELECT count(*) FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND (local_week=$4::date OR local_week=$6::date OR ((publish_at AT TIME ZONE $3)::date >= $4::date AND (publish_at AT TIME ZONE $3)::date < $5::date))',[ctx.scope.workspaceId,owner,c.timezone,week,end.toISOString().slice(0,10),standingWeek(basis,budgetZone)])).rows[0];if(Number(count?.count)>=3)break;
  await ctx.db.query("INSERT INTO social_standing_slots(workspace_id,owner_user_id,plan_id,plan_revision,local_week,ordinal,publish_at,local_target,state,reason) VALUES($1,$2,$3,$4,$5,$6,NULL,$7,'skipped','daylight_saving_gap') ON CONFLICT DO NOTHING",[ctx.scope.workspaceId,owner,planId,revision,standingWeek(basis,budgetZone),index+1,`${date.toISOString().slice(0,10)} ${slot.time} ${c.timezone}`]);
 }
 for(const target of windows.flatMap(window=>window.targets)){
  if(target.publishAt.getTime()>at.getTime()+86400000)continue;
  const localWeek=standingWeek(target.publishAt,budgetZone);
  const actualWeek=standingWeek(target.publishAt,c.timezone),actualEnd=new Date(`${actualWeek}T12:00:00Z`);actualEnd.setUTCDate(actualEnd.getUTCDate()+7);
  const existing=(await ctx.db.query<{count:string}>(`SELECT count(*) FROM social_standing_slots WHERE workspace_id=$1 AND owner_user_id=$2 AND (local_week=$4::date OR ((publish_at AT TIME ZONE $3)::date >= $4::date AND (publish_at AT TIME ZONE $3)::date < $5::date))`,[ctx.scope.workspaceId,owner,c.timezone,actualWeek,actualEnd.toISOString().slice(0,10)])).rows[0];if(Number(existing?.count)>=3)continue;
  const missed=target.publishAt.getTime()<=at.getTime()+3600000;
  const slotId=randomUUID();const inserted=await ctx.db.query(`INSERT INTO social_standing_slots(workspace_id,id,owner_user_id,plan_id,plan_revision,local_week,ordinal,publish_at,state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING RETURNING id`,[ctx.scope.workspaceId,slotId,owner,planId,revision,localWeek,target.ordinal,target.publishAt,missed?'skipped':'preparing',missed?'missed_window':null]);if(!inserted.rows.length||missed)continue;
  const source=(await ctx.db.query<{id:string;revision:number}>(`SELECT i.id,i.revision FROM social_founder_inputs i WHERE i.workspace_id=$1 AND i.owner_user_id=$2 AND i.id=ANY($3::uuid[]) AND i.public_safe AND i.reason IS NULL AND i.expires_at>$4 AND NOT EXISTS(SELECT 1 FROM social_standing_lineage l WHERE l.workspace_id=i.workspace_id AND l.owner_user_id=i.owner_user_id AND l.input_id=i.id) ORDER BY i.created_at,i.id LIMIT 1 FOR UPDATE`,[ctx.scope.workspaceId,owner,c.inputIds,target.publishAt])).rows[0];
  if(!source){await ctx.db.query("UPDATE social_standing_slots SET state='skipped',reason='no_material' WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,slotId]);continue;}
  const refs=[{inputId:source.id,revision:source.revision}];await ctx.db.query('INSERT INTO social_standing_lineage(workspace_id,owner_user_id,input_id,slot_id) VALUES($1,$2,$3,$4)',[ctx.scope.workspaceId,owner,source.id,slotId]);
  let image:Record<string,unknown>|null=null;
  if(c.mediaScope==='approved_pool'){
   // Only explicit topic matches; an unrelated approved photograph is not filler.
   const candidate=(await ctx.db.query<{id:string;approved_version:number;approved_sha256:string;approval_revision:number}>(`SELECT a.id,a.approved_version,a.approved_sha256,a.approval_revision FROM social_assets a JOIN social_founder_inputs i ON i.workspace_id=a.workspace_id AND i.owner_user_id=a.owner_user_id AND i.id=$3 WHERE a.workspace_id=$1 AND a.owner_user_id=$2 AND a.approved_version IS NOT NULL AND length(a.approved_topic)>2 AND position(lower(a.approved_topic) in lower(concat(i.bullets,' ',i.context)))>0 ORDER BY a.id LIMIT 1`,[ctx.scope.workspaceId,owner,source.id])).rows[0];
   if(candidate){const m=await readApprovedSocialMediaForOwner(ctx,owner,{assetId:candidate.id,version:candidate.approved_version,sha256:candidate.approved_sha256,approvalRevision:candidate.approval_revision});if(m)image={assetId:m.assetId,version:m.version,sha256:m.sha256,approvalRevision:m.approvalRevision,altText:m.altText,mime:m.mime,byteLength:m.byteLength};}
  }
  await ctx.db.query('UPDATE social_standing_slots SET input_refs=$3::jsonb,image=$4::jsonb WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,slotId,JSON.stringify(refs),image?JSON.stringify(image):null]);
 }
}
export async function prepareSocialStandingSlot(ctx:RepositoryContext,slotId:string,admitGeneration:StandingGenerationAdmission):Promise<void>{
 const s=(await ctx.db.query<{owner_user_id:string;plan_id:string;plan_revision:number;state:string;generation_request_id:string|null;input_refs:{inputId:string;revision:number}[];publish_at:Date;local_week:Date|string;ordinal:number}>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,slotId])).rows[0];if(!s||s.state!=='preparing')return;
 const ref={planId:s.plan_id,revision:s.plan_revision,slotId},c=await currentStandingConfiguration(ctx,s.owner_user_id,ref);if(!c)return;
 const slot=(await ctx.db.query<typeof s>('SELECT * FROM social_standing_slots WHERE workspace_id=$1 AND id=$2 FOR UPDATE',[ctx.scope.workspaceId,slotId])).rows[0];if(!slot||slot.state!=='preparing')return;
 if(!slot.generation_request_id){
  const formats=['story','opinion','technical','college'] as const,weekIndex=Math.floor(new Date(slot.local_week).getTime()/604800000),founderFormat=formats[(weekIndex*3+slot.ordinal-1)%formats.length]!;
  const selection:SocialDraftRequest={mode:'linkedin_founder',sourceRefs:[],factBlocks:[],founderInputRefs:slot.input_refs,founderFormat,founderInputProcessingScope:'bedrock_haiku_founder_inputs_v1',...(c.guideRef?{voiceGuideRef:c.guideRef,voiceGuideProcessingScope:'bedrock_haiku_private_draft_v1' as const}:{})};
  const result=await admitGeneration(ctx,s.owner_user_id,ref,selection,new Date(Date.now()+1800000));if(!result.ok)await hold(ctx,slotId,result.reason);return;
 }
 const r=(await ctx.db.query<SocialDraftRow>('SELECT * FROM social_draft_requests WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[ctx.scope.workspaceId,slot.generation_request_id,s.owner_user_id])).rows[0];if(!r)return;
 if(r.state==='queued'||r.state==='calling')return;
 const source=await readSocialDraftSourcesForWorker(ctx,s.owner_user_id,r.source_selection);
 if(r.state!=='ready'||!source.ok||source.value.hash!==r.source_hash||r.deadline_at.getTime()<=Date.now()){await hold(ctx,slotId,'source_changed_or_generation_unavailable');return;}
 const text=r.concepts?.[0]?.variants.find(v=>v.platform==='linkedin')?.text;if(!text){await hold(ctx,slotId,'no_material');return;}
 await ctx.db.query("UPDATE social_standing_slots SET state='queued',text=$3,revision=revision+1 WHERE workspace_id=$1 AND id=$2 AND state='preparing'",[ctx.scope.workspaceId,slotId,text]);
}
async function hold(ctx:RepositoryContext,slotId:string,reason:string):Promise<void>{await ctx.db.query("UPDATE social_standing_slots SET state='held',reason=$3,text=NULL WHERE workspace_id=$1 AND id=$2 AND submission_marked_at IS NULL",[ctx.scope.workspaceId,slotId,reason]);}
