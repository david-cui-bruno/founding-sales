import {randomUUID,createHash} from 'node:crypto';
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
},{
 name:'source69 retired human reply intent preserves denied expired approval without dispatch',fromVersions:[69],
 seed:async session=>{
  const row=(await session.query<{workspace_id:string;message_id:string;outbound_id:string;user_id:string;device_id:string;provider_thread_id:string;rfc_message_id:string;recipient_address:string;email_address:string}>(`SELECT m.workspace_id,m.id AS message_id,o.id AS outbound_id,f.assigned_user_id AS user_id,d.id AS device_id,m.provider_thread_id,m.rfc_message_id,o.recipient_address,b.email_address FROM mail_messages m JOIN outbound_messages o ON o.workspace_id=m.workspace_id AND o.mailbox_id=m.mailbox_id JOIN firms f ON f.workspace_id=o.workspace_id AND f.id=o.firm_id JOIN mailboxes b ON b.workspace_id=m.workspace_id AND b.id=m.mailbox_id JOIN devices d ON d.workspace_id=f.workspace_id AND d.user_id=f.assigned_user_id WHERE f.name='Fixture Holdings 01' AND m.direction='incoming' AND m.matched AND m.rfc_message_id IS NOT NULL AND o.state='sent' ORDER BY m.id,o.id,d.id LIMIT 1`)).rows[0];
  if(row===undefined)throw new Error('Source69 fixture lacks a sent fence and matched incoming receipt');
  await session.query(`INSERT INTO human_reply_send_intents(workspace_id,message_id,outbound_message_id,user_id,role,session_id,device_id,command_id,authorized,expires_at,source_revision,draft_revision,fact_refs,envelope,provider_thread_id,in_reply_to,reference_ids,author_address,refusal) VALUES($1,$2,$3,$4,'salesperson',$5,$6,$7,false,'2000-01-01T00:00:00Z',$8,$9,'[]',$10::jsonb,$11,$12,$13::jsonb,$14,'upgrade_fixture_retired')`,[row.workspace_id,row.message_id,row.outbound_id,row.user_id,randomUUID(),row.device_id,randomUUID(),'b'.repeat(64),'c'.repeat(64),JSON.stringify({to:[row.recipient_address],cc:[]}),row.provider_thread_id,row.rfc_message_id,JSON.stringify([row.rfc_message_id]),row.email_address]);
  return row.message_id;
 },
 verify:async(session,id)=>{
  const row=(await session.query<{authorized:boolean;revision:number;expires_at:Date;refusal:string;source_revision:string;draft_revision:string;state:string}>(`SELECT i.authorized,i.revision,i.expires_at,i.refusal,i.source_revision,i.draft_revision,o.state FROM human_reply_send_intents i JOIN outbound_messages o ON o.workspace_id=i.workspace_id AND o.id=i.outbound_message_id WHERE i.message_id=$1`,[id])).rows[0];
  return row!==undefined&&!row.authorized&&row.revision===1&&row.expires_at.toISOString()==='2000-01-01T00:00:00.000Z'&&row.refusal==='upgrade_fixture_retired'&&row.source_revision==='b'.repeat(64)&&row.draft_revision==='c'.repeat(64)&&row.state==='sent'?null:'Upgrade altered retired human reply authority or original sent fence';
 },
},{
 name:'source69 cancelled human meeting approval preserves bounded template and draft receipts',fromVersions:[69],
 seed:async session=>{
  const f=(await session.query<{workspace_id:string;id:string;assigned_user_id:string}>("SELECT workspace_id,id,assigned_user_id FROM firms WHERE name='Fixture Holdings 01' ORDER BY id LIMIT 1")).rows[0];
  if(f===undefined)throw new Error('Primary fixture firm missing');
  const template=(await session.query<{id:string;content_hash:string}>("SELECT id,content_hash FROM template_versions WHERE workspace_id=$1 AND approved_at IS NOT NULL AND retired_at IS NULL ORDER BY id LIMIT 1",[f.workspace_id])).rows[0];
  if(template===undefined)throw new Error('Existing approved template missing');
  const sequence=randomUUID(),version=randomUUID(),meeting=randomUUID(),plan=randomUUID();
  await session.query("INSERT INTO sequences(workspace_id,id,name,created_by_user_id) VALUES($1,$2,'Upgrade496 inert historical recap',$3)",[f.workspace_id,sequence,f.assigned_user_id]);
  await session.query('INSERT INTO sequence_versions(workspace_id,id,sequence_id,version) VALUES($1,$2,$3,1)',[f.workspace_id,version,sequence]);
  await session.query("INSERT INTO sequence_steps(workspace_id,sequence_version_id,ordinal,channel,delay_unit,delay_amount,template_version_id) VALUES($1,$2,1,'email','elapsed',0,$3)",[f.workspace_id,version,template.id]);
  await session.query("UPDATE sequence_versions SET state='published',published_at='2026-09-16T14:31:00Z',published_by_user_id=$3 WHERE workspace_id=$1 AND id=$2",[f.workspace_id,version,f.assigned_user_id]);
  await session.query("INSERT INTO meetings(workspace_id,id,booking_uid,current_booking_uid,firm_id,state,starts_at,ends_at,last_event_at) VALUES($1,$2,'upgrade496human','upgrade496human',$3,'ended','2026-09-16T14:00:00Z','2026-09-16T14:30:00Z','2026-09-16T14:30:00Z')",[f.workspace_id,meeting,f.id]);
  const subject='Historical fixture recap',body='Human edited synthetic meeting note.',hash=createHash('sha256').update(subject+'\n\n'+body).digest('hex');
  const approval={sourceHash:'d'.repeat(64),sequenceVersionId:version,templates:[{id:template.id,hash:template.content_hash}],draftHashes:{'1':hash},facts:[],at:'2026-09-16T14:31:00Z'};
  await session.query(`INSERT INTO meeting_follow_through(workspace_id,id,meeting_id,firm_id,owner_user_id,source_hash,notes_revision,sequence_version_id,status,version,current_draft_version,approval_mode,approval,fact_refs) VALUES($1,$2,$3,$4,$5,$6,0,$7,'cancelled',2,1,'human',$8::jsonb,'[]')`,[f.workspace_id,plan,meeting,f.id,f.assigned_user_id,'d'.repeat(64),version,JSON.stringify(approval)]);
  await session.query(`INSERT INTO meeting_follow_through_drafts(workspace_id,plan_id,version,ordinal,subject,body,rendered_hash,template_version_id,template_content_hash,source_hash,created_at,not_before,state,created_by_user_id) VALUES($1,$2,1,1,$3,$4,$5,$6,$7,$8,'2026-09-16T14:31:00Z','2026-09-16T14:31:00Z','cancelled',$9)`,[f.workspace_id,plan,subject,body,hash,template.id,template.content_hash,'d'.repeat(64),f.assigned_user_id]);
  return plan;
 },
 verify:async(session,id)=>{
  const row=(await session.query<{status:string;approval_mode:string;approval:{sourceHash:string;draftHashes:Record<string,string>};state:string;subject:string;body:string;rendered_hash:string;permission_id:string|null;enrollment_id:string|null;meeting_state:string}>(`SELECT p.status,p.approval_mode,p.approval,p.permission_id,p.enrollment_id,d.state,d.subject,d.body,d.rendered_hash,m.state AS meeting_state FROM meeting_follow_through p JOIN meeting_follow_through_drafts d ON d.workspace_id=p.workspace_id AND d.plan_id=p.id JOIN meetings m ON m.workspace_id=p.workspace_id AND m.id=p.meeting_id WHERE p.id=$1`,[id])).rows[0];
  const hash=createHash('sha256').update('Historical fixture recap\n\nHuman edited synthetic meeting note.').digest('hex');
  return row!==undefined&&row.status==='cancelled'&&row.state==='cancelled'&&row.approval_mode==='human'&&row.approval.sourceHash==='d'.repeat(64)&&row.approval.draftHashes['1']===hash&&row.rendered_hash===hash&&row.subject==='Historical fixture recap'&&row.body==='Human edited synthetic meeting note.'&&row.permission_id===null&&row.enrollment_id===null&&row.meeting_state==='ended'?null:'Upgrade changed historical approval bytes, inferred attendance or activated a cancelled recap';
 },
},{
 name:'source69 sender recovery and unresolved provider incident preserve cap and observation fence',fromVersions:[69],
 seed:async session=>{
  const box=(await session.query<{workspace_id:string;id:string;admin_user_id:string}>("SELECT b.workspace_id,b.id,wm.user_id AS admin_user_id FROM mailboxes b JOIN firms f ON f.workspace_id=b.workspace_id JOIN workspace_memberships wm ON wm.workspace_id=b.workspace_id AND wm.role='admin' WHERE f.name='Fixture Holdings 01' ORDER BY b.id,wm.user_id LIMIT 1")).rows[0];
  if(box===undefined)throw new Error('Source69 mailbox missing');
  const epoch=randomUUID(),incident=randomUUID();
  await session.query(`INSERT INTO mailbox_recovery_epochs(workspace_id,id,mailbox_id,activity_at,started_on,earned_cap,qualifying_days,stage_started_on) VALUES($1,$2,$3,'2026-09-01T14:00:00Z','2026-09-30',10,1,'2026-09-30')`,[box.workspace_id,epoch,box.id]);
  await session.query(`INSERT INTO mailbox_send_ramp(workspace_id,mailbox_id,admin_daily_cap,recovery_epoch_id,admin_changed_at,admin_changed_by_user_id) VALUES($1,$2,5,$3,'2026-09-30T15:00:00Z',$4) ON CONFLICT(workspace_id,mailbox_id) DO UPDATE SET admin_daily_cap=5,recovery_epoch_id=$3,admin_changed_at='2026-09-30T15:00:00Z',admin_changed_by_user_id=$4`,[box.workspace_id,box.id,epoch,box.admin_user_id]);
  await session.query(`INSERT INTO mailbox_provider_incidents(workspace_id,id,mailbox_id,source_kind,source_id,classification,reason,binding_sha256,observed_at,retry_at) VALUES($1,$2,$3,'sent_search','upgrade496:uncertain','unknown','unknown_sent_search',$4,'2026-09-30T15:00:00Z',NULL)`,[box.workspace_id,incident,box.id,'e'.repeat(64)]);
  return incident;
 },
 verify:async(session,id)=>{
  const row=(await session.query<{classification:string;reason:string;resolved_at:Date|null;retry_at:Date|null;earned_cap:number;qualifying_days:number;admin_daily_cap:number;activity_at:Date;binding_sha256:string}>(`SELECT i.classification,i.reason,i.resolved_at,i.retry_at,i.binding_sha256,r.admin_daily_cap,e.earned_cap,e.qualifying_days,e.activity_at FROM mailbox_provider_incidents i JOIN mailbox_send_ramp r ON r.workspace_id=i.workspace_id AND r.mailbox_id=i.mailbox_id JOIN mailbox_recovery_epochs e ON e.workspace_id=r.workspace_id AND e.id=r.recovery_epoch_id WHERE i.id=$1`,[id])).rows[0];
  return row!==undefined&&row.classification==='unknown'&&row.reason==='unknown_sent_search'&&row.resolved_at===null&&row.retry_at===null&&row.binding_sha256==='e'.repeat(64)&&row.admin_daily_cap===5&&row.earned_cap===10&&row.qualifying_days===1&&row.activity_at.toISOString()==='2026-09-01T14:00:00.000Z'?null:'Upgrade changed lower cap, recovery anchor or unresolved provider observation';
 },
}];
