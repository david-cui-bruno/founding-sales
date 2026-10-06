import {createHash} from 'node:crypto';
import {socialDraftRequestSchema,type SocialDraftRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readApprovedAnswerBlocks} from '../outreach/facts.ts';
import {prepareSocialDraftInput,type SocialDraftSource,type SocialDraftInput,type SocialDraftProvenance} from './draftPolicy.ts';
import type {SocialResult} from './posts.ts';
interface Prepared{input:SocialDraftInput;provenance:SocialDraftProvenance[];hash:string}
function textOf(utterances:unknown):string|null{
 if(!Array.isArray(utterances))return null;let text='';
 for(const item of utterances){if(!item||typeof item!=='object'||typeof (item as {text?:unknown}).text!=='string')return null;text+=(item as {text:string}).text+'\n';if(Buffer.byteLength(text)>24*1024)return null;}
 return text;
}
/** Re-run before paid dispatch and before accepting its result. No raw source text
 * is returned or persisted, only generic enums, approved facts and private references. */
export async function readSocialDraftSources(ctx:RepositoryContext,raw:SocialDraftRequest):Promise<SocialResult<Prepared>>{
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'user_required'};
 return readForOwner(ctx,ctx.scope.actor.userId,raw);
}
/** Background identity remains system; owner comes from the durable request, not a renderer. */
export async function readSocialDraftSourcesForWorker(ctx:RepositoryContext,ownerUserId:string,raw:SocialDraftRequest):Promise<SocialResult<Prepared>>{
 if(ctx.scope.actor.kind!=='system'||!['worker','scheduler'].includes(ctx.scope.actor.component))return {ok:false,reason:'worker_required'};
 return readForOwner(ctx,ownerUserId,raw);
}
async function readForOwner(ctx:RepositoryContext,user:string,raw:SocialDraftRequest):Promise<SocialResult<Prepared>>{
 const parsed=socialDraftRequestSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data,workspace=ctx.scope.workspaceId;
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[workspace,user])).rows.length>0;
 if(!active)return {ok:false,reason:'owner_unavailable'};
 const sources:SocialDraftSource[]=[],hashes:string[]=[];
 for(const ref of input.sourceRefs){
  let text:string|null=null;
  if(ref.kind==='call'&&ref.revision===1){
   const row=(await ctx.db.query<{utterances:unknown}>(`SELECT t.utterances FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE t.workspace_id=$1 AND t.call_session_id=$2 AND c.actor_user_id=$3 AND f.status='active' AND octet_length(t.utterances::text)<=131072`,[workspace,ref.id,user])).rows[0];
   if(row)text=textOf(row.utterances);
  }else if(ref.kind==='meeting'){
   const row=(await ctx.db.query<{utterances:unknown}>(`SELECT t.utterances FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND t.id=$2 AND t.version=$3 AND f.assigned_user_id=$4 AND f.status='active' AND octet_length(t.utterances::text)<=131072 AND NOT EXISTS(SELECT 1 FROM meeting_transcripts n WHERE n.workspace_id=t.workspace_id AND n.original_recording_id=t.original_recording_id AND n.version>t.version)`,[workspace,ref.id,ref.revision,user])).rows[0];
   if(row)text=textOf(row.utterances);
  }else if(ref.kind==='public'){
   const row=(await ctx.db.query<{payload:unknown}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND status<>\'dismissed\'',[workspace,ref.id,ref.revision])).rows[0];
   if(row)text=JSON.stringify(row.payload);
  }
  if(text===null)return {ok:false,reason:'source_changed_or_unavailable'};
  hashes.push(createHash('sha256').update(JSON.stringify([ref,text])).digest('hex'));sources.push({...ref,text});
 }
 const blocks=input.factBlocks.length?await readApprovedAnswerBlocks(ctx,input.factBlocks):{ok:true as const,value:[]};
 if(!blocks.ok)return {ok:false,reason:blocks.reason};
 const prepared=prepareSocialDraftInput(sources,blocks.value);if(!prepared)return {ok:false,reason:'no_supported_theme_or_input_too_large'};
 const hash=createHash('sha256').update(JSON.stringify({hashes,input:prepared.input,provenance:prepared.provenance})).digest('hex');
 return {ok:true,value:{...prepared,hash}};
}
