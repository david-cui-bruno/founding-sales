// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserVoicePreferences} from '../../src/client/BrowserVoicePreferences.tsx';
import {VoicePreferenceCustody,VOICE_PENDING_KEY} from '../../src/client/VoicePreferenceCustody.ts';
const id='10000000-0000-4000-8000-000000000001',guideId='20000000-0000-4000-8000-000000000002';
const prose='Prefer concise neutral sentences.';
const json=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
async function fixture(){
 vi.stubGlobal('crypto',webcrypto);let queue=Promise.resolve<unknown>(undefined);
 vi.stubGlobal('navigator',{locks:{request:(_name:string,_options:unknown,work:()=>Promise<unknown>)=>{const result=queue.then(work);queue=result.catch(()=>undefined);return result;}}});
 const now=Date.now(),session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()};
 let complete!:(value:Response)=>void;const response=new Promise<Response>(resolve=>{complete=resolve;});const commands:Record<string,unknown>[]=[],receipts:unknown[]=[],reads:unknown[]=[];let accepted=false,refused=false;
 let receiptResponse:Promise<Response>|null=null;
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  if(url==='/browser/api/social/voice-preferences/save'){commands.push(body);return response;}
  if(url==='/browser/api/social/voice-preferences/receipt'){receipts.push(body);if(receiptResponse)return receiptResponse;return json(accepted?{state:'accepted',result:{guideId,revision:1}}:refused?{state:'refused',reason:'stale_revision'}:{state:'unknown'});}
  if(url==='/browser/api/social/voice-preferences/read'){reads.push(body);return json({guide:accepted?{state:'available',guideId,revision:1,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString(),entries:[{entryId:id,dimension:'tone',guidance:prose}]}:{state:'absent'}});}
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID:()=>id});await client.refresh();
 const view=render(<BrowserVoicePreferences client={client}/>);
 fireEvent.click(screen.getByRole('button',{name:'Read private voice guide'}));await screen.findByRole('button',{name:'Add style preference'});fireEvent.click(screen.getByRole('button',{name:'Add style preference'}));fireEvent.change(screen.getByLabelText('Style guidance 1'),{target:{value:prose}});
 return {client,view,commands,receipts,reads,complete,holdReceipt:(value:Promise<Response>)=>{receiptResponse=value;},accept:()=>{accepted=true;},refuse:()=>{refused=true;}};
}
it('synchronous double-click dispatches one command with ID/hash custody persisted before network',async()=>{
 const f=await fixture();try{const button=screen.getByRole('button',{name:'Save private voice guide'});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(f.commands).toHaveLength(1));const held=localStorage.getItem(VOICE_PENDING_KEY)!;expect(held).not.toContain(prose);const pending=JSON.parse(held) as {commandId:string};expect(f.commands[0]?.['commandId']).toBe(pending.commandId);f.accept();await act(async()=>f.complete(json({status:'accepted',replayed:false,result:{guideId,revision:1}})));await screen.findByText('Voice command accepted at revision 1. Current guide freshly read.');expect(f.reads).toHaveLength(2);expect(localStorage.getItem(VOICE_PENDING_KEY)).toBeNull();}finally{f.client.dispose();}
});
it('reload loses prose and mounted retry but preserves unknown IDs-only hold, accepted reconciliation freshly reads',async()=>{
 const f=await fixture();try{fireEvent.click(screen.getByRole('button',{name:'Save private voice guide'}));await waitFor(()=>expect(f.commands).toHaveLength(1));const bytes=localStorage.getItem(VOICE_PENDING_KEY)!;const pending=JSON.parse(bytes) as {commandId:string;payloadSHA256:string};f.view.unmount();await act(async()=>f.complete(new Response('{}',{status:500})));render(<BrowserVoicePreferences client={f.client}/>);expect(screen.queryByLabelText('Style guidance 1')).toBeNull();expect(screen.queryByRole('button',{name:'Retry exact same voice command'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Reconcile same voice command'}));await screen.findByText(/Voice outcome UNKNOWN/u);expect(screen.getByRole('button',{name:'Read private voice guide'}).hasAttribute('disabled')).toBe(true);expect(f.receipts).toEqual([{commandId:pending.commandId,payloadSHA256:pending.payloadSHA256}]);expect(localStorage.getItem(VOICE_PENDING_KEY)).toBe(bytes);
 f.accept();fireEvent.click(screen.getByRole('button',{name:'Reconcile same voice command'}));await screen.findByText('Voice command accepted at revision 1. Current guide freshly read.');expect(f.commands).toHaveLength(1);expect(screen.getByLabelText('Style guidance 1')).toHaveProperty('value',prose);
 }finally{f.complete(json({status:'accepted',replayed:false,result:{guideId,revision:1}}));f.client.dispose();}
});
it('mounted explicit retry keeps exact UUID/payload, refusal releases custody without replaying replacement',async()=>{
 const f=await fixture();try{fireEvent.click(screen.getByRole('button',{name:'Save private voice guide'}));await waitFor(()=>expect(f.commands).toHaveLength(1));await act(async()=>f.complete(new Response('{}',{status:500})));await waitFor(()=>expect(screen.getByRole('button',{name:'Retry exact same voice command'}).hasAttribute('disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Retry exact same voice command'}));await waitFor(()=>expect(f.commands).toHaveLength(2));expect(f.commands[1]).toEqual(f.commands[0]);await waitFor(()=>expect(screen.getByRole('button',{name:'Reconcile same voice command'}).hasAttribute('disabled')).toBe(false));f.refuse();fireEvent.click(screen.getByRole('button',{name:'Reconcile same voice command'}));await screen.findByText(/Voice command refused: stale_revision/u);expect(localStorage.getItem(VOICE_PENDING_KEY)).toBeNull();expect(f.commands).toHaveLength(2);}finally{f.client.dispose();}
});
it('logout during reconciliation clears prose, releases busy ownership and fences late accepted read',async()=>{
 const f=await fixture();try{fireEvent.click(screen.getByRole('button',{name:'Save private voice guide'}));await waitFor(()=>expect(f.commands).toHaveLength(1));await act(async()=>{f.client.invalidate();});expect(screen.queryByLabelText('Style guidance 1')).toBeNull();await act(async()=>f.complete(json({status:'accepted',replayed:false,result:{guideId,revision:1}})));expect(screen.queryByLabelText('Style guidance 1')).toBeNull();expect(f.reads).toHaveLength(1);expect(localStorage.getItem(VOICE_PENDING_KEY)).toBeNull();expect(screen.getByRole('button',{name:'Read private voice guide'}).hasAttribute('disabled')).toBe(false);}finally{f.client.dispose();}
});
it('late receipt after logout cannot repopulate prose or strand reconciliation busy state',async()=>{
 const f=await fixture();let release!:(value:Response)=>void;try{
  fireEvent.click(screen.getByRole('button',{name:'Save private voice guide'}));await waitFor(()=>expect(f.commands).toHaveLength(1));await act(async()=>f.complete(new Response('{}',{status:500})));await waitFor(()=>expect(screen.getByRole('button',{name:'Reconcile same voice command'}).hasAttribute('disabled')).toBe(false));
  f.holdReceipt(new Promise<Response>(resolve=>{release=resolve;}));fireEvent.click(screen.getByRole('button',{name:'Reconcile same voice command'}));await waitFor(()=>expect(f.receipts).toHaveLength(1));await act(async()=>f.client.invalidate());expect(screen.queryByLabelText('Style guidance 1')).toBeNull();
  await act(async()=>release(json({state:'accepted',result:{guideId,revision:1}})));expect(f.reads).toHaveLength(1);await act(async()=>f.client.refresh());fireEvent.click(screen.getByRole('button',{name:'Read private voice guide'}));await screen.findByRole('button',{name:'Add style preference'});expect(f.reads).toHaveLength(2);expect(screen.getByRole('button',{name:'Read private voice guide'}).hasAttribute('disabled')).toBe(false);
 }finally{release?.(json({state:'unknown'}));f.client.dispose();}
});
it('custody corruption, expired unknown and unavailable storage fail closed before dispatch',async()=>{
 const f=await fixture();try{
  localStorage.setItem(VOICE_PENDING_KEY,'{}');const custody=new VoicePreferenceCustody(f.client);expect(()=>custody.read()).toThrow();
  localStorage.clear();const bad=new VoicePreferenceCustody(f.client,{getItem:()=>null,setItem:()=>{throw Error('unavailable');},removeItem:()=>{}});await expect(bad.prepare({operation:'create',entries:[{entryId:id,dimension:'tone',guidance:prose}]},()=>true)).rejects.toThrow();expect(f.commands).toHaveLength(0);
  const prepared=await custody.prepare({operation:'create',entries:[{entryId:id,dimension:'tone',guidance:prose}]},()=>true);localStorage.setItem(VOICE_PENDING_KEY,JSON.stringify({...prepared.held,expiresAt:new Date(0).toISOString()}));expect(()=>custody.read()).toThrow();expect(localStorage.getItem(VOICE_PENDING_KEY)).not.toBeNull();
 }finally{f.client.dispose();}
});
