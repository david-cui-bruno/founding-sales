import {socialCalibrationFinishSchema,socialCalibrationResultSchema,type SocialCalibrationFinish,type SocialCalibrationResult} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import type {SocialResult} from './posts.ts';
import {readSocialPrivateDraft,requirePrivateDraftAuthority,type PrivateDraftAuthority} from './privateDrafts.ts';
import {readSocialVoicePreferences,saveSocialVoicePreferences} from './voicePreferences.ts';
import {lockFounderOwner} from './founderInputs.ts';
import type {SocialDraftRequest} from '@fss/contracts';
import {privateSourceBasis} from './privateDraftSources.ts';
interface Completion extends Record<string,unknown>{id:string;completed_at:Date;guide_ref:{guideId:string;revision:number}|null}
export async function readSocialCalibration(ctx:RepositoryContext,authority:PrivateDraftAuthority){
 if(ctx.scope.actor.kind!=='user'||!await lockFounderOwner(ctx,ctx.scope.actor.userId))return {completion:null};
 const row=(await ctx.db.query<Completion>('SELECT id,completed_at,guide_ref FROM social_founder_calibrations WHERE workspace_id=$1 AND owner_user_id=$2',[ctx.scope.workspaceId,ctx.scope.actor.userId])).rows[0];await requirePrivateDraftAuthority(authority);
 return {completion:row?socialCalibrationResultSchema.parse({calibrationId:row.id,completedAt:row.completed_at.toISOString(),guideRef:row.guide_ref}):null};
}
/** Caller transaction makes validation, optional guide erasure and opaque acceptance atomic. */
export async function finishSocialCalibration(ctx:RepositoryContext,raw:SocialCalibrationFinish,authority:PrivateDraftAuthority):Promise<SocialResult<SocialCalibrationResult>>{
 const parsed=socialCalibrationFinishSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 if(ctx.scope.actor.kind!=='user'||!await lockFounderOwner(ctx,ctx.scope.actor.userId))return {ok:false,reason:'owner_unavailable'};
 const user=ctx.scope.actor.userId,input=parsed.data;
 const previous=await readSocialCalibration(ctx,authority);if(previous.completion)return {ok:false,reason:'already_completed'};
 const guide=await readSocialVoicePreferences(ctx,authority),guideRef=guide?.state==='available'?{guideId:guide.guideId,revision:guide.revision}:null;
 if(JSON.stringify(guideRef)!==JSON.stringify(input.expectedGuide))return {ok:false,reason:'guide_changed'};
 // Lock every immutable source before private rows, in deterministic order.
 const ids=[...input.examples].sort((a,b)=>a.draftId.localeCompare(b.draftId));
 const selections=(await ctx.db.query<{id:string;source_selection:SocialDraftRequest|null}>('SELECT id,source_selection FROM social_private_drafts WHERE workspace_id=$1 AND owner_user_id=$2 AND id=ANY($3::uuid[]) ORDER BY id',[ctx.scope.workspaceId,user,ids.map(e=>e.draftId)])).rows;
 if(selections.length!==3)return {ok:false,reason:'examples_changed_or_unavailable'};
 for(const selection of selections){if(!selection.source_selection)return {ok:false,reason:'examples_changed_or_unavailable'};const basis=await privateSourceBasis(ctx,selection.source_selection);if(!basis.ok)return basis;}
 let deadline:Date|null=null;
 const formats=new Set<string>(),requests=new Set<string>();
 for(const example of ids){
  const draft=await readSocialPrivateDraft(ctx,example.draftId,authority);
  const selection=selections.find(s=>s.id===example.draftId)?.source_selection;
  if(!draft||draft.availability!=='available'||draft.revision!==example.revision||draft.kind!=='post'||draft.origin.kind!=='suggestion'||selection?.mode!=='linkedin_founder'||!selection.founderFormat)return {ok:false,reason:'examples_changed_or_unavailable'};
  const expiry=new Date(draft.expiresAt);if(!deadline||expiry<deadline)deadline=expiry;
  formats.add(selection.founderFormat);requests.add(draft.origin.requestId);
 }
 if(formats.size!==3||requests.size!==3)return {ok:false,reason:'distinct_formats_and_requests_required'};
 await requirePrivateDraftAuthority(authority);
 let resultingGuide=guideRef;
 if(input.finalGuide){const saved=await saveSocialVoicePreferences(ctx,input.finalGuide,authority);if(!saved.ok)throw new CalibrationGuideConflict(saved.reason);resultingGuide=input.finalGuide.operation==='remove'?null:saved.value;}
 // Guide mutation above intentionally erased examples; do not reread/copy them.
 const row=(await ctx.db.query<Completion>('INSERT INTO social_founder_calibrations(workspace_id,owner_user_id,examples,guide_ref) VALUES($1,$2,$3::jsonb,$4::jsonb) RETURNING id,completed_at,guide_ref',[ctx.scope.workspaceId,user,JSON.stringify(input.examples),resultingGuide?JSON.stringify(resultingGuide):null])).rows[0]!;
 await requirePrivateDraftAuthority(authority);
 const expired=(await ctx.db.query<{expired:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS expired',[deadline])).rows[0]!.expired;
 if(expired)throw new CalibrationGuideConflict('examples_changed_or_unavailable');
 return {ok:true,value:socialCalibrationResultSchema.parse({calibrationId:row.id,completedAt:row.completed_at.toISOString(),guideRef:row.guide_ref})};
}
export class CalibrationGuideConflict extends Error{constructor(readonly reason:string){super('calibration_guide_conflict');}}
