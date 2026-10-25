import {createHash} from 'node:crypto';
import {expect,it} from 'vitest';
import {socialDraftViewSchema,type SocialDraftRequest} from '@fss/contracts';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope,type RepositoryContext} from '../../db/workspaceScope.ts';
import {readSocialDraftSources} from '../../social/draftSources.ts';
import {readSocialDraftRequest} from '../../social/drafts.ts';
import {socialDraftView} from '../../social/draftWorkspace.ts';
import {saveSocialPrivateDraft,readSocialPrivateDraft} from '../../social/privateDrafts.ts';
import {previewDeletion,commitDeletion} from '../../retention/deletion.ts';
import {recordingSuppressionJournal} from '../../suppression/journal.ts';
import {beginMeetingTranscription,dispatchMeetingTranscription,completeMeetingTranscription} from '../../meetings/transcription.ts';
import {accountId,at,jobPrefix,meetingProcessingFixture,prepared} from '../meetings/support/meetingProcessingFixture.ts';
const authority=async()=>true;
async function saveSelected(ctx:RepositoryContext,selection:SocialDraftRequest){
 const source=await withTransaction(ctx.db,()=>readSocialDraftSources(ctx,selection));if(!source.ok)throw Error(source.reason);
 if(ctx.scope.actor.kind!=='user')throw Error('User required');
 const request=(await ctx.db.query<{id:string}>("INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3::jsonb,$4,'social-themes-v1','fixture','ready',$5::jsonb) RETURNING id",[ctx.scope.workspaceId,ctx.scope.actor.userId,JSON.stringify(selection),source.value.hash,JSON.stringify([{theme:'after_hours',factRefs:[],variants:[{platform:'linkedin',text:'Controlled current meeting suggestion.'}]}])])).rows[0]!;
 const row=await withTransaction(ctx.db,()=>readSocialDraftRequest(ctx,request.id));if(!row)throw Error('Missing request');const origin={kind:'suggestion' as const,requestId:row.id,conceptIndex:0,variantIndex:0,selectionSHA256:createHash('sha256').update(JSON.stringify({request:socialDraftViewSchema.parse(socialDraftView(row)),conceptIndex:0,variantIndex:0})).digest('hex')};
 const saved=await withTransaction(ctx.db,()=>saveSocialPrivateDraft(ctx,{operation:'create',kind:'comment',text:'Owner edited private meeting composition.',origin},authority));if(!saved.ok)throw Error(saved.reason);return saved.value;
}
it('ordinary admin deletion previews private revision and physically clears sourced bytes using runtime role',async()=>{
 const f=await meetingProcessingFixture();try{
  const meeting=await f.meeting(),recording=await f.recording(meeting),transcript=await f.transcript(recording);await f.db.session.query('UPDATE meeting_transcripts SET utterances=$2::jsonb WHERE id=$1',[transcript,JSON.stringify([{startMs:0,endMs:100,text:'After-hours maintenance support.',speaker:null,attribution:'source_label'}])]);
  const runtime=await f.db.appRuntimeSession(),owner=repositoryContext(workspaceScope(f.workspace,{kind:'user',userId:f.seeded.alpha.salesperson.userId,role:'salesperson'}),runtime),admin=repositoryContext(f.context.scope,runtime);
  const saved=await saveSelected(owner,{sourceRefs:[{kind:'meeting',id:transcript,revision:1}],factBlocks:[]});const firm=(await runtime.query<{firm_id:string}>('SELECT firm_id FROM meetings WHERE id=$1',[meeting])).rows[0]!.firm_id;
  const preview=await withTransaction(runtime,()=>previewDeletion(admin,{targetKind:'firm',firmId:firm}));expect(preview.ok,preview.reason).toBe(true);expect(preview.value?.redacts['social_private_drafts']).toBe(1);
  const outcome=await withTransaction(runtime,()=>commitDeletion(admin,{requestId:preview.value!.requestId,previewHash:preview.value!.previewHash,commandId:'private-social-deletion',journal:recordingSuppressionJournal()}));expect(outcome.ok,outcome.reason).toBe(true);expect((await runtime.query('SELECT text,origin,source_selection,source_hash,dependencies FROM social_private_drafts WHERE id=$1',[saved.draftId])).rows[0]).toEqual({text:null,origin:null,source_selection:null,source_hash:null,dependencies:{}});
 }finally{await f.db.drop();}
});
it('normal latest meeting completion erases saved text before waiting private update can resurrect it',async()=>{
 const f=await meetingProcessingFixture();try{
  const meeting=await f.meeting(),recording=await f.recording(meeting);const attempt=await withTransaction(f.db.session,()=>beginMeetingTranscription(f.context,{recordingId:recording,prepared:prepared(recording),at,accountId,jobPrefix}));if(attempt.kind!=='reserved')throw Error('Fixture not reserved');await withTransaction(f.db.session,()=>dispatchMeetingTranscription(f.context,{attemptId:attempt.attemptId,at,accountId}));
  const transcript=await f.transcript(recording);await f.db.session.query('UPDATE meeting_transcripts SET utterances=$2::jsonb WHERE id=$1',[transcript,JSON.stringify([{startMs:0,endMs:100,text:'After-hours maintenance support.',speaker:null,attribution:'source_label'}])]);const scope=workspaceScope(f.workspace,{kind:'user',userId:f.seeded.alpha.salesperson.userId,role:'salesperson'});const reader=await f.db.appRuntimeSession(),owner=repositoryContext(scope,reader),saved=await saveSelected(owner,{sourceRefs:[{kind:'meeting',id:transcript,revision:1}],factBlocks:[]});
  let locked!:()=>void,release!:()=>void;const lockedPromise=new Promise<void>(resolve=>{locked=resolve;}),continuePromise=new Promise<void>(resolve=>{release=resolve;});const writer:SessionQueryable={async query(sql,values){if(sql.startsWith('SELECT * FROM meeting_transcription_attempts')&&sql.includes('FOR UPDATE')){locked();await continuePromise;}return f.db.session.query(sql,values);}};
  const completion=withTransaction(writer,()=>completeMeetingTranscription(repositoryContext(f.context.scope,writer),{attemptId:attempt.attemptId,at,result:{kind:'complete',language:'en-US',utterances:[{startMs:0,endMs:100,text:'New maintenance workflow.',speaker:null,attribution:'unknown'}]}}));await lockedPromise;const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() pid')).rows[0]!.pid;
  const update=withTransaction(reader,()=>saveSocialPrivateDraft(owner,{operation:'update',draftId:saved.draftId,expectedRevision:1,kind:'post',text:'Stale meeting-dependent bytes'},authority));try{await expect.poll(async()=>Boolean((await f.db.session.query('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0]?.['waiting'])).toBe(true);}finally{release();}expect(await completion).toBe('complete');expect(await update).toMatchObject({ok:false,reason:'source_changed_or_unavailable'});expect(await withTransaction(reader,()=>readSocialPrivateDraft(owner,saved.draftId,authority))).toMatchObject({availability:'unavailable'});expect((await reader.query('SELECT text,source_selection FROM social_private_drafts WHERE id=$1',[saved.draftId])).rows[0]).toEqual({text:null,source_selection:null});
 }finally{await f.db.drop();}
});
