import {useEffect,useRef,useState} from 'react';
import type {SocialConnection} from '@fss/contracts';
export interface ManualDestinationPorts {register(input:SocialConnection&{commandId:string}):Promise<{accepted:boolean;reason:string|null}>}
const reasons:Record<string,string>={destination_already_connected:'Use the existing connected destination. Manual registration cannot replace it.',account_already_registered:'This identity is already recorded. Select its existing destination.',account_identity_changed:'This saved destination has a different identity.',facebook_page_required:'A Facebook Page is required.',account_limit:'The destination limit has been reached.'};

/** A human-supplied label/identity is not an observed login or provider grant. */
export function ManualSocialDestination({ports,onAdded}:{ports:ManualDestinationPorts;onAdded:(accountId:string)=>void}){
 const [platform,setPlatform]=useState<SocialConnection['platform']>('x'),[externalId,setExternalId]=useState(''),[displayName,setDisplayName]=useState(''),[reviewed,setReviewed]=useState(false),[busy,setBusy]=useState(false),[pending,setPending]=useState<(SocialConnection&{commandId:string})|null>(null),[message,setMessage]=useState<string|null>(null);
 const live=useRef(true);useEffect(()=>{live.current=true;return()=>{live.current=false;};},[]);
 const submit=async()=>{if(busy)return;const input=pending??{accountId:crypto.randomUUID(),commandId:crypto.randomUUID(),platform,externalId:externalId.trim(),displayName:displayName.trim(),accountKind:platform==='facebook'?'page' as const:'profile' as const};setBusy(true);setPending(input);setMessage(null);
  try{const answer=await ports.register(input);if(!live.current)return;if(answer.accepted){setPending(null);setExternalId('');setDisplayName('');setReviewed(false);setMessage('Manual destination recorded. Provider access remains unverified.');onAdded(input.accountId);}else if(['offline','unreadable_answer'].includes(answer.reason??'')){setMessage('No definite answer. Retry the same registration.');}else{setPending(null);setMessage(reasons[answer.reason??'']??'Could not record this destination. Review its identity.');}}
  catch{if(live.current)setMessage('No definite answer. Retry the same registration.');}finally{if(live.current)setBusy(false);}
 };
 return <section aria-label='Manual social destination' className='space-y-3 rounded-md border p-4'>
  <h3>Add a manual destination</h3><p>Record an account or Page you reviewed. Callie will not connect provider access or publish anything.</p>
  <label>Manual destination platform<select aria-label='Manual destination platform' value={platform} disabled={busy||pending!==null} onChange={event=>{setPlatform(event.target.value as SocialConnection['platform']);setReviewed(false);}}><option value='x'>X profile</option><option value='facebook'>Facebook Page</option><option value='linkedin'>LinkedIn profile</option></select></label>
  <label>Account or Page identity<input aria-label='Account or Page identity' maxLength={300} value={externalId} disabled={busy||pending!==null} onChange={event=>{setExternalId(event.target.value);setReviewed(false);}}/></label>
  <label>Destination label<input aria-label='Destination label' maxLength={200} value={displayName} disabled={busy||pending!==null} onChange={event=>{setDisplayName(event.target.value);setReviewed(false);}}/></label>
  <label><input type='checkbox' checked={reviewed} disabled={busy||pending!==null} onChange={event=>setReviewed(event.target.checked)}/>I reviewed this destination identity. This does not connect or verify provider access.</label>
  <button disabled={busy||(!pending&&(!reviewed||!externalId.trim()||!displayName.trim()))} onClick={()=>void submit()}>{pending?'Retry same registration':'Add manual destination'}</button>
  {message&&<p role='status'>{message}</p>}
 </section>;
}
