import type {CrmProgressResponse} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {activeIdentityActor,lockIdentityContext} from './identityAccess.ts';
import {recordCrmAuditEvent} from './audit.ts';
/** Existing receipts only: a booking and a scheduled end never prove attendance. */
export async function readOperationalProgress(context:RepositoryContext,input:{firmId?:string|undefined;personId?:string|undefined;limit:number}):Promise<CrmProgressResponse['events']|null>{
 const actor=context.scope.actor;if(actor.kind!=='user'||!await activeIdentityActor(context))return null;
 const person=input.personId===undefined?null:(await context.db.query<{contact_id:string;firm_id:string}>('SELECT b.contact_id,c.firm_id FROM crm_legacy_contact_people b JOIN contacts c ON c.workspace_id=b.workspace_id AND c.id=b.contact_id WHERE b.workspace_id=$1 AND b.person_id=$2 AND c.status=\'active\'',[context.scope.workspaceId,input.personId])).rows[0];
 if(input.personId!==undefined&&!person)return [];
 const firmId=input.firmId??person?.firm_id;if(firmId===undefined||person&&person.firm_id!==firmId)return [];
 if(!await lockIdentityContext(context,{firmIds:[firmId],personIds:input.personId===undefined?[]:[input.personId]}))return null;
 const meetings=(await context.db.query<{id:string;kind:string;occurred_at:Date;meeting_id:string;state:'booked'|'rescheduled'|'cancelled'|'ended'|'held'|'no_show';attendance_source:string|null;attendance_confirmed_at:Date|null}>(`SELECT f.id,f.kind,f.occurred_at,m.id AS meeting_id,m.state,m.attendance_source,m.attendance_confirmed_at FROM meetings m JOIN funnel_facts f ON f.workspace_id=m.workspace_id AND f.firm_id=m.firm_id AND (f.dedupe_key=m.booking_uid OR f.dedupe_key=m.current_booking_uid OR EXISTS(SELECT 1 FROM meeting_booking_uids u WHERE u.workspace_id=m.workspace_id AND u.meeting_id=m.id AND u.booking_uid=f.dedupe_key)) WHERE m.workspace_id=$1 AND m.firm_id=$2 AND ($3::uuid IS NULL OR m.contact_id=$3) AND f.kind IN('meeting.booked','meeting.held') AND f.withdrawn_at IS NULL ORDER BY f.occurred_at,f.id LIMIT $4`,[context.scope.workspaceId,firmId,person?.contact_id??null,input.limit+1])).rows;
 if(!await activeIdentityActor(context))return null;
 if(actor.role==='admin'&&(await context.db.query('SELECT id FROM firms WHERE workspace_id=$1 AND id=$2 AND assigned_user_id IS DISTINCT FROM $3',[context.scope.workspaceId,firmId,actor.userId])).rows.length)await recordCrmAuditEvent(context,{action:'crm.progress_admin_read',subjectKind:'firm',subjectId:firmId,detail:{}});
 return meetings.flatMap(row=>{
  if(row.kind==='meeting.held'&&(row.state!=='held'||row.attendance_confirmed_at===null||!['manual','recording'].includes(row.attendance_source??'')))return [];
  const booked=row.kind==='meeting.booked';
  return [{id:row.id,kind:booked?'booked' as const:'attended' as const,occurredAt:row.occurred_at.toISOString(),dateBasis:booked?'receipt_observed' as const:'meeting_scheduled_start' as const,observedAt:booked?row.occurred_at.toISOString():row.attendance_confirmed_at!.toISOString(),bookingState:booked?row.state:null,firmIds:[firmId],personIds:input.personId===undefined?[]:[input.personId],source:null,evidence:{kind:booked?'meeting_booking' as const:'meeting_attendance' as const,id:row.meeting_id}}];
 });
}
