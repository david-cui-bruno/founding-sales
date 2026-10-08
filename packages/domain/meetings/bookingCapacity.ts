import type {BookingCapacityResponse,BookingCapacityReason} from '@fss/contracts';
import type {RepositoryContext} from '../db/workspaceScope.ts';
import {readCalendarIntegration,workspacesWithIntegration} from '../settings/integrations.ts';
import {readRoutineSettings} from '../outreach/settings.ts';
export interface CalcomCapacityClient {
  readProfile():Promise<unknown>;
  readEventTypes(input:{username:string;eventSlug:string}):Promise<readonly unknown[]>;
}
export async function readBookingCapacity(ctx:RepositoryContext,options:{client:CalcomCapacityClient|null;missingKeyReason?:'api_key_missing'|'api_key_invalid';now:string}):Promise<BookingCapacityResponse> {
  const settings=await readRoutineSettings(ctx),bookingUrl=settings.bookingUrl;
  const routing=await workspacesWithIntegration(ctx.db,{key:'calendar_integration',value:'calcom'});
  let reason:BookingCapacityReason=options.missingKeyReason??'api_key_missing';
  if(await readCalendarIntegration(ctx)!=='calcom')reason='integration_off';
  else if(routing.length!==1||routing[0]!==ctx.scope.workspaceId)reason='routing_ambiguous';
  else if(bookingUrl===null)reason='booking_link_missing';
  const day=86400000,now=Date.parse(options.now);
  const result:BookingCapacityResponse={
    preference:{weeklyIntroCalls:3,enforcementVerified:false},
    provider:{status:'unavailable',reason,observedAt:null,bookingUrl,eventTypeId:null,weeklyLimit:null,scope:'event_type'},
    recorded:{observedAt:options.now,windowStart:new Date(now-7*day).toISOString(),windowEnd:new Date(now+60*day).toISOString(),truncated:false,bookings:[]},
  };
  const actor=ctx.scope.actor;
  const rows=(await ctx.db.query<{id:string;state:string;starts_at:Date;ends_at:Date;last_event_at:Date;firm_id:string|null;firm_name:string|null;attendee_email:string|null;match_reason:'firm_unmatched'|'firm_ambiguous'|null}>(`
    SELECT m.id,m.state,m.starts_at,m.ends_at,m.last_event_at,m.firm_id,f.name AS firm_name,
      CASE WHEN $4::boolean OR f.assigned_user_id=$5::uuid THEN m.attendee_email ELSE NULL END AS attendee_email,
      r.reason AS match_reason
    FROM meetings m LEFT JOIN firms f ON f.workspace_id=m.workspace_id AND f.id=m.firm_id
    LEFT JOIN LATERAL(SELECT reason FROM stage_review_items r WHERE r.workspace_id=m.workspace_id AND r.resolved_at IS NULL
      AND r.reason IN ('firm_unmatched','firm_ambiguous') AND (
        (r.evidence_kind='meeting.booked' AND r.evidence_id=m.id::text)
        OR (r.evidence_kind='meeting.attendee_conflict' AND m.id::text=ANY(string_to_array(r.detail->>'meetingIds',',')))
      ) ORDER BY r.created_at DESC,r.id DESC LIMIT 1) r ON true
    WHERE m.workspace_id=$1 AND (m.firm_id IS NULL OR $4::boolean OR f.assigned_user_id=$5::uuid) AND m.starts_at>=$2::timestamptz AND m.starts_at<$3::timestamptz
    ORDER BY m.starts_at,m.id LIMIT 51`,[ctx.scope.workspaceId,result.recorded.windowStart,result.recorded.windowEnd,actor.kind==='system'||actor.role==='admin',actor.kind==='user'?actor.userId:null])).rows;
  result.recorded.truncated=rows.length>50;
  result.recorded.bookings=rows.slice(0,50).map(row=>({meetingId:row.id,state:row.state,startsAt:row.starts_at.toISOString(),endsAt:row.ends_at.toISOString(),sourceUpdatedAt:row.last_event_at.toISOString(),firm:row.firm_id===null||row.firm_name===null?null:{id:row.firm_id,name:row.firm_name},attendeeEmail:row.attendee_email,matchReason:row.match_reason}));
  if(reason!=='api_key_missing'||options.client===null)return result;
  try {
  const url=new URL(bookingUrl!);
  const path=url.pathname.split('/').filter(Boolean),[username,eventSlug]=path;
  if(url.protocol!=='https:'||url.hostname!=='cal.com'||url.port!==''||url.username!==''||url.password!==''||url.search!==''||url.hash!==''||path.length!==2||username===undefined||eventSlug===undefined||!/^[-a-zA-Z0-9_]+$/u.test(username)||!/^[-a-zA-Z0-9_]+$/u.test(eventSlug)||username==='team'){result.provider.reason='booking_link_unsupported';return result;}
  const profile=record(await options.client.readProfile());
  if(!positiveInteger(profile['id'])){result.provider.reason='provider_invalid_response';return result;}
  if(profile['username']!==username){result.provider.reason='account_mismatch';return result;}
  const events=await options.client.readEventTypes({username,eventSlug});
  if(events.length===0){result.provider.reason='event_not_found';return result;}
  if(events.length>1){result.provider.reason='event_ambiguous';return result;}
  const event=record(events[0]);
  if(events.length===1&&!positiveInteger(event['id'])){result.provider.reason='provider_invalid_response';return result;}
  if(event['slug']!==eventSlug||event['ownerId']!==profile['id']||event['bookingUrl']!==bookingUrl){result.provider.reason='event_mismatch';return result;}
  const current=await readRoutineSettings(ctx);
  const currentRouting=await workspacesWithIntegration(ctx.db,{key:'calendar_integration',value:'calcom'});
  if(current.revision!==settings.revision||current.bookingUrl!==bookingUrl||await readCalendarIntegration(ctx)!=='calcom'||currentRouting.length!==1||currentRouting[0]!==ctx.scope.workspaceId){result.provider.reason='configuration_changed';return result;}
  const limits=record(event['bookingLimitsCount']);
  if(limits['week']!==undefined&&limits['week']!==null&&!positiveInteger(limits['week'])){result.provider.reason='provider_invalid_response';return result;}
  result.provider={status:'observed',reason:null,observedAt:options.now,bookingUrl,eventTypeId:Number(event['id']),weeklyLimit:typeof limits['week']==='number'?limits['week']:null,scope:'event_type'};
  return result;
  } catch(error) {
    const known:readonly BookingCapacityReason[]=['provider_unauthorized','provider_forbidden','provider_unreachable','provider_rate_limited','provider_invalid_response'];
    const code=error instanceof Error?error.message:'';
    result.provider.reason=known.includes(code as BookingCapacityReason)?code as BookingCapacityReason:'provider_unreachable';
    return result;
  }
}
const record=(value:unknown):Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:{};

const positiveInteger=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0;
