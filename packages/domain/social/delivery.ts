import {randomUUID} from 'node:crypto';
import {socialMediaBindingSchema,type SocialMediaBinding,type PostRevision} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {lockSocialPost,readSocialPost,socialApprovalSnapshot,type SocialResult} from './posts.ts';
export interface SocialInspection{state:'scheduled'|'published'|'cancelled'|'absent'|'unknown';receiptId:string|null;permalink:string|null;observedAt:string;accountExternalId:string|null;observedFingerprint:string|null;complete:boolean;mediaBinding?:SocialMediaBinding|null|undefined}
type Delivery={receipt_id:string|null;media_binding:SocialMediaBinding|null;id:string;post_id:string;revision:number;state:string;claim_id:string|null;device_id:string|null;claim_expires_at:Date|string|null;submission_id:string|null;approval_id:string;fingerprint:string;snapshot:{account:{externalId:string;platform:string};publishAt:string;images:{sha256:string}[]};observed_at:Date|string|null;inspection_deadline:Date|string|null;inspection_attempts:number};
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
async function deviceAllowed(ctx:RepositoryContext,id:string){return (await ctx.db.query("SELECT 1 FROM devices WHERE workspace_id=$1 AND id=$2 AND user_id=$3 AND status='active'",[ctx.scope.workspaceId,id,owner(ctx)])).rows.length===1;}
async function row(ctx:RepositoryContext,where:'post_id'|'claim_id'|'submission_id',id:string):Promise<Delivery|null>{return (await ctx.db.query<Delivery>(`SELECT d.*,a.fingerprint,a.snapshot FROM social_deliveries d JOIN social_posts p ON p.workspace_id=d.workspace_id AND p.id=d.post_id JOIN social_post_approvals a ON a.workspace_id=d.workspace_id AND a.id=d.approval_id WHERE d.workspace_id=$1 AND d.${where}=$2 AND p.owner_user_id=$3 ORDER BY d.revision DESC LIMIT 1`,[ctx.scope.workspaceId,id,owner(ctx)])).rows[0]??null;}
export async function claimSocialDelivery(ctx:RepositoryContext,input:{deviceId:string;postId:string;expectedRevision:number}):Promise<SocialResult<{claimId:string;approvalId:string;fingerprint:string;expiresAt:string}>>{
 if(!await deviceAllowed(ctx,input.deviceId))return {ok:false,reason:'device_invalid'};const rev=await lockSocialPost(ctx,input.postId);if(rev===null)return {ok:false,reason:'not_found'};if(rev!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const d=await row(ctx,'post_id',input.postId);if(!d||d.revision!==rev)return {ok:false,reason:'approval_required'};
 if(d.submission_id!==null||['submitting','scheduled','unknown','cancellation_pending','published'].includes(d.state))return {ok:false,reason:'inspect_existing_submission'};
 if(!['pending','preparing'].includes(d.state))return {ok:false,reason:'delivery_not_pending'};
 if(d.state==='preparing'&&d.claim_expires_at!==null&&Date.parse(String(d.claim_expires_at))>Date.now())return {ok:false,reason:'delivery_busy'};
 const post=(await readSocialPost(ctx,input.postId))!,current=await socialApprovalSnapshot(ctx,post);
 if(!current.ok||current.value.fingerprint!==d.fingerprint){const reason=current.ok?'approval_changed':current.reason;await setState(ctx,d,'failed',reason);return {ok:false,reason};}
 const claimId=randomUUID(),expiresAt=new Date(Date.now()+300_000).toISOString();
 await ctx.db.query("UPDATE social_deliveries SET state='preparing',claim_id=$3,device_id=$4,claim_expires_at=$5 WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,d.id,claimId,input.deviceId,expiresAt]);return {ok:true,value:{claimId,approvalId:d.approval_id,fingerprint:d.fingerprint,expiresAt}};
}
export async function beginSocialSubmission(ctx:RepositoryContext,input:{deviceId:string;claimId:string;approvalId:string;fingerprint:string}):Promise<SocialResult<{submissionId:string}>>{
 if(!await deviceAllowed(ctx,input.deviceId))return {ok:false,reason:'device_invalid'};const before=await row(ctx,'claim_id',input.claimId);if(!before)return {ok:false,reason:'claim_invalid'};
 const rev=await lockSocialPost(ctx,before.post_id);const d=await row(ctx,'claim_id',input.claimId);
 if(!d||d.revision!==rev||d.state!=='preparing'||d.device_id!==input.deviceId||d.approval_id!==input.approvalId||d.fingerprint!==input.fingerprint||d.claim_expires_at===null||new Date(d.claim_expires_at).getTime()<=Date.now())return {ok:false,reason:'claim_invalid'};
 const post=(await readSocialPost(ctx,d.post_id))!;if(post.state!=='approved')return {ok:false,reason:'claim_invalid'};
 const current=await socialApprovalSnapshot(ctx,post);if(!current.ok||current.value.fingerprint!==d.fingerprint){const reason=current.ok?'approval_changed':current.reason;await setState(ctx,d,'failed',reason);return {ok:false,reason};}
 const id=randomUUID();await ctx.db.query("UPDATE social_deliveries SET state='submitting',submission_id=$3,submitted_at=now(),inspection_deadline=now()+interval '24 hours',next_inspection_at=now() WHERE workspace_id=$1 AND id=$2",[ctx.scope.workspaceId,d.id,id]);await ctx.db.query("UPDATE social_post_revisions SET state='submitting' WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,d.post_id,d.revision]);return {ok:true,value:{submissionId:id}};
}
async function setState(ctx:RepositoryContext,d:Delivery,state:PostRevision['state'],reason:string|null){await ctx.db.query('UPDATE social_deliveries SET state=$3,reason=$4 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,d.id,state,reason]);await ctx.db.query('UPDATE social_post_revisions SET state=$4,reason=$5 WHERE workspace_id=$1 AND post_id=$2 AND revision=$3',[ctx.scope.workspaceId,d.post_id,d.revision,state,reason]);}
export async function recordSocialObservation(ctx:RepositoryContext,input:{deviceId:string;submissionId:string;observation:SocialInspection}):Promise<SocialResult<PostRevision>>{
 if(!await deviceAllowed(ctx,input.deviceId))return {ok:false,reason:'device_invalid'};const before=await row(ctx,'submission_id',input.submissionId);if(!before)return {ok:false,reason:'not_found'};await lockSocialPost(ctx,before.post_id);const d=(await row(ctx,'submission_id',input.submissionId))!;
 if(d.device_id!==input.deviceId)return {ok:false,reason:'wrong_device'};
 const o=input.observation,at=Date.parse(o.observedAt);if(!Number.isFinite(at)||at>Date.now()+300_000)return {ok:false,reason:'invalid_observation'};if(d.observed_at!==null&&at<new Date(d.observed_at).getTime())return {ok:false,reason:'stale_observation'};
 if(d.state==='published')return {ok:true,value:(await readSocialPost(ctx,d.post_id))!};
 const matched=o.accountExternalId===d.snapshot.account.externalId&&o.observedFingerprint===d.fingerprint&&o.complete;
 // The first complete schedule establishes the mapping; later reads cannot replace it.
 if(matched&&d.receipt_id!==null&&o.receiptId!==null&&o.receiptId!==d.receipt_id)return {ok:false,reason:'receipt_conflict'};
 let binding:SocialMediaBinding|null=null;
 if(o.mediaBinding!=null){
  const parsed=socialMediaBindingSchema.safeParse(o.mediaBinding);
  if(!parsed.success||!matched||parsed.data.receiptId!==o.receiptId||parsed.data.fingerprint!==d.fingerprint||parsed.data.images.length!==d.snapshot.images.length||parsed.data.images.some((image,index)=>image.sha256!==d.snapshot.images[index]?.sha256))return {ok:false,reason:'invalid_media_binding'};
  binding=parsed.data;
  if(d.media_binding!==null){
   const old=socialMediaBindingSchema.safeParse(d.media_binding);
   if(!old.success||JSON.stringify(old.data)!==JSON.stringify(binding))return {ok:false,reason:'media_binding_conflict'};
  }else if(o.state!=='scheduled')return {ok:false,reason:'invalid_media_binding'};
 }
 if(binding)await ctx.db.query('UPDATE social_deliveries SET media_binding=COALESCE(media_binding,$3::jsonb) WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,d.id,JSON.stringify(binding)]);
 let state:PostRevision['state']='unknown',reason:string|null='inspection_incomplete';
 if(matched){
  if(o.state==='published'){state='published';reason=null;}
  else if(o.state==='scheduled'){state=d.state==='cancellation_pending'?'cancellation_pending':'scheduled';reason=null;}
  else if(o.state==='cancelled'||o.state==='absent'){state=d.state==='cancellation_pending'||o.state==='cancelled'?'cancelled':'failed';reason=state==='failed'?'not_found_on_platform':null;}
 }
 // A pending cancel stays visible even while a readback is inconclusive.
 if(state==='unknown'&&d.state==='cancellation_pending')state='cancellation_pending';
 let permalink:string|null=null;if(o.permalink!==null&&state==='published'){try{const url=new URL(o.permalink);const hosts=d.snapshot.account.platform==='linkedin'?['www.linkedin.com','linkedin.com']:d.snapshot.account.platform==='facebook'?['www.facebook.com','facebook.com']:['x.com','www.x.com'];if(url.protocol==='https:'&&!url.username&&!url.password&&hosts.includes(url.hostname))permalink=url.toString();}catch{/* Unverified link is not shown. */}}
 await setState(ctx,d,state,reason);
 const delay=Math.min(3600_000,60_000*2**Math.min(6,d.inspection_attempts));
 let deadline=d.inspection_deadline===null?0:new Date(d.inspection_deadline).getTime();let next=['published','cancelled','failed'].includes(state)||Date.now()+delay>deadline?null:new Date(Date.now()+delay).toISOString();
 if(state==='scheduled'&&matched){const publication=Date.parse(d.snapshot.publishAt);if(publication>Date.now()){next=new Date(publication+60_000).toISOString();deadline=publication+86400_000;}}
 await ctx.db.query('UPDATE social_deliveries SET inspection_deadline=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,d.id,new Date(deadline).toISOString()]);
 await ctx.db.query('UPDATE social_deliveries SET receipt_id=COALESCE($3,receipt_id),permalink=COALESCE($4,permalink),observed_at=$5,inspection_attempts=inspection_attempts+1,next_inspection_at=$6 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,d.id,matched?o.receiptId:null,permalink,o.observedAt,next]);
 return {ok:true,value:(await readSocialPost(ctx,d.post_id))!};
}
