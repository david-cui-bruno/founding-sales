import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {HeadSeed} from './headSeeds.ts';

const utterances=[{speaker:0,start:0,end:2,text:'Upgrade fixture maintenance note.'},{speaker:1,start:2,end:4,text:'Please document the routing issue.'}];
/** Historical synthetic rows use only the exact unreleased schema69 column shapes. */
export const SOURCE_69_SEEDS:readonly HeadSeed[]=[{
 name:'source69 existing native call transcript preserves speech and gains revision1',fromVersions:[69],
 seed:async session=>{
  const ticket=(await session.query<{workspace_id:string;id:string;firm_id:string;contact_id:string|null;actor_user_id:string;issued_at:Date;expires_at:Date;time_zone:string}>(`SELECT t.workspace_id,t.id,t.firm_id,t.contact_id,t.actor_user_id,t.issued_at,t.expires_at,f.time_zone FROM dial_tickets t JOIN firms f ON f.workspace_id=t.workspace_id AND f.id=t.firm_id WHERE f.name='Fixture Holdings 01' AND NOT EXISTS(SELECT 1 FROM call_sessions c WHERE c.workspace_id=t.workspace_id AND c.ticket_id=t.id) ORDER BY t.id LIMIT 1`)).rows[0];
  if(ticket===undefined)throw new Error('Source69 fixture lacks an unused primary-firm dial ticket');
  const id=randomUUID(),reservation=randomUUID();
  const before=(await session.query<{n:string}>('SELECT count(*) AS n FROM call_transcripts')).rows[0]!.n;
  await session.query(`INSERT INTO provider_reservations(workspace_id,id,provider_key,subject_kind,subject_id,attempt,business_date,business_time_zone,cents,model_name,max_input_tokens,max_output_tokens,priced_unit,max_units,unit_price_micros,state,settled_at) VALUES($1,$2,'upgrade_fixture','call_session',$3,1,($4::timestamptz AT TIME ZONE $5)::date,$5,0,NULL,NULL,NULL,'minute',1,0,'settled',$4::timestamptz+interval '30 seconds')`,[ticket.workspace_id,reservation,id,ticket.issued_at,ticket.time_zone]);
  await session.query(`INSERT INTO call_sessions(workspace_id,id,ticket_id,firm_id,contact_id,actor_user_id,reservation_id,status,provider_status,twilio_call_sid,expires_at,consumed_at,started_at,answered_at,ended_at,duration_seconds) VALUES($1,$2,$3,$4,$5,$6,$7,'completed','completed',$8,$9,$10,$10,$10::timestamptz+interval '1 second',$10::timestamptz+interval '30 seconds',30)`,[ticket.workspace_id,id,ticket.id,ticket.firm_id,ticket.contact_id,ticket.actor_user_id,reservation,'CA'+id.replaceAll('-',''),ticket.expires_at,ticket.issued_at]);
  await session.query(`INSERT INTO call_transcripts(workspace_id,call_session_id,provider,model,language,duration_seconds,utterances) VALUES($1,$2,'upgrade_fixture','fixture-v1','en',30,$3::jsonb)`,[ticket.workspace_id,id,JSON.stringify(utterances)]);
  const after=(await session.query<{n:string}>('SELECT count(*) AS n FROM call_transcripts')).rows[0]!.n;
  if(Number(after)!==Number(before)+1)throw new Error('Source69 transcript seed did not add exactly one real row');
  return id;
 },
 verify:async(session,id)=>{
  const row=(await session.query<{utterances:unknown;duration_seconds:number;crm_revision:number;status:string;settled_cents:number;cents:number}>(`SELECT t.utterances,t.duration_seconds,t.crm_revision,c.status,r.settled_cents,r.cents FROM call_transcripts t JOIN call_sessions c ON c.workspace_id=t.workspace_id AND c.id=t.call_session_id JOIN provider_reservations r ON r.workspace_id=c.workspace_id AND r.id=c.reservation_id WHERE t.call_session_id=$1`,[id])).rows[0];
  if(row===undefined||!isDeepStrictEqual(row.utterances,utterances)||row.duration_seconds!==30||row.crm_revision!==1||row.status!=='completed'||row.cents!==0||row.settled_cents!==0)return 'Source69 original speech, native association, revision or synthetic zero-cost receipt changed';
  const processing=(await session.query<{n:string}>("SELECT count(*) AS n FROM crm_extraction_generations WHERE source_kind='call_transcript' AND source_id=$1",[id])).rows[0]!.n;
  return processing==='0'?null:'Upgrade invented native transcript processing';
 },
}];
