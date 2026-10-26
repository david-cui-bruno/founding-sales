import {createHash} from 'node:crypto';
import {socialDraftRequestSchema,candidateSourceCheckSchema,type SocialDraftRequest} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readApprovedAnswerBlocks} from '../outreach/facts.ts';
import {buildSocialDraftRequest,prepareSocialDraftInput,prepareGroundedSocialDraftInput,type SocialDraftSource,type SocialDraftInput,type SocialDraftProvenance} from './draftPolicy.ts';
import type {SocialResult} from './posts.ts';
import {lockSocialMeetingSource} from './draftMeetingLocks.ts';
import {readPrivateVoiceGuide} from './voiceGeneration.ts';
import type {PrivateDraftAuthority} from './privateDrafts.ts';
interface Prepared{input:SocialDraftInput;provenance:SocialDraftProvenance[];hash:string}
function textOf(utterances:unknown):string|null{
 if(!Array.isArray(utterances))return null;let text='';
 for(const item of utterances){if(!item||typeof item!=='object'||typeof (item as {text?:unknown}).text!=='string')return null;text+=(item as {text:string}).text+'\n';if(Buffer.byteLength(text)>24*1024)return null;}
 return text;
}
/** Re-run before paid dispatch and result acceptance. No raw transcript text is
 * returned. Curated style is ephemeral input only, never a persisted snapshot. */
export async function readSocialDraftSources(ctx:RepositoryContext,raw:SocialDraftRequest,authority?:PrivateDraftAuthority):Promise<SocialResult<Prepared>>{
 if(ctx.scope.actor.kind!=='user')return {ok:false,reason:'user_required'};
 return readForOwner(ctx,ctx.scope.actor.userId,raw,authority);
}
/** Background identity remains system; owner comes from the durable request, not a renderer. */
export async function readSocialDraftSourcesForWorker(ctx:RepositoryContext,ownerUserId:string,raw:SocialDraftRequest):Promise<SocialResult<Prepared>>{
 if(ctx.scope.actor.kind!=='system'||!['worker','scheduler'].includes(ctx.scope.actor.component))return {ok:false,reason:'worker_required'};
 return readForOwner(ctx,ownerUserId,raw);
}
async function readForOwner(ctx:RepositoryContext,user:string,raw:SocialDraftRequest,authority?:PrivateDraftAuthority):Promise<SocialResult<Prepared>>{
 const parsed=socialDraftRequestSchema.safeParse(raw);if(!parsed.success)return {ok:false,reason:'invalid_input'};
 const input=parsed.data,workspace=ctx.scope.workspaceId;
 const active=(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' FOR SHARE",[workspace,user])).rows.length>0;
 if(!active)return {ok:false,reason:'owner_unavailable'};
 if(input.mode==='linkedin_grounded'){
  const voice=await readPrivateVoiceGuide(ctx,user,input,authority);if(!voice.ok)return voice;
  if(!(await ctx.db.query("SELECT 1 FROM workspace_memberships WHERE workspace_id=$1 AND user_id=$2 AND status='active' AND role='admin'",[workspace,user])).rows.length)return {ok:false,reason:'owner_required'};
  if(input.sourceRefs.some(r=>r.kind!=='public')||!input.factBlocks.length)return {ok:false,reason:'sanitized_facts_required'};
  await ctx.db.query('SELECT b.id FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id FOR SHARE OF b,v',[workspace,input.factBlocks.map(b=>b.id)]);
  const blocks=await readApprovedAnswerBlocks(ctx,input.factBlocks);if(!blocks.ok)return blocks;
  const prepared=prepareGroundedSocialDraftInput(blocks.value);if(!prepared)return {ok:false,reason:'sanitized_facts_required'};
  if(voice.value)prepared.privateVoiceGuide=voice.value;
  if(!buildSocialDraftRequest(prepared))return {ok:false,reason:'input_too_large'};
  const publicHashes:string[]=[];
  for(const block of blocks.value){
   const meta=block.socialInput!,ref=meta.sourceRef;
   if(meta.topic==='news'&&!ref)return {ok:false,reason:'news_original_required'};
   if(!ref)continue;
   const row=(await ctx.db.query<{payload:{sourceUrl?:string};source_check:unknown}>("SELECT payload,source_check FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND status<>'dismissed' FOR SHARE",[workspace,ref.id,ref.revision])).rows[0];
   const now=(await ctx.db.query<{now:Date}>('SELECT clock_timestamp() AS now')).rows[0]!.now.getTime();
   const checked=candidateSourceCheckSchema.safeParse(row?.source_check),snapshot=checked.success&&checked.data.state==='checked'?checked.data.lastSuccess:null;
   // Current news uses an ordinary sourcing.check first-party observation from this New York day.
   const date=(at:number)=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(at);
   if(!row||!checked.success||!snapshot||checked.data.checkedAt!==ref.checkedAt||Date.parse(snapshot.retrievedAt)>now||date(Date.parse(snapshot.retrievedAt))!==date(now))return {ok:false,reason:'news_source_stale_or_unavailable'};
   if(row.payload.sourceUrl!==ref.url||snapshot.url!==ref.url||!snapshot.firstParty||!snapshot.quoteMatched||snapshot.truncated||!snapshot.excerpt.includes(block.text))return {ok:false,reason:'news_original_support_unavailable'};
   publicHashes.push(createHash('sha256').update(JSON.stringify([ref,row.payload,row.source_check])).digest('hex'));
  }
  const refs=blocks.value.flatMap(b=>b.socialInput?.sourceRef?[b.socialInput.sourceRef]:[]);
  if(input.sourceRefs.some(r=>!refs.some(s=>s.id===r.id&&s.revision===r.revision)))return {ok:false,reason:'news_original_required'};
  return {ok:true,value:{input:prepared,provenance:[],hash:createHash('sha256').update(JSON.stringify({input:prepared,publicHashes})).digest('hex')}};
 }
 if(!input.sourceRefs.length)return {ok:false,reason:'invalid_input'};
 const sources:SocialDraftSource[]=[],hashes:string[]=[];
 for(const ref of input.sourceRefs){
  let text:string|null=null;
  if(ref.kind==='call'&&ref.revision===1){
   const row=(await ctx.db.query<{utterances:unknown}>(`SELECT t.utterances FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id JOIN firms f ON f.workspace_id=c.workspace_id AND f.id=c.firm_id WHERE t.workspace_id=$1 AND t.call_session_id=$2 AND c.actor_user_id=$3 AND f.status='active' AND octet_length(t.utterances::text)<=131072 FOR SHARE OF t,c,f`,[workspace,ref.id,user])).rows[0];
   if(row)text=textOf(row.utterances);
  }else if(ref.kind==='meeting'){
   if(await lockSocialMeetingSource(ctx,ref.id)===null)return {ok:false,reason:'source_changed_or_unavailable'};
   const row=(await ctx.db.query<{utterances:unknown}>(`SELECT t.utterances FROM meeting_transcripts t JOIN meeting_recordings r ON r.workspace_id=t.workspace_id AND r.id=t.recording_id JOIN meetings m ON m.workspace_id=r.workspace_id AND m.id=r.meeting_id JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id WHERE t.workspace_id=$1 AND t.id=$2 AND t.version=$3 AND f.assigned_user_id=$4 AND f.status='active' AND octet_length(t.utterances::text)<=131072 AND NOT EXISTS(SELECT 1 FROM meeting_transcripts n WHERE n.workspace_id=t.workspace_id AND n.original_recording_id=t.original_recording_id AND n.version>t.version) FOR SHARE OF t,r,m,f`,[workspace,ref.id,ref.revision,user])).rows[0];
   if(row)text=textOf(row.utterances);
  }else if(ref.kind==='public'){
   const row=(await ctx.db.query<{payload:unknown}>('SELECT payload FROM sourcing_candidates WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND status<>\'dismissed\' FOR SHARE',[workspace,ref.id,ref.revision])).rows[0];
   if(row)text=JSON.stringify(row.payload);
  }
  if(text===null)return {ok:false,reason:'source_changed_or_unavailable'};
  hashes.push(createHash('sha256').update(JSON.stringify([ref,text])).digest('hex'));sources.push({...ref,text});
 }
 if(input.factBlocks.length)await ctx.db.query('SELECT b.id FROM outreach_answer_blocks b JOIN outreach_answer_block_versions v ON v.workspace_id=b.workspace_id AND v.block_id=b.id AND v.version=b.current_version WHERE b.workspace_id=$1 AND b.id=ANY($2::uuid[]) ORDER BY b.id FOR SHARE OF b,v',[workspace,input.factBlocks.map(b=>b.id)]);
 const blocks=input.factBlocks.length?await readApprovedAnswerBlocks(ctx,input.factBlocks):{ok:true as const,value:[]};
 if(!blocks.ok)return {ok:false,reason:blocks.reason};
 // Tagged facts carry status/original-source authority that the legacy prompt cannot retain.
 if(blocks.value.some(b=>b.socialInput))return {ok:false,reason:'grounded_mode_required'};
 const prepared=prepareSocialDraftInput(sources,blocks.value);if(!prepared)return {ok:false,reason:'no_supported_theme_or_input_too_large'};
 const hash=createHash('sha256').update(JSON.stringify({hashes,input:prepared.input,provenance:prepared.provenance})).digest('hex');
 return {ok:true,value:{...prepared,hash}};
}
