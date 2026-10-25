import {createHash} from 'node:crypto';
import {socialDraftViewSchema,type SocialDraftRequest,type SocialPrivateDraftOrigin} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readSocialDraftSources} from './draftSources.ts';
import {readSocialDraftRequest} from './drafts.ts';
import {socialDraftView} from './draftWorkspace.ts';
import {readApprovedAnswerBlocks} from '../outreach/facts.ts';
import type {SocialResult} from './posts.ts';
export interface PrivateSourceBasis{selection:SocialDraftRequest;hash:string;dependencies:Record<string,string[]>;expiresAt:Date|null}
export async function privateSourceBasis(ctx:RepositoryContext,selection:SocialDraftRequest):Promise<SocialResult<PrivateSourceBasis>>{
 const current=await readSocialDraftSources(ctx,selection);if(!current.ok)return {ok:false,reason:'source_changed_or_unavailable'};
 const dependencies:Record<string,string[]>={};
 const add=(key:string,id:string):void=>{const values=dependencies[key]??=[];if(!values.includes(id))values.push(id);};
 const blocks=selection.factBlocks.length?await readApprovedAnswerBlocks(ctx,selection.factBlocks):{ok:true as const,value:[]};
 if(!blocks.ok)return {ok:false,reason:'source_changed_or_unavailable'};
 for(const block of blocks.value){add('outreach_answer_blocks',block.id);const ref=block.socialInput?.sourceRef;if(ref)add('sourcing_candidates',ref.id);}
 for(const ref of selection.sourceRefs){
  if(ref.kind==='public')add('sourcing_candidates',ref.id);
  if(ref.kind==='call'){
   add('call_sessions',ref.id);
   const row=(await ctx.db.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,ref.id])).rows[0];if(row)add('firms',row.firm_id);
  }
  if(ref.kind==='meeting'){
   add('meeting_transcripts',ref.id);
   const row=(await ctx.db.query<{recording_id:string;original_recording_id:string;meeting_id:string;firm_id:string}>(`SELECT t.recording_id,t.original_recording_id,r.meeting_id,m.firm_id FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id WHERE t.workspace_id=$1 AND t.id=$2`,[ctx.scope.workspaceId,ref.id])).rows[0];
   if(!row)return {ok:false,reason:'source_changed_or_unavailable'};
   add('meeting_recordings',row.recording_id);add('meeting_recordings',row.original_recording_id);add('meetings',row.meeting_id);add('firms',row.firm_id);
  }
 }
 // Existing source policy uses transaction time. News eligibility must additionally
 // survive midnight during a lock wait, using the actual fresh wallclock here.
 const now=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 const day=(value:Date)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(value);
 for(const block of blocks.value){const ref=block.socialInput?.sourceRef;if(!ref)continue;
  const row=(await ctx.db.query<{source_check:{lastSuccess?:{retrievedAt:string}}}>('SELECT source_check FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2',[ctx.scope.workspaceId,ref.id])).rows[0];
  const retrieved=new Date(row?.source_check.lastSuccess?.retrievedAt??'');
  if(!Number.isFinite(retrieved.getTime())||retrieved>now||day(retrieved)!==day(now))return {ok:false,reason:'source_changed_or_unavailable'};
 }
 const expiresAt=blocks.value.some(block=>block.socialInput?.sourceRef)?(await ctx.db.query<{deadline:Date}>("SELECT ((date_trunc('day',clock_timestamp() AT TIME ZONE 'America/New_York')+interval '1 day') AT TIME ZONE 'America/New_York') AS deadline")).rows[0]!.deadline:null;
 return {ok:true,value:{selection,hash:current.value.hash,dependencies,expiresAt}};
}
export async function selectedPrivateSource(ctx:RepositoryContext,origin:Extract<SocialPrivateDraftOrigin,{kind:'suggestion'}>):Promise<SocialResult<PrivateSourceBasis>>{
 const request=await readSocialDraftRequest(ctx,origin.requestId);
 if(!request||request.state!=='ready'||!request.concepts?.[origin.conceptIndex]?.variants[origin.variantIndex])return {ok:false,reason:'suggestion_changed_or_expired'};
 const view=socialDraftViewSchema.parse(socialDraftView(request));
 const fingerprint=createHash('sha256').update(JSON.stringify({request:view,conceptIndex:origin.conceptIndex,variantIndex:origin.variantIndex})).digest('hex');
 if(fingerprint!==origin.selectionSHA256)return {ok:false,reason:'suggestion_changed_or_expired'};
 const basis=await privateSourceBasis(ctx,request.source_selection);if(!basis.ok)return basis;
 const now=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now;
 if(request.deadline_at<=now||basis.value.hash!==request.source_hash)return {ok:false,reason:'suggestion_changed_or_expired'};
 return basis;
}
