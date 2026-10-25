import {expect,it} from 'vitest';
import {withTransaction,type SessionQueryable} from '../../db/queryable.ts';
import {repositoryContext,workspaceScope} from '../../db/workspaceScope.ts';
import {beginMeetingTranscription,dispatchMeetingTranscription,completeMeetingTranscription} from '../../meetings/transcription.ts';
import {readSocialDraftSources} from '../../social/draftSources.ts';
import {readSocialDraftRequest} from '../../social/drafts.ts';
import {readSocialDraftWorkspace} from '../../social/draftWorkspace.ts';
import {accountId,at,jobPrefix,meetingProcessingFixture,prepared} from '../meetings/support/meetingProcessingFixture.ts';

it.each(['detail','picker'] as const)('rechecks latest meeting version after normal completion association wait: %s',async mode=>{
 const f=await meetingProcessingFixture();
 try{
  const meeting=await f.meeting(),recording=await f.recording(meeting);
  const attempt=await withTransaction(f.db.session,()=>beginMeetingTranscription(f.context,{recordingId:recording,prepared:prepared(recording),at,accountId,jobPrefix}));
  if(attempt.kind!=='reserved')throw Error('Fixture not reserved');
  await withTransaction(f.db.session,()=>dispatchMeetingTranscription(f.context,{attemptId:attempt.attemptId,at,accountId}));
  const transcript=await f.transcript(recording);
  await f.db.session.query('UPDATE meeting_transcripts SET utterances=$2::jsonb WHERE id=$1',[transcript,JSON.stringify([{startMs:0,endMs:100,text:'After-hours maintenance support.',speaker:null,attribution:'source_label'}])]);
  const user=f.seeded.alpha.salesperson.userId;
  const scope=workspaceScope(f.workspace,{kind:'user',userId:user,role:'salesperson'});
  const selection={sourceRefs:[{kind:'meeting' as const,id:transcript,revision:1}],factBlocks:[]};
  const source=await withTransaction(f.db.session,()=>readSocialDraftSources(repositoryContext(scope,f.db.session),selection));
  if(!source.ok)throw Error(source.reason);
  const concepts=[{theme:'after_hours',factRefs:[],variants:[{platform:'linkedin',text:'Old retained suggestion.'}]}];
  const request=(await f.db.session.query<{id:string}>("INSERT INTO social_draft_requests(workspace_id,owner_user_id,source_selection,source_hash,prompt_version,model_name,state,concepts) VALUES($1,$2,$3::jsonb,$4,'social-themes-v1','claude-haiku-4-5','ready',$5::jsonb) RETURNING id",[f.workspace,user,JSON.stringify(selection),source.value.hash,JSON.stringify(concepts)])).rows[0]!;
  // The picker case isolates its own metadata lock path, without the request refresh locking first.
  if(mode==='picker')await f.db.session.query("UPDATE social_draft_requests SET state='review',concepts=NULL WHERE id=$1",[request.id]);
  const reader=await f.db.appRuntimeSession();
  const pid=(await reader.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
  let locked!:()=>void,release!:()=>void;
  const lockedPromise=new Promise<void>(resolve=>{locked=resolve;}),continuePromise=new Promise<void>(resolve=>{release=resolve;});
  const writer:SessionQueryable={async query(sql,values){
   if(sql.startsWith('SELECT * FROM meeting_transcription_attempts')&&sql.includes('FOR UPDATE')){locked();await continuePromise;}
   return f.db.session.query(sql,values);
  }};
  const completion=withTransaction(writer,()=>completeMeetingTranscription(repositoryContext(f.context.scope,writer),{attemptId:attempt.attemptId,at,result:{kind:'complete',language:'en-US',utterances:[{startMs:0,endMs:100,text:'New maintenance workflow.',speaker:null,attribution:'unknown'}]}}));
  await lockedPromise;
  const reading=withTransaction(reader,async()=>mode==='detail'?{kind:'detail' as const,value:await readSocialDraftRequest(repositoryContext(scope,reader),request.id)}:{kind:'picker' as const,value:await readSocialDraftWorkspace(repositoryContext(scope,reader))});
  try{
   let waiting=false;
   for(let i=0;i<100&&!waiting;i++){
    waiting=(await f.db.session.query<{waiting:boolean}>('SELECT cardinality(pg_blocking_pids($1))>0 AS waiting',[pid])).rows[0]!.waiting;
    if(!waiting)await new Promise(resolve=>{setTimeout(resolve,10);});
   }
   expect(waiting).toBe(true);
  }finally{release();}
  expect(await completion).toBe('complete');
  const answer=await reading;
  if(answer.kind==='detail'){
   expect(answer.value).toMatchObject({state:'review',concepts:null,reason:'source_changed_or_unavailable'});
   expect((await f.db.session.query('SELECT state,concepts FROM social_draft_requests WHERE id=$1',[request.id])).rows[0]).toEqual({state:'ready',concepts});
  }else{
   const sources=answer.value.sources.filter(ref=>ref.kind==='meeting');
   expect(sources).toHaveLength(1);expect(sources[0]).toMatchObject({revision:2});expect(sources[0]!.id).not.toBe(transcript);
  }
  expect((await f.db.session.query('SELECT version FROM meeting_transcripts WHERE original_recording_id=$1 ORDER BY version',[recording])).rows).toEqual([{version:1},{version:2}]);
  console.log(`SOCIAL_769_NORMAL_COMPLETION_WAIT ${mode} observed=true latest=2 database=${f.db.name}`);
 }finally{await f.db.drop();}
});
