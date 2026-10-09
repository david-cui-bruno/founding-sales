import {useEffect,useState,type JSX} from 'react';
import type {CrmProgressResponse} from '@fss/contracts';
import {operations} from '../app/bridges.ts';
export interface ProgressPorts{read(input:{firmId?:string;personId?:string;limit:number}):Promise<CrmProgressResponse>}
const nativePorts:ProgressPorts={read:async input=>{const api=operations();if(!api)throw new Error('unavailable');return await api.read('crm.progressRead',input);}};
const dateLabels={provider_event:'Provider date',receipt_observed:'Recorded',meeting_scheduled_start:'Scheduled meeting start'};
const labels={contacted:'Contacted',replied:'Replied',booked:'Booked',attended:'Attended',opted_out:'Opted out'};
/** Verified evidence is distinct from a human-controlled sales stage. */
export function RecordProgress({firmId,personId,privacyKey,sourceVersion=0,enabled,ports=nativePorts}:{firmId?:string;personId?:string;privacyKey:string;sourceVersion?:number|undefined;enabled:boolean;ports?:ProgressPorts}):JSX.Element|null{
 const key=`${privacyKey}:${firmId??''}:${personId??''}:${sourceVersion}:${enabled}`;
 const [view,setView]=useState<{key:string;page:CrmProgressResponse|null;error:boolean}|null>(null);
 useEffect(()=>{let current=true;setView(null);if(enabled)void ports.read({...(firmId===undefined?{}:{firmId}),...(personId===undefined?{}:{personId}),limit:50}).then(page=>{if(current)setView({key,page,error:false});}).catch(()=>{if(current)setView({key,page:null,error:true});});return()=>{current=false;};},[key,ports,enabled,firmId,personId]);
 if(!enabled||view?.key!==key)return null;
 if(view.error)return <p>Progress could not be loaded.</p>;
 if(view.page===null||view.page.events.length===0)return null;
 return <section aria-label="Verified progress"><h3>Verified progress</h3>{view.page.events.map(event=><p key={event.id}><strong>{labels[event.kind]}</strong>{event.bookingState==='cancelled'?' · cancelled':null} <span>{dateLabels[event.dateBasis]}</span> <time dateTime={event.occurredAt}>{new Date(event.occurredAt).toLocaleString()}</time></p>)}<p>Some conversations may not be available yet.</p>{view.page.truncated&&<p>Showing the first 50 events.</p>}</section>;
}
