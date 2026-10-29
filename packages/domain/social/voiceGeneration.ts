import {socialVoiceEntriesSchema,type SocialDraftRequest,type SocialVoicePreference,type SocialVoiceGuideProcessingScope} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';

/** Ephemeral style data, never command, receipt, request row or factual evidence. */
export interface PrivateVoiceGuide {
 guideId:string;
 revision:number;
 entries:SocialVoicePreference[];
}
export const PRIVATE_VOICE_GUIDE_VERSION='owner_curated_v1' as const;
export function socialVoicePortAllowed(selection:SocialDraftRequest,port:{readonly privateVoiceGuideVersion?:typeof PRIVATE_VOICE_GUIDE_VERSION;readonly privateVoiceGuideProcessingScope?:SocialVoiceGuideProcessingScope}):boolean {
 return selection.voiceGuideRef===undefined||(port.privateVoiceGuideVersion===PRIVATE_VOICE_GUIDE_VERSION
  &&(port.privateVoiceGuideProcessingScope===undefined||selection.voiceGuideProcessingScope===port.privateVoiceGuideProcessingScope));
}
export function exactPrivateVoiceGuide(ref:NonNullable<SocialDraftRequest['voiceGuideRef']>,row:{id:string;revision:number;entries:unknown;removed_at:Date|null}|undefined):PrivateVoiceGuide|null {
 if(!row||row.id!==ref.guideId||row.revision!==ref.revision||row.removed_at!==null)return null;
 const entries=socialVoiceEntriesSchema.safeParse(row.entries);
 return entries.success?{guideId:row.id,revision:row.revision,entries:entries.data}:null;
}
/** Same durable request owner, with no user impersonation. Membership is locked
 * before the guide and before request/private rows, including the absence case. */
export async function readPrivateVoiceGuide(ctx:RepositoryContext,ownerUserId:string,selection:SocialDraftRequest,authority?:PrivateDraftAuthority):Promise<SocialResult<PrivateVoiceGuide|null>> {
 if(!selection.voiceGuideRef)return {ok:true,value:null};
 const actor=ctx.scope.actor;
 if(selection.mode!=='linkedin_grounded'||(actor.kind==='user'?actor.userId!==ownerUserId:!['worker','scheduler'].includes(actor.component)))return {ok:false,reason:'voice_guide_unavailable'};
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin' FOR SHARE",[ctx.scope.workspaceId,ownerUserId])).rows.length===1;
 if(!active)return {ok:false,reason:'owner_unavailable'};
 // Request authority is checked after ownership/guide waits but before entries
 // are read. Retained device/session locks then protect admission through commit.
 if(authority){
  await ctx.db.query('SELECT id FROM social_voice_preferences WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE',[ctx.scope.workspaceId,ownerUserId,selection.voiceGuideRef.guideId]);
  await requirePrivateDraftAuthority(authority);
 }
 const row=(await ctx.db.query<{id:string;revision:number;entries:unknown;removed_at:Date|null}>('SELECT id,revision,entries,removed_at FROM social_voice_preferences WHERE workspace_id=$1 AND owner_user_id=$2 AND id=$3 FOR SHARE',[ctx.scope.workspaceId,ownerUserId,selection.voiceGuideRef.guideId])).rows[0];
 const guide=exactPrivateVoiceGuide(selection.voiceGuideRef,row);
 return guide?{ok:true,value:guide}:{ok:false,reason:'voice_guide_changed_or_unavailable'};
}
/** Called with membership/guide locks held. Opaque uncertainty and paid attempts
 * survive invalidation. Reservation settlement stays with its existing owner. */
export async function invalidatePrivateVoiceOutputs(ctx:RepositoryContext,ownerUserId:string,guideId:string):Promise<void> {
 await ctx.db.query("UPDATE social_draft_requests SET state=CASE WHEN state IN ('queued','calling','ready') THEN 'review' ELSE state END,concepts=NULL,reason='source_changed_or_unavailable',updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 AND source_selection->'voiceGuideRef'->>'guideId'=$3",[ctx.scope.workspaceId,ownerUserId,guideId]);
 await ctx.db.query("UPDATE social_private_drafts SET text=NULL,origin=NULL,source_selection=NULL,source_hash=NULL,dependencies='{}',reason='source_changed_or_unavailable',revision=revision+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND owner_user_id=$2 AND reason IS NULL AND source_selection->'voiceGuideRef'->>'guideId'=$3",[ctx.scope.workspaceId,ownerUserId,guideId]);
}
