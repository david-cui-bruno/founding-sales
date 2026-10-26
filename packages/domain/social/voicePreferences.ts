import {socialVoiceSaveInputSchema,socialVoiceGuideSchema,type SocialVoiceSaveInput,type SocialVoiceGuide,type SocialVoicePreference} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {recordCrmAuditEvent} from '../crm/audit.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
import {invalidatePrivateVoiceOutputs} from './voiceGeneration.ts';
interface Row extends Record<string,unknown>{id:string;revision:number;entries:SocialVoicePreference[]|null;removed_at:Date|null;created_at:Date;updated_at:Date}
const owner=(ctx:RepositoryContext)=>ctx.scope.actor.kind==='user'?ctx.scope.actor.userId:null;
/** Exclusive parent lock serializes absence as well as lifecycle before guide locks. */
async function membership(ctx:RepositoryContext):Promise<boolean>{return owner(ctx)!==null&&(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR UPDATE",[ctx.scope.workspaceId,owner(ctx)])).rows.length===1;}
async function row(ctx:RepositoryContext):Promise<Row|null>{return (await ctx.db.query<Row>('SELECT * FROM social_voice_preferences WHERE workspace_id=$1 AND owner_user_id=$2 FOR UPDATE',[ctx.scope.workspaceId,owner(ctx)])).rows[0]??null;}
export async function readSocialVoicePreferences(ctx:RepositoryContext,authority:PrivateDraftAuthority):Promise<SocialVoiceGuide|null>{
 if(!await membership(ctx)){await requirePrivateDraftAuthority(authority);return null;}
 const current=await row(ctx);await requirePrivateDraftAuthority(authority);
 if(!current)return {state:'absent'};
 const metadata={guideId:current.id,revision:current.revision,createdAt:current.created_at.toISOString(),updatedAt:current.updated_at.toISOString()};
 return socialVoiceGuideSchema.parse(current.entries===null?{state:'removed',...metadata,removedAt:current.removed_at!.toISOString()}:{state:'available',...metadata,entries:current.entries});
}
export async function saveSocialVoicePreferences(ctx:RepositoryContext,raw:SocialVoiceSaveInput,authority:PrivateDraftAuthority):Promise<SocialResult<{guideId:string;revision:number}>>{
 const parsed=socialVoiceSaveInputSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 if(!await membership(ctx)){await requirePrivateDraftAuthority(authority);return {ok:false,reason:'owner_unavailable'};}
 const input=parsed.data,current=await row(ctx);
 await requirePrivateDraftAuthority(authority);
 if(input.operation==='create'&&current)return {ok:false,reason:'already_exists'};
 if(input.operation!=='create'){
  if(!current||current.id!==input.guideId)return {ok:false,reason:'not_found'};
  if(current.revision!==input.expectedRevision)return {ok:false,reason:'stale_revision'};
  if(input.operation==='restart'?current.entries!==null:current.entries===null)return {ok:false,reason:input.operation==='restart'?'not_removed':'removed'};
 }
 const result=input.operation==='create'
  ?(await ctx.db.query<Row>('INSERT INTO social_voice_preferences(workspace_id,owner_user_id,entries) VALUES($1,$2,$3::jsonb) RETURNING *',[ctx.scope.workspaceId,owner(ctx),JSON.stringify(input.entries)])).rows[0]!
  :(await ctx.db.query<Row>('UPDATE social_voice_preferences SET entries=$3::jsonb,removed_at=CASE WHEN $3::jsonb IS NULL THEN clock_timestamp() ELSE NULL END,revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 RETURNING *',[ctx.scope.workspaceId,owner(ctx),input.operation==='remove'?null:JSON.stringify(input.entries)])).rows[0]!;
 await requirePrivateDraftAuthority(authority);
 if(current)await invalidatePrivateVoiceOutputs(ctx,owner(ctx)!,current.id);
 await recordCrmAuditEvent(ctx,{action:'social.voice_preferences_saved',subjectKind:'social_voice_preferences',subjectId:result.id,detail:{operation:input.operation,revision:result.revision}});
 return {ok:true,value:{guideId:result.id,revision:result.revision}};
}
