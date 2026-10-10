import {inspectXPostText} from './xText.ts';
import {createHash,randomUUID} from 'node:crypto';
import {saveSocialPostSchema,type SaveSocialPost,type PostRevision,type SocialWorkspace} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {socialAssetObject} from './assets.ts';
export type SocialResult<T>={ok:true;value:T}|{ok:false;reason:string};
export type SocialAccount={id:string;platform:'linkedin'|'facebook'|'x';external_id:string;display_name:string;account_kind:'profile'|'page';state:string;revision:number;adapter_version:string|null;verified_at:Date|string|null;max_schedule_days:number|null};
type Row={post_id:string;revision:number;account_id:string;text:string;images:PostRevision['images'];publish_at:Date|string|null;zone:string;state:PostRevision['state'];reason:string|null};
const owner=(c:RepositoryContext)=>c.scope.actor.kind==='user'?c.scope.actor.userId:null;
export async function lockSocialPost(ctx:RepositoryContext,id:string):Promise<number|null>{if(!owner(ctx))return null;return (await ctx.db.query<{current_revision:number}>('SELECT current_revision FROM social_posts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR UPDATE',[ctx.scope.workspaceId,id,owner(ctx)])).rows[0]?.current_revision??null;}
export async function readSocialAccount(ctx:RepositoryContext,id:string):Promise<SocialAccount|null>{return (await ctx.db.query<SocialAccount>('SELECT * FROM social_accounts WHERE workspace_id=$1 AND id=$2 AND owner_user_id=$3 FOR SHARE',[ctx.scope.workspaceId,id,owner(ctx)])).rows[0]??null;}
export async function readSocialPost(ctx:RepositoryContext,id:string):Promise<PostRevision|null>{const r=(await ctx.db.query<Row>('SELECT v.* FROM social_posts p JOIN social_post_revisions v ON v.workspace_id=p.workspace_id AND v.post_id=p.id AND v.revision=p.current_revision WHERE p.workspace_id=$1 AND p.id=$2 AND p.owner_user_id=$3',[ctx.scope.workspaceId,id,owner(ctx)])).rows[0];return r?{postId:r.post_id,revision:r.revision,accountId:r.account_id,text:r.text,images:r.images,publishAt:r.publish_at===null?null:new Date(r.publish_at).toISOString(),zone:r.zone,state:r.state,reason:r.reason}:null;}
export async function saveSocialPost(ctx:RepositoryContext,raw:SaveSocialPost):Promise<SocialResult<PostRevision>>{
 const user=owner(ctx);if(!user)return {ok:false,reason:'user_required'};const parsed=saveSocialPostSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data;const account=await readSocialAccount(ctx,input.accountId);if(!account)return {ok:false,reason:'account_not_found'};
 let id=input.postId,revision=1;
 if(id){const current=await lockSocialPost(ctx,id);if(current===null)return {ok:false,reason:'not_found'};if(current!==input.expectedRevision)return {ok:false,reason:'stale_revision'};const post=await readSocialPost(ctx,id);if(!post)return {ok:false,reason:'not_found'};if(post.state==='published')return {ok:false,reason:'create_new_post'};if(['submitting','scheduled','unknown','cancellation_pending'].includes(post.state))return {ok:false,reason:'cancel_before_edit'};revision=current+1;
 await ctx.db.query("UPDATE social_deliveries SET state='cancelled',reason='revision_changed' WHERE workspace_id=$1 AND post_id=$2 AND revision=$3 AND state IN ('pending','preparing')",[ctx.scope.workspaceId,id,current]);
 await ctx.db.query('UPDATE social_posts SET current_revision=$3 WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,id,revision]);
 }else{id=randomUUID();await ctx.db.query('INSERT INTO social_posts(workspace_id,id,owner_user_id) VALUES($1,$2,$3)',[ctx.scope.workspaceId,id,user]);}
 await ctx.db.query('INSERT INTO social_post_revisions(workspace_id,post_id,revision,account_id,text,images,publish_at,zone) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8)',[ctx.scope.workspaceId,id,revision,input.accountId,input.text,JSON.stringify(input.images),input.publishAt,input.zone]);
 await recordCrmAuditEvent(ctx,{action:'social.post_saved',subjectKind:'social_post',subjectId:id,detail:{revision}});return {ok:true,value:(await readSocialPost(ctx,id))!};
}
export async function socialApprovalSnapshot(ctx:RepositoryContext,post:PostRevision):Promise<SocialResult<{account:SocialAccount;fingerprint:string;snapshot:Record<string,unknown>}>>{
 const account=await readSocialAccount(ctx,post.accountId);if(!account)return {ok:false,reason:'account_not_found'};
 if(account.platform==='facebook'&&account.account_kind!=='page')return {ok:false,reason:'facebook_page_required'};
 if(account.state!=='connected'||!account.adapter_version||!account.verified_at||!account.max_schedule_days)return {ok:false,reason:'destination_unverified'};
 const now=Date.now(),at=post.publishAt===null?NaN:Date.parse(post.publishAt);if(!Number.isFinite(at))return {ok:false,reason:'schedule_required'};if(at<=now)return {ok:false,reason:'schedule_in_past'};if(at>now+account.max_schedule_days*86400_000)return {ok:false,reason:'schedule_out_of_range'};
 const textLimit=account.platform==='x'?280:account.platform==='linkedin'?3000:10000;
 // Official X weighted validation does not replace destination/submission authority.
 if((account.platform==='x'?!inspectXPostText(post.text).valid:[...post.text].length>textLimit)||post.images.length>(account.platform==='x'?4:account.platform==='linkedin'?1:10))return {ok:false,reason:'content_needs_edit'};
 const images:Record<string,unknown>[]=[];const seen=new Set<string>();
 for(const image of post.images){const key=`${image.assetId}:${image.version}`;if(seen.has(key))return {ok:false,reason:'duplicate_image'};seen.add(key);const object=await socialAssetObject(ctx,{assetId:image.assetId,version:image.version},'download');if(!object||object.kind!=='derivative')return {ok:false,reason:'image_unavailable'};images.push({...image,sha256:object.sha256,mime:object.mime,width:object.width,height:object.height});}
 const snapshot={account:{id:account.id,platform:account.platform,externalId:account.external_id,revision:account.revision,adapterVersion:account.adapter_version},text:post.text,images,publishAt:new Date(at).toISOString(),zone:post.zone};
 return {ok:true,value:{account,snapshot,fingerprint:createHash('sha256').update(JSON.stringify(snapshot)).digest('hex')}};
}
export async function approveSocialPost(ctx:RepositoryContext,input:{postId:string;expectedRevision:number}):Promise<SocialResult<{approvalId:string;fingerprint:string}>>{
 const current=await lockSocialPost(ctx,input.postId);if(current===null)return {ok:false,reason:'not_found'};if(current!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
 const post=(await readSocialPost(ctx,input.postId))!;if(!['draft','approved'].includes(post.state))return {ok:false,reason:'post_not_draft'};
 const checked=await socialApprovalSnapshot(ctx,post);if(!checked.ok)return checked;
 const old=(await ctx.db.query<{id:string;fingerprint:string}>('SELECT id,fingerprint FROM social_post_approvals WHERE workspace_id=$1 AND post_id=$2 AND revision=$3',[ctx.scope.workspaceId,input.postId,current])).rows[0];
 if(old)return old.fingerprint===checked.value.fingerprint?{ok:true,value:{approvalId:old.id,fingerprint:old.fingerprint}}:{ok:false,reason:'approval_changed'};
 const id=randomUUID();await ctx.db.query('INSERT INTO social_post_approvals(workspace_id,id,post_id,revision,account_revision,fingerprint,snapshot,approved_by) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)',[ctx.scope.workspaceId,id,input.postId,current,checked.value.account.revision,checked.value.fingerprint,JSON.stringify(checked.value.snapshot),owner(ctx)]);
 await ctx.db.query('INSERT INTO social_deliveries(workspace_id,post_id,revision,approval_id) VALUES($1,$2,$3,$4)',[ctx.scope.workspaceId,input.postId,current,id]);
 await ctx.db.query("UPDATE social_post_revisions SET state='approved' WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,input.postId,current]);
 await recordCrmAuditEvent(ctx,{action:'social.post_approved',subjectKind:'social_post',subjectId:input.postId,detail:{revision:current}});return {ok:true,value:{approvalId:id,fingerprint:checked.value.fingerprint}};
}
export async function requestSocialCancellation(ctx:RepositoryContext,input:{postId:string;expectedRevision:number}):Promise<SocialResult<PostRevision>>{
 const current=await lockSocialPost(ctx,input.postId);if(current===null)return {ok:false,reason:'not_found'};if(current!==input.expectedRevision)return {ok:false,reason:'stale_revision'};const post=(await readSocialPost(ctx,input.postId))!;
 if(post.state==='published')return {ok:false,reason:'already_published'};const state=['submitting','scheduled','unknown','cancellation_pending'].includes(post.state)?'cancellation_pending':'cancelled';
 await ctx.db.query('UPDATE social_post_revisions SET state=$4 WHERE workspace_id=$1 AND post_id=$2 AND revision=$3',[ctx.scope.workspaceId,input.postId,current,state]);await ctx.db.query("UPDATE social_deliveries SET state=$4,next_inspection_at=CASE WHEN $4='cancellation_pending' AND state<>'cancellation_pending' THEN now() ELSE next_inspection_at END,inspection_deadline=CASE WHEN $4='cancellation_pending' AND state<>'cancellation_pending' THEN now()+interval '24 hours' ELSE inspection_deadline END WHERE workspace_id=$1 AND post_id=$2 AND revision=$3",[ctx.scope.workspaceId,input.postId,current,state]);
 await recordCrmAuditEvent(ctx,{action:'social.post_cancellation_requested',subjectKind:'social_post',subjectId:input.postId,detail:{revision:current,state}});return {ok:true,value:(await readSocialPost(ctx,input.postId))!};
}
export async function readSocialWorkspace(ctx:RepositoryContext,afterId?:string):Promise<SocialWorkspace>{
 const accounts=(await ctx.db.query<SocialAccount>('SELECT * FROM social_accounts WHERE workspace_id=$1 AND owner_user_id=$2 ORDER BY platform,id LIMIT 30',[ctx.scope.workspaceId,owner(ctx)])).rows.map(a=>({id:a.id,platform:a.platform,externalId:a.external_id,displayName:a.display_name,accountKind:a.account_kind,state:a.state as 'connected'|'reconnect'|'unsupported'|'disconnected',adapterVersion:a.adapter_version,verifiedAt:a.verified_at===null?null:new Date(a.verified_at).toISOString()}));
 const rows=(await ctx.db.query<{id:string}>('SELECT id FROM social_posts WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 50',[ctx.scope.workspaceId,owner(ctx),afterId??null])).rows;const posts:PostRevision[]=[];for(const r of rows){const p=await readSocialPost(ctx,r.id);if(p)posts.push(p);}return {accounts,posts};
}
