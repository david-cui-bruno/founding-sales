// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialFounderInputs} from '../../src/client/BrowserSocialFounderInputs.tsx';
import {FounderInputCustody} from '../../src/client/FounderInputCustody.ts';
const id='10000000-0000-4000-8000-000000000001',inputId='20000000-0000-4000-8000-000000000002',prose='Fictional owner-private college prototype notes.';
const json=(value:unknown)=>new Response(JSON.stringify(value));
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
async function fixture(){
 vi.stubGlobal('crypto',webcrypto);let queue=Promise.resolve<unknown>(undefined);
 vi.stubGlobal('navigator',{locks:{request:(_name:string,_options:unknown,work:()=>Promise<unknown>)=>{const result=queue.then(work);queue=result.catch(()=>undefined);return result;}}});
 const now=Date.now(),session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()};
 const {promise:response,resolve:complete}=Promise.withResolvers<Response>();let accepted=false;const commands:Record<string,unknown>[]=[],receipts:unknown[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);const body=JSON.parse(String(init?.body));
  if(url==='/browser/api/social/inputs/save'){commands.push(body);return response;}
  if(url==='/browser/api/social/founder/receipt'){receipts.push(body);return json(accepted?{state:'accepted',result:{inputId,revision:1}}:{state:'unknown'});}
  if(url==='/browser/api/social/inputs/list')return json({inputs:[],nextAfterId:null});
  throw Error('Unexpected route');
 });
 const client=new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID:()=>id});await client.refresh();const view=render(<BrowserSocialFounderInputs client={client}/>);fireEvent.change(screen.getByLabelText('Real bullets'),{target:{value:prose}});
 return {client,view,commands,receipts,complete,accept:()=>{accepted=true;}};
}
it('double click persists only opaque identity/hash before one current-input dispatch; no eligibility is inferred',async()=>{
 const f=await fixture();try{const button=screen.getByRole('button',{name:'Save current update'});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(f.commands).toHaveLength(1));expect(f.commands[0]?.['publicSafe']).toBe(false);const custody=new FounderInputCustody(f.client,'input'),held=custody.read();expect(held?.commandId).toBe(f.commands[0]?.['commandId']);expect(JSON.stringify(held)).not.toContain(prose);expect(localStorage.getItem(custody.binding()!.key)).not.toContain(prose);await act(async()=>f.complete(json({status:'accepted',replayed:false,result:{inputId,revision:1}})));await screen.findByText('Accepted. Read current state before further changes.');expect(screen.getByLabelText('Real bullets')).toHaveProperty('value','');}finally{f.client.dispose();}
});
it('lost response and navigation preserve UNKNOWN same-command custody without prose or replacement writes',async()=>{
 const f=await fixture();try{fireEvent.click(screen.getByRole('button',{name:'Save current update'}));await waitFor(()=>expect(f.commands).toHaveLength(1));const held=new FounderInputCustody(f.client,'input').read()!;f.view.unmount();await act(async()=>f.complete(new Response('{}',{status:500})));render(<BrowserSocialFounderInputs client={f.client}/>);expect(screen.getByLabelText('Real bullets')).toHaveProperty('value','');fireEvent.click(screen.getByRole('button',{name:'Reconcile same update command'}));await screen.findByText('UNKNOWN. Replacement commands remain blocked.');expect(f.receipts).toEqual([{kind:'input',commandId:held.commandId,payloadSHA256:held.payloadSHA256}]);expect(screen.getByRole('button',{name:'Save current update'}).hasAttribute('disabled')).toBe(true);f.accept();fireEvent.click(screen.getByRole('button',{name:'Reconcile same update command'}));await screen.findByText('Historical command accepted; explicitly read current state.');expect(f.commands).toHaveLength(1);}finally{f.client.dispose();}
});
it('logout fences late accepted response and clears private note projections and original opaque pointer',async()=>{
 const f=await fixture();try{fireEvent.click(screen.getByRole('button',{name:'Save current update'}));await waitFor(()=>expect(f.commands).toHaveLength(1));const key=new FounderInputCustody(f.client,'input').binding()!.key;await act(async()=>f.client.invalidate());expect(screen.getByLabelText('Real bullets')).toHaveProperty('value','');expect(localStorage.getItem(key)).toBeNull();await act(async()=>f.complete(json({status:'accepted',replayed:false,result:{inputId,revision:1}})));expect(screen.getByLabelText('Real bullets')).toHaveProperty('value','');expect(screen.queryByText('Accepted. Read current state before further changes.')).toBeNull();}finally{f.client.dispose();}
});
it('post-lock authority change refuses before work, and corrupted custody fails closed',async()=>{
 const f=await fixture();try{
  const custody=new FounderInputCustody(f.client,'input'),key=custody.binding()!.key;localStorage.setItem(key,'{}');expect(()=>custody.read()).toThrow();localStorage.removeItem(key);
  const held=Promise.withResolvers<void>(),started=Promise.withResolvers<void>();
  const first=custody.exclusive(()=>{started.resolve();return held.promise;});await started.promise;
  let calls=0;const second=custody.exclusive(async()=>{calls++;});const refused=expect(second).rejects.toThrow('Authority changed');
  await act(async()=>f.client.invalidate());held.resolve();await first;await refused;expect(calls).toBe(0);
 }finally{f.client.dispose();}
});
