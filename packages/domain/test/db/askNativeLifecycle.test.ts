import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {seedCrm} from './support/crmFixtures.ts';
import {seedMail} from './support/mailFixtures.ts';
import {callSession} from './support/callToBookingCases.ts';
it('erases private Ask copies when an original native meeting transcript is removed',async()=>{
 const database=await createTestDatabase();
 try{
  const seeded=await seedTwoWorkspaces(database.session),workspace=seeded.alpha.workspaceId,owner=seeded.alpha.admin.userId;
  const firmId=randomUUID(),meetingId=randomUUID(),recordingId=randomUUID(),sourceId=randomUUID(),requestId=randomUUID();
  await database.session.query("INSERT INTO firms(workspace_id,id,name,assigned_user_id,region_code) VALUES($1,$2,'Native privacy',$3,'TX')",[workspace,firmId,owner]);
  await database.session.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,'ask-native','ask-native','booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[workspace,meetingId,firmId]);
  await database.session.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status) VALUES($1,$2,$3,1,'Selected transcript',$4,100,$5,'ready')",[workspace,recordingId,meetingId,'a'.repeat(64),`meetings/${meetingId}/${'a'.repeat(64)}.m4a`]);
  const utterances=[{startMs:0,endMs:5000,text:'We need help coordinating repairs.',speaker:'Correspondent',attribution:'source_label'}];
  await database.session.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[workspace,sourceId,recordingId,JSON.stringify(utterances)]);
  const scope={sources:[{workspaceId:workspace,sourceId,kind:'meeting_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null}]};
  const context={personId:null,firmIds:[firmId],relationships:[],review:'current'},closure={firmIds:[firmId],personIds:[]};
  await database.session.query("INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Who coordinates repairs?',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')",[workspace,requestId,owner,JSON.stringify(scope),JSON.stringify([context]),JSON.stringify(closure)]);
  await database.session.query('DELETE FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2',[workspace,sourceId]);
  expect((await database.session.query('SELECT state,reason,question,scope,initial_contexts,initial_access_closure,result FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[workspace,requestId])).rows).toEqual([{state:'deleted',reason:'deleted',question:null,scope:null,initial_contexts:null,initial_access_closure:null,result:null}]);
 }finally{await database.drop();}
});

it('erases private Ask copies when an original native call transcript is removed',async()=>{
 const database=await createTestDatabase();
 try{
  const seeded=await seedTwoWorkspaces(database.session),crm=await seedCrm(database.session,seeded),mail=await seedMail(database.session,seeded,crm),workspace=seeded.alpha.workspaceId,owner=seeded.alpha.salesperson.userId;
  const sessionId=await callSession({session:database.session,seeded,crm,mail}),requestId=randomUUID();
  const firmId=(await database.session.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[workspace,sessionId])).rows[0]!.firm_id;
  const utterances=[{startMs:0,endMs:5000,text:'We need help coordinating repairs.',speaker:'Correspondent',attribution:'source_label'}];
  await database.session.query("INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'deepgram','nova-3','en',5,$3::jsonb)",[workspace,sessionId,JSON.stringify(utterances)]);
  const scope={sources:[{workspaceId:workspace,sourceId:sessionId,kind:'call_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(utterances)).digest('hex'),locator:null}]};
  const context={personId:null,firmIds:[firmId],relationships:[],review:'current'},closure={firmIds:[firmId],personIds:[]};
  await database.session.query("INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Who coordinates repairs?',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')",[workspace,requestId,owner,JSON.stringify(scope),JSON.stringify([context]),JSON.stringify(closure)]);
  await database.session.query('DELETE FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2',[workspace,sessionId]);
  expect((await database.session.query('SELECT state,reason,question,scope,initial_contexts,initial_access_closure,result FROM crm_ask_requests WHERE workspace_id=$1 AND id=$2',[workspace,requestId])).rows).toEqual([{state:'deleted',reason:'deleted',question:null,scope:null,initial_contexts:null,initial_access_closure:null,result:null}]);
 }finally{await database.drop();}
});
