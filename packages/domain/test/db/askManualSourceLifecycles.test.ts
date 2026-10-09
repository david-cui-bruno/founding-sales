import {createHash,randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createTestDatabase} from '../../db/testing/testDatabase.ts';
import {seedTwoWorkspaces} from './support/fixtures.ts';
import {seedCrm} from './support/crmFixtures.ts';
import {seedMail} from './support/mailFixtures.ts';
import {callSession,meeting} from './support/callToBookingCases.ts';
import {recording} from './support/meetingRecordingsCases.ts';
import {seedMailCaptureCatalogFixture} from './support/mailCaptureCases.ts';

it('physically deleting an uncited call input erases independent human action details while preserving completed facts and the cited original',async()=>{
 const database=await createTestDatabase();
 try{
  const seeded=await seedTwoWorkspaces(database.session),crm=await seedCrm(database.session,seeded),mail=await seedMail(database.session,seeded,crm);
  const fixture={session:database.session,seeded,crm,mail},workspaceId=seeded.alpha.workspaceId,owner=seeded.alpha.salesperson.userId;
  const callId=await callSession(fixture);
  const callFirm=(await database.session.query<{firm_id:string}>('SELECT firm_id FROM call_sessions WHERE workspace_id=$1 AND id=$2',[workspaceId,callId])).rows[0]!.firm_id;
  const speech=[{speaker:0,start:0,end:2,text:'Uncited original routing context.'}];
  await database.session.query(`INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'fixture','fixture-v1','en',2,$3::jsonb)`,[workspaceId,callId,JSON.stringify(speech)]);
  const noteId=randomUUID(),text='Cited original maintenance note.',hash=createHash('sha256').update(text).digest('hex');
  await database.session.query(`INSERT INTO crm_selected_sources(workspace_id,id,firm_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$5,'2026-10-01T14:00:00Z')`,[workspaceId,noteId,crm.alpha.firmId,owner,hash,text]);
  const cited={workspaceId,sourceId:noteId,kind:'selected_note',revision:1,contentHash:hash,locator:null};
  const uncited={workspaceId,sourceId:callId,kind:'call_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(speech)).digest('hex'),locator:null};
  const scope={sources:[cited,uncited]},contexts=[{personId:null,firmIds:[crm.alpha.firmId],relationships:[],review:'current'},{personId:null,firmIds:[callFirm],relationships:[],review:'current'}];
  const closure={firmIds:[crm.alpha.firmId,callFirm].sort(),personIds:[]};
  const requestId=randomUUID();
  await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Maintenance review',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')`,[workspaceId,requestId,owner,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure)]);
  const support=JSON.stringify([{...cited,locator:'text:0:5'}]),ids={note:randomUUID(),open:randomUUID(),done:randomUUID()},completedAt='2026-10-02T14:00:00.000Z';
  for(const [kind,status,id,completed] of [['note','active',ids.note,null],['task','open',ids.open,null],['task','done',ids.done,completedAt]] as const){
   await database.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs,completed_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,'Explicit private human annotation.',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,[workspaceId,id,owner,requestId,kind,status,crm.alpha.firmId,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure),support,completed]);
  }
  const read=async()=> (await database.session.query<{id:string;kind:string;status:string;version:number;private_state:string;human_text:null;due:null;target_firm_id:null;input_scope:null;initial_contexts:null;original_access_closure:null;support_refs:null;review_required:boolean;completed_at:Date|null}>(`SELECT id,kind,status,version,private_state,human_text,due,target_firm_id,input_scope,initial_contexts,original_access_closure,support_refs,review_required,completed_at FROM crm_ask_actions WHERE workspace_id=$1 AND source_request_id=$2 ORDER BY id`,[workspaceId,requestId])).rows;
  await database.session.query('DELETE FROM call_transcripts WHERE workspace_id=$1 AND call_session_id=$2',[workspaceId,callId]);
  const erased=await read();expect(erased).toHaveLength(3);
  for(const row of erased)expect(row).toMatchObject({version:2,private_state:'deleted',human_text:null,due:null,target_firm_id:null,input_scope:null,initial_contexts:null,original_access_closure:null,support_refs:null});
  expect(erased.find(row=>row.id===ids.open)).toMatchObject({status:'open',review_required:true,completed_at:null});
  expect(erased.find(row=>row.id===ids.done)).toMatchObject({status:'done',review_required:false});
  expect(erased.find(row=>row.id===ids.done)!.completed_at!.toISOString()).toBe(completedAt);
  expect((await database.session.query('SELECT excerpt,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[workspaceId,noteId])).rows).toEqual([{excerpt:text,availability:'available'}]);
  await database.session.query(`INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances,crm_revision) VALUES($1,$2,'fixture','fixture-v1','en',2,$3::jsonb,2)`,[workspaceId,callId,JSON.stringify(speech)]);
  expect(await read()).toEqual(erased);
 }finally{await database.drop();}
});

it('physically deleting an uncited meeting input erases independent human action details while preserving completed facts and the cited original',async()=>{
 const database=await createTestDatabase();
 try{
  const seeded=await seedTwoWorkspaces(database.session),crm=await seedCrm(database.session,seeded),mail=await seedMail(database.session,seeded,crm);
  const fixture={session:database.session,seeded,crm,mail},workspaceId=seeded.alpha.workspaceId,owner=seeded.alpha.salesperson.userId;
  const meetingId=await meeting(fixture),recordingId=randomUUID(),transcriptId=randomUUID();
  await recording(fixture,meetingId,{id:recordingId,crm_capture_owner_user_id:owner});
  const callFirm=(await database.session.query<{firm_id:string}>('SELECT firm_id FROM meetings WHERE workspace_id=$1 AND id=$2',[workspaceId,meetingId])).rows[0]!.firm_id;
  const speech=[{startMs:0,endMs:2000,text:'Uncited original routing context.',speaker:null,attribution:'unknown'}];
  await database.session.query(`INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,2000,'en',$4::jsonb)`,[workspaceId,transcriptId,recordingId,JSON.stringify(speech)]);
  const noteId=randomUUID(),text='Cited original maintenance note.',hash=createHash('sha256').update(text).digest('hex');
  await database.session.query(`INSERT INTO crm_selected_sources(workspace_id,id,firm_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$5,'2026-10-01T14:00:00Z')`,[workspaceId,noteId,crm.alpha.firmId,owner,hash,text]);
  const cited={workspaceId,sourceId:noteId,kind:'selected_note',revision:1,contentHash:hash,locator:null};
  const uncited={workspaceId,sourceId:transcriptId,kind:'meeting_transcript',revision:1,contentHash:createHash('sha256').update(JSON.stringify(speech)).digest('hex'),locator:null};
  const scope={sources:[cited,uncited]},contexts=[{personId:null,firmIds:[crm.alpha.firmId],relationships:[],review:'current'},{personId:null,firmIds:[callFirm],relationships:[],review:'current'}];
  const closure={firmIds:[crm.alpha.firmId,callFirm].sort(),personIds:[]};
  const requestId=randomUUID();
  await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Maintenance review',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')`,[workspaceId,requestId,owner,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure)]);
  const support=JSON.stringify([{...cited,locator:'text:0:5'}]),ids={note:randomUUID(),open:randomUUID(),done:randomUUID()},completedAt='2026-10-02T14:00:00.000Z';
  for(const [kind,status,id,completed] of [['note','active',ids.note,null],['task','open',ids.open,null],['task','done',ids.done,completedAt]] as const){
   await database.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs,completed_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,'Explicit private human annotation.',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,[workspaceId,id,owner,requestId,kind,status,crm.alpha.firmId,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure),support,completed]);
  }
  const read=async()=> (await database.session.query<{id:string;kind:string;status:string;version:number;private_state:string;human_text:null;due:null;target_firm_id:null;input_scope:null;initial_contexts:null;original_access_closure:null;support_refs:null;review_required:boolean;completed_at:Date|null}>(`SELECT id,kind,status,version,private_state,human_text,due,target_firm_id,input_scope,initial_contexts,original_access_closure,support_refs,review_required,completed_at FROM crm_ask_actions WHERE workspace_id=$1 AND source_request_id=$2 ORDER BY id`,[workspaceId,requestId])).rows;
  await database.session.query('DELETE FROM meeting_transcripts WHERE workspace_id=$1 AND id=$2',[workspaceId,transcriptId]);
  const erased=await read();expect(erased).toHaveLength(3);
  for(const row of erased)expect(row).toMatchObject({version:2,private_state:'deleted',human_text:null,due:null,target_firm_id:null,input_scope:null,initial_contexts:null,original_access_closure:null,support_refs:null});
  expect(erased.find(row=>row.id===ids.open)).toMatchObject({status:'open',review_required:true,completed_at:null});
  expect(erased.find(row=>row.id===ids.done)).toMatchObject({status:'done',review_required:false});
  expect(erased.find(row=>row.id===ids.done)!.completed_at!.toISOString()).toBe(completedAt);
  expect((await database.session.query('SELECT excerpt,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[workspaceId,noteId])).rows).toEqual([{excerpt:text,availability:'available'}]);
  await database.session.query(`INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,2,2000,'en',$4::jsonb)`,[workspaceId,transcriptId,recordingId,JSON.stringify(speech)]);
  expect(await read()).toEqual(erased);
 }finally{await database.drop();}
});

it.each(['change','delete'] as const)('%s of an uncited catalog mail canonical input erases independent human action details while preserving completed facts and the cited original',async(operation)=>{
 const database=await createTestDatabase();
 try{
  const seeded=await seedTwoWorkspaces(database.session),crm=await seedCrm(database.session,seeded),mail=await seedMail(database.session,seeded,crm);
  const fixture={session:database.session,seeded,crm,mail},workspaceId=seeded.alpha.workspaceId,owner=seeded.alpha.salesperson.userId;
  // Catalog metadata exercises the storage lifecycle, not provider admission or a body grant.
  await seedMailCaptureCatalogFixture(fixture);
  const mailId=mail.alpha.messageId,callFirm=crm.alpha.firmId;
  const noteId=randomUUID(),text='Cited original maintenance note.',hash=createHash('sha256').update(text).digest('hex');
  await database.session.query(`INSERT INTO crm_selected_sources(workspace_id,id,firm_id,owner_user_id,source_key_hash,excerpt,content_hash,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$5,'2026-10-01T14:00:00Z')`,[workspaceId,noteId,crm.alpha.firmId,owner,hash,text]);
  const cited={workspaceId,sourceId:noteId,kind:'selected_note',revision:1,contentHash:hash,locator:null};
  const uncited={workspaceId,sourceId:mailId,kind:'mail',revision:1,contentHash:'c'.repeat(64),locator:null};
  const scope={sources:[cited,uncited]},contexts=[{personId:null,firmIds:[crm.alpha.firmId],relationships:[],review:'current'},{personId:null,firmIds:[callFirm],relationships:[],review:'current'}];
  const closure={firmIds:[crm.alpha.firmId],personIds:[]};
  const requestId=randomUUID();
  await database.session.query(`INSERT INTO crm_ask_requests(workspace_id,id,owner_user_id,question,scope,initial_contexts,initial_access_closure,state,reason) VALUES($1,$2,$3,'Maintenance review',$4::jsonb,$5::jsonb,$6::jsonb,'unavailable','purpose_unavailable')`,[workspaceId,requestId,owner,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure)]);
  const support=JSON.stringify([{...cited,locator:'text:0:5'}]),ids={note:randomUUID(),open:randomUUID(),done:randomUUID()},completedAt='2026-10-02T14:00:00.000Z';
  for(const [kind,status,id,completed] of [['note','active',ids.note,null],['task','open',ids.open,null],['task','done',ids.done,completedAt]] as const){
   await database.session.query(`INSERT INTO crm_ask_actions(workspace_id,id,owner_user_id,source_request_id,source_request_version,kind,status,target_firm_id,human_text,input_scope,initial_contexts,original_access_closure,support_refs,completed_at) VALUES($1,$2,$3,$4,1,$5,$6,$7,'Explicit private human annotation.',$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12)`,[workspaceId,id,owner,requestId,kind,status,crm.alpha.firmId,JSON.stringify(scope),JSON.stringify(contexts),JSON.stringify(closure),support,completed]);
  }
  const read=async()=> (await database.session.query<{id:string;kind:string;status:string;version:number;private_state:string;human_text:null;due:null;target_firm_id:null;input_scope:null;initial_contexts:null;original_access_closure:null;support_refs:null;review_required:boolean;completed_at:Date|null}>(`SELECT id,kind,status,version,private_state,human_text,due,target_firm_id,input_scope,initial_contexts,original_access_closure,support_refs,review_required,completed_at FROM crm_ask_actions WHERE workspace_id=$1 AND source_request_id=$2 ORDER BY id`,[workspaceId,requestId])).rows;
  const original=(await database.session.query<{source:unknown}>('SELECT to_jsonb(s) AS source FROM crm_mail_sources s WHERE workspace_id=$1 AND source_id=$2',[workspaceId,mailId])).rows[0]!.source;
  if(operation==='change')await database.session.query("UPDATE crm_mail_sources SET source_revision=2,content_hash=repeat('d',64) WHERE workspace_id=$1 AND source_id=$2",[workspaceId,mailId]);
  else await database.session.query('DELETE FROM crm_mail_sources WHERE workspace_id=$1 AND source_id=$2',[workspaceId,mailId]);
  const erased=await read();expect(erased).toHaveLength(3);
  for(const row of erased)expect(row).toMatchObject({version:2,private_state:operation==='delete'?'deleted':'stale',human_text:null,due:null,target_firm_id:null,input_scope:null,initial_contexts:null,original_access_closure:null,support_refs:null});
  expect(erased.find(row=>row.id===ids.open)).toMatchObject({status:'open',review_required:true,completed_at:null});
  expect(erased.find(row=>row.id===ids.done)).toMatchObject({status:'done',review_required:false});
  expect(erased.find(row=>row.id===ids.done)!.completed_at!.toISOString()).toBe(completedAt);
  expect((await database.session.query('SELECT excerpt,availability FROM crm_selected_sources WHERE workspace_id=$1 AND id=$2',[workspaceId,noteId])).rows).toEqual([{excerpt:text,availability:'available'}]);
  if(operation==='change')await database.session.query("UPDATE crm_mail_sources SET source_revision=3,content_hash=repeat('c',64) WHERE workspace_id=$1 AND source_id=$2",[workspaceId,mailId]);
  else await database.session.query("INSERT INTO crm_mail_sources SELECT (jsonb_populate_record(NULL::crm_mail_sources,$1::jsonb||jsonb_build_object('source_revision',3))).*",[JSON.stringify(original)]);
  expect(await read()).toEqual(erased);
 }finally{await database.drop();}
});
