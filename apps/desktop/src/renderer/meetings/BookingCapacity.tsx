import {useCallback,useEffect,useRef,useState,type JSX} from 'react';
import type {BookingCapacityResponse,BookingCapacityReason} from '@fss/contracts';
import {Row,RowMain,RowActions,Rows,Section} from '../ui/layout.tsx';
import {Button} from '../ui/button.tsx';
import {shortDayTime} from '../dates.ts';
import {meetingRowWord} from './meetingText.ts';
export interface BookingCapacityPorts {read():Promise<{readonly capacity:BookingCapacityResponse|null}>}
const MISSING_EVIDENCE:Readonly<Record<BookingCapacityReason,string>>={
  integration_off:'The Cal.com connection is turned off.',
  routing_ambiguous:'The calendar connection cannot be associated with this workspace.',
  booking_link_missing:'Save your approved Cal.com booking link to check its settings.',
  booking_link_unsupported:'This booking link needs a verified calendar access path before capacity can be checked.',
  api_key_missing:'Calendar access is missing. Connect the existing calendar access to verify this setting.',
  api_key_invalid:'Calendar access is not valid. Reconnect the existing calendar access.',
  provider_unauthorized:'Cal.com did not authenticate the existing calendar access.',
  provider_forbidden:'Cal.com did not allow this settings read. Existing permissions need verification.',
  provider_unreachable:'Cal.com could not be reached. Refresh booking evidence when it is available.',
  provider_rate_limited:'Cal.com temporarily limited these reads. Check again later.',
  provider_invalid_response:'Cal.com did not return complete capacity settings.',
  account_mismatch:'Calendar access belongs to a different booking-link account.',
  event_not_found:'No Cal.com event matched the approved booking link.',
  event_ambiguous:'More than one Cal.com event matched. Capacity remains unverified.',
  event_mismatch:'The Cal.com event does not match the approved booking link and account.',
  configuration_changed:'Booking settings changed during this check. Refresh booking evidence.',
};
export function BookingCapacity({ports,onOpenFirm}:{readonly ports:BookingCapacityPorts|null;readonly onOpenFirm?:(firmId:string)=>void}):JSX.Element {
  const [capacity,setCapacity]=useState<BookingCapacityResponse|null|undefined>(undefined);
  const [busy,setBusy]=useState(false),readNo=useRef(0);
  const load=useCallback(async()=>{
    const current=++readNo.current;setBusy(true);setCapacity(undefined);
    try {const answer=await ports?.read();if(current===readNo.current){setCapacity(answer?.capacity??null);setBusy(false);}}
    catch {if(current===readNo.current){setCapacity(null);setBusy(false);}}
  },[ports]);
  const invalidatePendingRead=useCallback(()=>{readNo.current++;},[]);
  useEffect(()=>{void load();return invalidatePendingRead;},[load,invalidatePendingRead]);
  return <Section title="Booking capacity" data-testid="booking-capacity" actions={<Button variant="quiet" size="sm" aria-label="Refresh booking evidence" disabled={busy||ports===null} onClick={()=>{void load();}}>Refresh</Button>}>
    <p className="text-sm" data-testid="booking-capacity-preference">Three introductory calls per week is a preference; enforcement is not verified.</p>
    <p className="text-sm text-muted-foreground" data-testid="booking-capacity-provider">{capacity===undefined?'Reading booking evidence…':capacity===null?'Callie could not read booking evidence.':capacity.provider.status==='observed'?capacity.provider.weeklyLimit===null?'No weekly limit was verified for this booking link.':`Cal.com currently limits this booking link to ${capacity.provider.weeklyLimit} bookings per week. Other event types aren’t covered by this setting.`:capacity.provider.reason===null?'Cal.com configuration is not verified.':MISSING_EVIDENCE[capacity.provider.reason]}</p>
    {capacity===undefined||capacity===null?null:<>
      <p className="mt-3 text-xs text-muted-foreground">Saved booking records. Cal.com owns available times and appointment changes.</p>
      {capacity.recorded.bookings.length===0?<p className="text-sm text-muted-foreground">No saved bookings in this window.</p>:<Rows>{capacity.recorded.bookings.map(booking=><Row key={booking.meetingId} data-testid="booking-capacity-record">
        <RowMain line={<span>{booking.firm?.name??booking.attendeeEmail??'Attendee to match'} · {shortDayTime(booking.startsAt)}</span>} detail={<span className="flex flex-col"><span>{meetingRowWord(booking.state)}{booking.matchReason==='firm_ambiguous'?' · More than one firm could match':booking.matchReason==='firm_unmatched'?' · Firm not matched':''}</span><span data-testid="booking-capacity-source">Cal.com update {shortDayTime(booking.sourceUpdatedAt)}</span></span>}/>
        {booking.firm===null||onOpenFirm===undefined?null:<RowActions><Button variant="quiet" size="sm" aria-label={`Open ${booking.firm.name}`} onClick={()=>{if(booking.firm!==null)onOpenFirm(booking.firm.id);}}>Open firm</Button></RowActions>}
      </Row>)}</Rows>}
      {capacity.recorded.truncated?<p className="text-xs text-muted-foreground">Showing the first 50 saved bookings in this window.</p>:null}
    </>}
  </Section>;
}
