import {createHash} from 'node:crypto';
import {socialFounderInputSaveSchema,socialFounderInputViewSchema,type SocialFounderInputSave,type SocialFounderInputView} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
interface Row extends Record<string,unknown>{id:string;revision:number;bullets:string|null;context:string|null;experience_date:string|null;public_safe:boolean;reason:'removed'|'expired'|'owner_unavailable'|null;created_at:Date;expires_at:Date}
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
export async function lockFounderOwner(ctx:RepositoryContext,user:string):Promise<boolean>{return (await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",[ctx.scope.workspaceId,user])).rows.length===1;}
async function current(ctx:RepositoryContext,user:string,id:string):Promise<Row|null>{
 let row=(await ctx.db.query<Row>('SELECT * FROM social_founder_inputs WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR UPDATE',[ctx.scope.workspaceId,user,id])).rows[0]??null;
 if(row&&!row.reason){const expired=(await ctx.db.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS expired',[row.expires_at])).rows[0]!.expired;if(expired)row=(await ctx.db.query<Row>("UPDATE social_founder_inputs SET bullets=NULL,context=NULL,experience_date=NULL,public_safe=false,reason='expired',revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 RETURNING *",[ctx.scope.workspaceId,user,id])).rows[0]!;}
 return row;
}
function view(row:Row):SocialFounderInputView{return socialFounderInputViewSchema.parse({inputId:row.id,revision:row.revision,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString(),...(row.reason?{state:'unavailable',reason:row.reason}:{state:'available',bullets:row.bullets,context:row.context,experienceDate:row.experience_date,publicSafe:row.public_safe})});}
export async function saveSocialFounderInput(ctx:RepositoryContext,raw:SocialFounderInputSave,authority:PrivateDraftAuthority):Promise<SocialResult<{inputId:string;revision:number}>>{
 const parsed=socialFounderInputSaveSchema.safeParse(raw),user=owner(ctx);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 if(!user||!await lockFounderOwner(ctx,user))return {ok:false,reason:'owner_unavailable'};
 const input=parsed.data;let row=input.operation==='create'?null:await current(ctx,user,input.inputId);await requirePrivateDraftAuthority(authority);
 if(input.operation!=='create')row=await current(ctx,user,input.inputId);
 if(input.operation!=='create'){if(!row)return {ok:false,reason:'not_found'};if(row.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};if(row.reason)return {ok:false,reason:row.reason};}
 const result=input.operation==='create'?(await ctx.db.query<Row>('INSERT INTO social_founder_inputs(workspace_id,owner_user_id,bullets,context,experience_date,public_safe) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',[ctx.scope.workspaceId,user,input.bullets,input.context,input.experienceDate,input.publicSafe])).rows[0]!
 :(await ctx.db.query<Row>("UPDATE social_founder_inputs SET bullets=$4,context=$5,experience_date=$6,public_safe=$7,reason=$8,revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 RETURNING *",[ctx.scope.workspaceId,user,row!.id,input.operation==='remove'?null:input.bullets,input.operation==='remove'?null:input.context,input.operation==='remove'?null:input.experienceDate,input.operation==='remove'?false:input.publicSafe,input.operation==='remove'?'removed':null])).rows[0]!;
 await requirePrivateDraftAuthority(authority);
 const final=await current(ctx,user,result.id);if(!final||final.reason&&input.operation!=='remove')return {ok:false,reason:final?.reason??'not_found'};
 return {ok:true,value:{inputId:final.id,revision:final.revision}};
}
export async function readSocialFounderInput(ctx:RepositoryContext,id:string,authority:PrivateDraftAuthority):Promise<SocialFounderInputView|null>{const user=owner(ctx);if(!user||!await lockFounderOwner(ctx,user))return null;await current(ctx,user,id);await requirePrivateDraftAuthority(authority);const row=await current(ctx,user,id);return row?view(row):null;}
export async function listSocialFounderInputs(ctx:RepositoryContext,afterId:string|undefined,authority:PrivateDraftAuthority){
 const user=owner(ctx);if(!user||!await lockFounderOwner(ctx,user))return {inputs:[],nextAfterId:null};
 const rows=(await ctx.db.query<{id:string}>('SELECT id FROM social_founder_inputs WHERE workspace_id=$1 AND owner_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21',[ctx.scope.workspaceId,user,afterId??null])).rows;
 for(const item of rows.slice(0,20))await current(ctx,user,item.id);
 await requirePrivateDraftAuthority(authority);
 const inputs:SocialFounderInputView[]=[];for(const item of rows.slice(0,20)){const row=await current(ctx,user,item.id);if(row)inputs.push(view(row));}
 return {inputs,nextAfterId:rows.length>20?inputs.at(-1)!.inputId:null};
}
/** Only server-owned owner bindings; no synthesized user actor. All callers retain locks through their transaction. */
export async function readSocialFounderInputsForOwner(ctx:RepositoryContext,user:string,refs:readonly {inputId:string;revision:number}[]):Promise<SocialResult<{notes:{bullets:string;context:string;experienceDate:string|null}[];hashes:string[];expiresAt:Date}>>{
 const actor=ctx.scope.actor;if(actor.kind==='user'?actor.userId!==user:!['worker','scheduler'].includes(actor.component))return {ok:false,reason:'owner_unavailable'};
 if(!refs.length||new Set(refs.map(r=>r.inputId)).size!==refs.length||!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[ctx.scope.workspaceId,user])).rows.length)return {ok:false,reason:'source_changed_or_unavailable'};
 const notes:{bullets:string;context:string;experienceDate:string|null}[]=[],hashes:string[]=[];let expiresAt:Date|null=null;
 for(const ref of [...refs].sort((a,b)=>a.inputId.localeCompare(b.inputId))){const row=(await ctx.db.query<Row>('SELECT * FROM social_founder_inputs WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE',[ctx.scope.workspaceId,user,ref.inputId])).rows[0];if(!row||row.reason||!row.public_safe||row.revision!==ref.revision)return {ok:false,reason:'source_changed_or_unavailable'};const note={bullets:row.bullets!,context:row.context!,experienceDate:row.experience_date};notes.push(note);hashes.push(createHash('sha256').update(JSON.stringify([ref,note,row.expires_at.toISOString()])).digest('hex'));if(!expiresAt||row.expires_at<expiresAt)expiresAt=row.expires_at;}
 if((await ctx.db.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS expired',[expiresAt])).rows[0]!.expired)return {ok:false,reason:'source_changed_or_unavailable'};
 return {ok:true,value:{notes,hashes,expiresAt:expiresAt!}};
}
/** Existing retention owner calls this even when generation is disabled. */
export async function sweepSocialFounderInputs(ctx:RepositoryContext,limit:number):Promise<number>{
 const rows=(await ctx.db.query<{owner_user_id:string;id:string}>('SELECT owner_user_id,id FROM social_founder_inputs WHERE workspace_id=$1 AND reason IS NULL AND expires_at<=clock_timestamp() ORDER BY owner_user_id,id LIMIT $2',[ctx.scope.workspaceId,limit])).rows;
 let count=0;
 for(const row of rows){
  await ctx.db.query('SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,row.owner_user_id]);
  const result=await ctx.db.query("UPDATE social_founder_inputs SET bullets=NULL,context=NULL,experience_date=NULL,public_safe=false,reason='expired',revision=revision+1 WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 AND reason IS NULL AND expires_at<=clock_timestamp()",[ctx.scope.workspaceId,row.owner_user_id,row.id]);count+=result.rowCount??0;
 }
 return count;
}
