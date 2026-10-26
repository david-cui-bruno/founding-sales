import {callingFollowUpContentSchema,callingFollowUpListInputSchema,callingFollowUpListSchema,callingFollowUpReadInputSchema,callingFollowUpSaveInputSchema,callingFollowUpViewSchema,type CallingFollowUpSource,type CallingFollowUpContent,type CallingFollowUpMetadata,type CallingFollowUpView,type CallingFollowUpSaveInput,type CallingFollowUpList} from '@fss/contracts';
import type {z} from 'zod';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {currentCallingSource,lockCallingSource,requireCallingAuthority,CallingUnavailable,type CallingAuthority} from './followUpDraftAccess.ts';
export interface CallingDraftRow {
 [key:string]:unknown; id:string;creator_user_id:string;revision:number;source_kind:'candidate'|'firm';candidate_id:string|null;
 candidate_revision:number|null;attempt_id:string|null;firm_id:string|null;call_log_id:string|null;
 content:unknown;reason:'withdrawn'|'source_changed_or_unavailable'|'source_revision_changed'|'removed'|null;created_at:Date;updated_at:Date;
}
export function callingDraftSource(row:CallingDraftRow):CallingFollowUpSource{
 return row.source_kind==='candidate'?{kind:'candidate',candidateId:row.candidate_id!,candidateRevision:row.candidate_revision!,attemptId:row.attempt_id!}:{kind:'firm',firmId:row.firm_id!,callLogId:row.call_log_id!};
}
export function callingDraftMetadata(row:CallingDraftRow):CallingFollowUpMetadata{
 return {draftId:row.id,revision:row.revision,source:callingDraftSource(row),availability:row.reason===null?'available':row.reason==='withdrawn'?'withdrawn':'unavailable',createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()};
}
export function callingDraftView(row:CallingDraftRow):CallingFollowUpView{
 const metadata=callingDraftMetadata(row);
 return callingFollowUpViewSchema.parse(row.reason===null?{...metadata,availability:'available',content:callingFollowUpContentSchema.parse(row.content),state:'queued_for_review',recipient:'unresolved',sendAuthority:'not_granted'}:row.reason==='withdrawn'?{...metadata,availability:'withdrawn'}:{...metadata,availability:'unavailable',reason:row.reason});
}
export async function findCallingDraft(ctx:RepositoryContext,id:string,lock=false):Promise<CallingDraftRow|null>{
 const actor=ctx.scope.actor;if(actor.kind!=='user')return null;
 return (await ctx.db.query<CallingDraftRow>(`SELECT * FROM calling_follow_up_drafts WHERE workspace_id=$1 AND id=$2 AND creator_user_id=$3${lock?' FOR UPDATE':''}`,[ctx.scope.workspaceId,id,actor.userId])).rows[0]??null;
}
/** Caller holds the exact source and command transaction. ON CONFLICT retains terminal identity. */
export async function createCallingDraft(ctx:RepositoryContext,id:string,source:CallingFollowUpSource,content:CallingFollowUpContent,authority:CallingAuthority){
 if(ctx.scope.actor.kind!=='user')return {ok:false as const,reason:'draft_unavailable' as const};
 const parsed=callingFollowUpContentSchema.safeParse(content);if(!parsed.success)return {ok:false as const,reason:'draft_unavailable' as const};
 await currentCallingSource(ctx,source,authority);
 const row=(await ctx.db.query<{id:string;revision:number}>(`INSERT INTO calling_follow_up_drafts
 (workspace_id,id,creator_user_id,creator_ref,source_kind,candidate_id,candidate_revision,attempt_id,attempt_ref,firm_id,call_log_id,call_log_ref,content)
 VALUES($1,$2,$3,$3,$4,$5,$6,$7,$7,$8,$9,$9,$10::jsonb) ON CONFLICT DO NOTHING RETURNING id,revision`,[ctx.scope.workspaceId,id,ctx.scope.actor.userId,source.kind,source.kind==='candidate'?source.candidateId:null,source.kind==='candidate'?source.candidateRevision:null,source.kind==='candidate'?source.attemptId:null,source.kind==='firm'?source.firmId:null,source.kind==='firm'?source.callLogId:null,JSON.stringify(parsed.data)])).rows[0];
 if(!row)return {ok:false as const,reason:'draft_conflict' as const};
 await currentCallingSource(ctx,source,authority);
 return {ok:true as const,value:{draftId:row.id,revision:row.revision}};
}
export async function readCallingDraft(ctx:RepositoryContext,raw:z.infer<typeof callingFollowUpReadInputSchema>,authority:CallingAuthority):Promise<CallingFollowUpView|null>{
 const input=callingFollowUpReadInputSchema.parse(raw),before=await findCallingDraft(ctx,input.draftId);
 if(!before){await requireCallingAuthority(ctx,authority);return null;}
 if(before.reason===null)await lockCallingSource(ctx,callingDraftSource(before));
 const row=await findCallingDraft(ctx,input.draftId,true);
 await requireCallingAuthority(ctx,authority);
 if(!row)return null;
 if(row.revision!==input.expectedRevision)throw new CallingUnavailable('stale_revision');
 if(row.reason===null)await currentCallingSource(ctx,callingDraftSource(row),authority);
 return callingDraftView(row);
}
/** Metadata only, stable keyset. Source-unavailable entries expose only their creator's opaque history. */
export async function listCallingDrafts(ctx:RepositoryContext,raw:z.infer<typeof callingFollowUpListInputSchema>,authority:CallingAuthority):Promise<CallingFollowUpList>{
 const input=callingFollowUpListInputSchema.parse(raw);
 if(ctx.scope.actor.kind!=='user')throw new CallingUnavailable('draft_unavailable');
 const rows=(await ctx.db.query<CallingDraftRow>('SELECT * FROM calling_follow_up_drafts WHERE workspace_id=$1 AND creator_user_id=$2 AND ($3::uuid IS NULL OR id>$3) ORDER BY id LIMIT 21',[ctx.scope.workspaceId,ctx.scope.actor.userId,input.afterId??null])).rows;
 const drafts:CallingFollowUpMetadata[]=[];
 for(const before of rows.slice(0,20)){
  let available=true;
  if(before.reason===null){try{await lockCallingSource(ctx,callingDraftSource(before));await currentCallingSource(ctx,callingDraftSource(before),authority);}catch(error){if(error instanceof CallingUnavailable)available=false;else throw error;}}
  const current=await findCallingDraft(ctx,before.id);
  if(current){const metadata=callingDraftMetadata(current);drafts.push(available?metadata:{...metadata,availability:'unavailable'});}
 }
 await requireCallingAuthority(ctx,authority);
 return callingFollowUpListSchema.parse({drafts,nextAfterId:rows.length>20?rows[19]!.id:null});
}
export async function saveCallingDraft(ctx:RepositoryContext,raw:CallingFollowUpSaveInput,authority:CallingAuthority){
 const parsed=callingFollowUpSaveInputSchema.safeParse(raw);if(!parsed.success)return {ok:false as const,reason:'invalid_input'};
 const input=parsed.data,before=await findCallingDraft(ctx,input.draftId);
 if(!before){await requireCallingAuthority(ctx,authority);return {ok:false as const,reason:'draft_unavailable'};}
 if(before.reason!==null)return {ok:false as const,reason:'draft_unavailable'};
 const source=callingDraftSource(before);await lockCallingSource(ctx,source);
 const row=await findCallingDraft(ctx,input.draftId,true);await currentCallingSource(ctx,source,authority);
 if(!row||row.reason!==null)return {ok:false as const,reason:'draft_unavailable'};
 if(row.revision!==input.expectedRevision)return {ok:false as const,reason:'stale_revision'};
 const content=input.operation==='update'?callingFollowUpContentSchema.parse({subject:input.subject,body:input.body}):null;
 const saved=(await ctx.db.query<{id:string;revision:number}>(`UPDATE calling_follow_up_drafts SET content=$4::jsonb,reason=$5,revision=revision+1,updated_at=clock_timestamp()
 WHERE workspace_id=$1 AND id=$2 AND revision=$3 AND content IS NOT NULL RETURNING id,revision`,[ctx.scope.workspaceId,row.id,input.expectedRevision,content?JSON.stringify(content):null,input.operation==='withdraw'?'withdrawn':null])).rows[0];
 if(!saved)return {ok:false as const,reason:'stale_revision'};
 await currentCallingSource(ctx,source,authority);
 return {ok:true as const,value:{draftId:saved.id,revision:saved.revision}};
}
