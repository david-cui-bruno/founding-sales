import {randomUUID} from 'node:crypto';
import {expect,it} from 'vitest';
import {createAuthFixture,CURRENT_CLIENT_VERSION} from './support/authFixture.ts';
import {issueSessionFor} from './support/sessionFixture.ts';
import {seedFirm,seedContact} from './support/crmSeed.ts';
import {startIntegrationServer} from './support/integrationServer.ts';
import {upcoming} from './support/upcoming.ts';

// Frozen expectation: a signed booking is factual, attendance and a deal move
// require human decisions. Notes cannot silently approve or send a recap.
it('carries a signed controlled booking through opportunity, Today, brief and explicit attendance/outcome while follow-through remains paused',async()=>{
 const fixture=await createAuthFixture();const server=await startIntegrationServer(fixture);
 try{
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.admin)).accessToken;
  const command=(body:object)=>({...body,commandId:randomUUID(),clientVersion:CURRENT_CLIENT_VERSION});
  const request=async(method:'GET'|'POST',path:string,body?:unknown)=>{const response=await fetch(`${server.origin}${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json() as Record<string,unknown>};};
  const post=(path:string,body:unknown)=>request('POST',path,body);
  expect((await post('/settings/update',command({settingKey:'calendar_integration',value:{integration:'calcom'}}))).status).toBe(200);
  const firmId=await seedFirm(fixture,{name:'Controlled booking progress',assignedUserId:fixture.alpha.admin.userId});
  const contactId=await seedContact(fixture,{firmId,fullName:'Booking prospect'});
  expect((await post('/contacts/routes/add',command({firmId,contactId,routeKind:'email',value:'prospect@journey.example',source:'salesperson',technicalValidation:'passed',associationConfidence:0.95}))).status).toBe(200);
  const opened=await post('/opportunities/open',command({firmId}));expect(opened.status).toBe(200);
  const opportunityId=(opened.body['result'] as {id:string}).id;
  const uid=`controlled${randomUUID().replaceAll('-','')}`;
  const webhook=async(triggerEvent:string,startTime:string,endTime:string,eventAt:string)=>{const raw=JSON.stringify({triggerEvent,createdAt:eventAt,payload:{uid,startTime,endTime,organizer:{email:'david@usecallie.example'},attendees:[{email:'prospect@journey.example',name:'Booking prospect'}]}});const response=await fetch(`${server.origin}/integrations/calcom/webhook`,{method:'POST',headers:{'content-type':'application/json','x-cal-signature-256':server.calcomSign(Buffer.from(raw))},body:raw});return {status:response.status,body:await response.json()};};
  const booked=await webhook('BOOKING_CREATED',upcoming(3,15),upcoming(3,15,30),new Date().toISOString());
  expect(booked).toMatchObject({status:200,body:{outcome:'applied',meetingState:'booked'}});
  const meeting=(await fixture.db.query<{id:string}>('SELECT id FROM meetings WHERE workspace_id=$1 AND current_booking_uid=$2',[fixture.alpha.workspaceId,uid])).rows[0]!;
  const board=await post('/pipeline/board',{includeLost:false});expect(board.body).toMatchObject({cards:{[firmId]:{stageSuggestion:{stageKey:'demo_booked',opportunityId}}}});
  const brief=await request('GET',`/meetings/brief?meetingId=${meeting.id}&version=2`);expect(brief.status).toBe(200);
  expect(JSON.stringify(brief.body)).toContain(firmId);
  const today=await request('GET','/today/actions/v2');expect(today.status).toBe(200);expect(JSON.stringify(today.body)).toContain(meeting.id);
  expect((await request('GET',`/meetings/outcomes?meetingId=${meeting.id}`)).body).toMatchObject({attendance:'unconfirmed'});
  expect((await post('/opportunities/stage',command({opportunityId,toStageKey:'demo_booked',expectedStageKey:'new'}))).status).toBe(200);
  // A controlled reschedule places the event in the past; no external calendar write.
  const at=new Date(),start=new Date(at.getTime()-3600000).toISOString(),end=new Date(at.getTime()-1800000).toISOString();
  expect((await webhook('BOOKING_RESCHEDULED',start,end,new Date(at.getTime()+1000).toISOString())).status).toBe(200);
  expect((await post('/meetings/attendance',command({meetingId:meeting.id,attendance:'attended'}))).status).toBe(200);
  expect((await request('GET',`/meetings/outcomes?meetingId=${meeting.id}`)).body).toMatchObject({attendance:'attended'});
  expect((await post('/meetings/notes',command({meetingId:meeting.id,expectedRevision:0,debrief:'The prospect asked to receive the repair overview; no agreed purchase.',speakerMappings:[],itemOverrides:[],sufficient:true}))).status).toBe(200);
  const follow=await request('GET',`/meetings/follow-through?meetingId=${meeting.id}&version=2`);expect(follow.status).toBe(200);expect(follow.body).toMatchObject({sendingPaused:true,currentDraft:null,approvalRequired:false});
  const facts=(await fixture.db.query<{kind:string}>("SELECT kind FROM funnel_facts WHERE workspace_id=$1 AND kind IN ('meeting.booked','meeting.held') AND withdrawn_at IS NULL ORDER BY kind",[fixture.alpha.workspaceId])).rows;
  expect(facts.map(f=>f.kind)).toEqual(['meeting.booked','meeting.held']);
  expect((await fixture.db.query('SELECT id FROM outbound_messages WHERE workspace_id=$1',[fixture.alpha.workspaceId])).rows).toEqual([]);
 }finally{await server.close();await fixture.stop();}
});
