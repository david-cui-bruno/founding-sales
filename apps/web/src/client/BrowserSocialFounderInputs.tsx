import {useState,type JSX} from 'react';
import {z} from 'zod';
import {socialFounderInputListSchema,socialFounderInputSaveSchema,socialFounderInputViewSchema,type SocialFounderInputView} from '@fss/contracts';
import type {BrowserClient} from './BrowserClient.ts';
import {useFounderCommand} from './useFounderCommand.ts';
import {BrowserFounderGeneration} from './BrowserFounderGeneration.tsx';
export function BrowserSocialFounderInputs({client,onChanged}:{client:BrowserClient;onChanged?:()=>void}):JSX.Element{
 const [inputs,setInputs]=useState<SocialFounderInputView[]>([]),[selected,setSelected]=useState<SocialFounderInputView|null>(null),[bullets,setBullets]=useState(''),[context,setContext]=useState(''),[experienceDate,setExperienceDate]=useState(''),[publicSafe,setPublicSafe]=useState(false),[nextAfterId,setNextAfterId]=useState<string|null>(null);
 const clear=()=>{setInputs([]);setSelected(null);setBullets('');setContext('');setExperienceDate('');setPublicSafe(false);setNextAfterId(null);};
 const command=useFounderCommand(client,'input',clear);
 const read=(afterId?:string)=>command.run(async current=>{clear();const result=await client.request('/social/inputs/list',socialFounderInputListSchema,afterId?{afterId}:{},()=>{if(!current())throw Error('Authority changed');});if(current()){setInputs(result.inputs);setNextAfterId(result.nextAfterId);}});
 const choose=(input:SocialFounderInputView)=>command.run(async current=>{setSelected(null);setBullets('');setContext('');const result=await client.request('/social/inputs/read',z.strictObject({input:socialFounderInputViewSchema}),{inputId:input.inputId},()=>{if(!current())throw Error('Authority changed');});if(!current())return;setSelected(result.input);if(result.input.state==='available'){setBullets(result.input.bullets);setContext(result.input.context);setExperienceDate(result.input.experienceDate??'');setPublicSafe(result.input.publicSafe);}});
 const save=(remove=false)=>{const parsed=socialFounderInputSaveSchema.safeParse(remove&&selected?{operation:'remove',inputId:selected.inputId,expectedRevision:selected.revision}:{...(selected?{operation:'update',inputId:selected.inputId,expectedRevision:selected.revision}:{operation:'create'}),bullets,context,experienceDate:experienceDate||null,publicSafe});if(parsed.success)void command.send(parsed.data,()=>onChanged?.());};
 const valid=socialFounderInputSaveSchema.safeParse({operation:'create',bullets,context,experienceDate:experienceDate||null,publicSafe}).success;
 return <section aria-label="Founder updates">
  <h3>Updates</h3><p>Owner-private current bullets, retained at most 90 days from first save. Edits never renew expiry. Use for my posts designates these exact notes public-safe for generation and eligible plan use; it does not verify truth or publish anything. Include only real experiences and opinions. Product claims still need approved factual support.</p>
  <p role="status">{command.notice}</p><button disabled={command.disabled} onClick={()=>void read()}>Read updates</button>
  {nextAfterId?<button disabled={command.disabled} onClick={()=>void read(nextAfterId)}>Next updates page</button>:null}
  <button disabled={command.disabled} onClick={()=>{setSelected(null);setBullets('');setContext('');setExperienceDate('');setPublicSafe(false);}}>New update</button>
  {inputs.map(input=><button key={input.inputId} disabled={command.disabled} onClick={()=>void choose(input)}>Update {input.inputId.slice(0,8)} · revision {input.revision} · {input.state==='available'?(input.publicSafe?'eligible':'private'):input.reason}</button>)}
  {selected?<p>Expires {selected.expiresAt}; revision {selected.revision}</p>:null}
  <fieldset disabled={command.disabled||selected?.state==='unavailable'}>
   <label>Real bullets<textarea maxLength={10000} value={bullets} onChange={e=>setBullets(e.target.value)}/></label>
   <label>Topic or stance context<textarea maxLength={1000} value={context} onChange={e=>setContext(e.target.value)}/></label>
   <p>Combined bullets and context: at most 10,000 characters and 40,000 UTF8 bytes.</p>
   <label>Experience date (optional)<input type="date" value={experienceDate} onChange={e=>setExperienceDate(e.target.value)}/></label>
   <label><input type="checkbox" checked={publicSafe} onChange={e=>setPublicSafe(e.target.checked)}/>Use for my posts</label>
   <button disabled={!valid} onClick={()=>save()}>Save current update</button>
   {selected?<button onClick={()=>save(true)}>Remove update and dependent unsubmitted prose</button>:null}
  </fieldset>
  <BrowserFounderGeneration client={client} selected={selected} disabled={command.disabled} onChanged={onChanged}/>
  {command.pending?<button disabled={command.busy} onClick={()=>void command.reconcile()}>Reconcile same update command</button>:null}
 </section>;
}
