import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { dispatch } from '../src/server.ts';
import { createAuthFixture, type AuthFixture } from './support/authFixture.ts';
import { issueSessionFor } from './support/sessionFixture.ts';
import { seedFirm } from './support/crmSeed.ts';

async function seedCall(fixture: AuthFixture, firmId: string) {
  const ws=fixture.alpha.workspaceId,user=fixture.alpha.salesperson.userId;
  const callId = randomUUID();
  const route = (
    await fixture.db.query<{ id: string }>(
    "INSERT INTO phone_routes(workspace_id,firm_id,e164,source,retrieved_at,association_confidence,technical_validation,eligibility,eligibility_policy_version) VALUES($1,$2,'+14015550123','research_provider',now(),0.9,'passed','usable','route.1') RETURNING id",
    [ws, firmId],
    )
  ).rows[0]!.id;
  const identity = (
    await fixture.db.query<{ id: string }>(
    "INSERT INTO calling_identities(workspace_id,owner_user_id,e164,verification_status,enabled,verified_at,verified_by_user_id,verification_method) VALUES($1,$2,'+14015550124','verified',false,now(),$2,'owner_attestation') RETURNING id",
    [ws, user],
    )
  ).rows[0]!.id;
  const posture = (
    await fixture.db.query<{ id: string }>(
    "INSERT INTO state_postures(workspace_id,state,revision,effective_from,review_at,rules_revision,confirmed_statements,confirmed_by_user_id) VALUES($1,'RI',1,'2026-01-01','2027-01-01',2,ARRAY['businessToBusiness'],$2) RETURNING id",
    [ws, fixture.alpha.admin.userId],
    )
  ).rows[0]!.id;
  const device = (
    await fixture.db.query<{ id: string }>(
    "SELECT id FROM devices WHERE workspace_id=$1 AND user_id=$2 LIMIT 1",
    [ws, user],
    )
  ).rows[0]!.id;
  const ticket = (
    await fixture.db.query<{ id: string }>(
    "INSERT INTO dial_tickets(workspace_id,command_id,firm_id,phone_route_id,route_version,posture_id,posture_revision,calling_identity_id,actor_user_id,device_id,assigned_user_id,e164,firm_time_zone,expires_at) VALUES($1,'crm-call-fixture',$2,$3,1,$4,1,$5,$6,$7,$6,'+14015550123','America/New_York',now()+interval '30 seconds') RETURNING id",
    [ws, firmId, route, posture, identity, user, device],
    )
  ).rows[0]!.id;
  const reservation = (
    await fixture.db.query<{ id: string }>(
    "INSERT INTO provider_reservations(workspace_id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,'twilio.voice','call_session',$2,1,current_date,'America/New_York',0,NULL,NULL,NULL,'minute',1,0,'released',now()) RETURNING id",
    [ws, callId],
    )
  ).rows[0]!.id;
  await fixture.db.query(
    "INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,actor_user_id,reservation_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,now()+interval '30 seconds')",
    [ws, callId, ticket, firmId, user, reservation],
  );
  const utterances = [
    {
    speaker: 1,
    start: 0,
    end: 5,
    text: "Drainage coordination is needed.",
    },
  ];
  await fixture.db.query(
    "INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'aws_transcribe','standard','en-US',5,$3::jsonb)",
    [ws, callId, JSON.stringify(utterances)],
  );
  return callId;
}

async function seedMeeting(fixture: AuthFixture, firmId: string, owner: string) {
  const meetingId=randomUUID(),recordingId=randomUUID(),sourceId=randomUUID();
  await fixture.db.query("INSERT INTO meetings(workspace_id,id,firm_id,booking_uid,current_booking_uid,state,starts_at,ends_at,last_event_at) VALUES($1,$2,$3,$2::uuid::text,$2::uuid::text,'booked','2026-10-01T14:00:00Z','2026-10-01T14:20:00Z',now())",[fixture.alpha.workspaceId,meetingId,firmId]);
  await fixture.db.query("INSERT INTO meeting_recordings(workspace_id,id,meeting_id,segment,participant_label,sha256,size_bytes,s3_key,processing_status,crm_capture_owner_user_id) VALUES($1,$2,$3,1,'Controlled original',$4,100,$5,'ready',$6)",[fixture.alpha.workspaceId,recordingId,meetingId,'b'.repeat(64),`meetings/${meetingId}/${'b'.repeat(64)}.m4a`,owner]);
  const utterances=[{startMs:0,endMs:5000,text:'Meeting maintenance coordination.',speaker:'Speaker 1',attribution:'unknown'}];
  await fixture.db.query("INSERT INTO meeting_transcripts(workspace_id,id,recording_id,original_recording_id,version,duration_ms,language,utterances) VALUES($1,$2,$3,$3,1,5000,'en-US',$4::jsonb)",[fixture.alpha.workspaceId,sourceId,recordingId,JSON.stringify(utterances)]);
  return sourceId;
}

it('discovers owned native call and meeting copies under business scope without requiring a firm filter',async()=>{
 const fixture=await createAuthFixture();
 try {
  const token=(await issueSessionFor(fixture,fixture.alpha,fixture.alpha.salesperson)).accessToken;
  const post=(scope:object)=>dispatch({method:'POST',path:'/ask/read',body:{operation:'sources',scope,limit:50},query:new URLSearchParams(),headers:{authorization:`Bearer ${token}`}},{session:fixture.db,auth:fixture.deps,supportedClientVersions:fixture.deps.config.supportedClientVersions,sendingEnabled:false});
  const firmId=await seedFirm(fixture,{name:'Owned native business',regionCode:'RI',assignedUserId:fixture.alpha.salesperson.userId});
  const callId=await seedCall(fixture,firmId);
  const meetingId=await seedMeeting(fixture,firmId,fixture.alpha.salesperson.userId);
  const otherOwner=await seedMeeting(fixture,firmId,fixture.alpha.admin.userId);
  const privateFirm=await seedFirm(fixture,{name:'Private native business',assignedUserId:fixture.alpha.admin.userId});
  const otherFirm=await seedMeeting(fixture,privateFirm,fixture.alpha.salesperson.userId);
  for(const scope of [{business:true},{firmId}]) {
   const read=await post(scope);expect(read.status).toBe(200);
   expect(read.body).toMatchObject({sources:[{kind:'call_transcript',sourceId:callId,availability:'available'},{kind:'meeting_transcript',sourceId:meetingId,availability:'available'}],coverage:{scanComplete:true,sizeBoundReached:false}});
   expect(JSON.stringify(read.body)).not.toContain(otherOwner);expect(JSON.stringify(read.body)).not.toContain(otherFirm);
   expect(JSON.stringify(read.body)).not.toContain('Drainage coordination is needed.');expect(JSON.stringify(read.body)).not.toContain('Meeting maintenance coordination.');
  }
 } finally {await fixture.stop();}
});
