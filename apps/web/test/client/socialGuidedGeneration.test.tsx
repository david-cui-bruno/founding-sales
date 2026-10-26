// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {socialDraftRequestCommandSchema,type SocialDraftWorkspace,type SocialDraftView,type SocialVoiceGuide} from '@fss/contracts';
import {payloadHashOf} from '../../../api/src/auth/tokens.ts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialGeneration} from '../../src/client/BrowserSocialGeneration.tsx';
import {BrowserSocialReview} from '../../src/client/BrowserSocialReview.tsx';
import {SocialGenerationCustody} from '../../src/client/SocialGenerationPending.ts';
import {guidedSocialSelection,revalidateSocialSelection} from '../../src/client/SocialGenerationDispatch.ts';
const id='10000000-0000-4000-8000-000000000001',other='20000000-0000-4000-8000-000000000002';
const guide:Extract<SocialVoiceGuide,{state:'available'}>={state:'available',guideId:id,revision:1,entries:[{entryId:id,dimension:'tone',guidance:'Neutral private style.'}],createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z'};
const workspace:SocialDraftWorkspace={sources:[{kind:'call',id,revision:1,label:'Never eligible raw call',observedAt:'2026-10-26T00:00:00.000Z'}],facts:[{id,version:1,text:'A bounded local workspace is planned.',socialInput:{topic:'build',status:'planned',sanitized:true}},{id:other,version:1,text:'Untagged fact never selectable'}],requests:[]};
const request:SocialDraftView={id,state:'ready',mode:'linkedin_grounded',voiceGuideRef:{guideId:id,revision:1},sourceRefs:[],factBlocks:[{id,version:1}],concepts:[{theme:'build',factRefs:[{id,version:1}],variants:[{platform:'linkedin',text:'Controlled ready suggestion.'}]}],reason:null,createdAt:'2026-10-26T00:00:00.000Z',deadlineAt:new Date(Date.now()+600000).toISOString()};
const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>{resolve=yes;});return {resolve,promise};}
function lockManager(){const tails=new Map<string,Promise<unknown>>();return {request:vi.fn((name:string,_options:unknown,work:()=>Promise<unknown>)=>{const before=tails.get(name)??Promise.resolve(),next=before.catch(()=>{}).then(work);tails.set(name,next);return next;})};}
function setup(){
 let voice:SocialVoiceGuide=guide,facts=workspace,receipt:unknown={state:'unknown'},send:()=>Promise<Response>=async()=>json({status:'accepted',replayed:false,result:{requestId:id}}),detail:()=>Promise<Response>=async()=>json({request});
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'social-guided-session',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(async(path,init)=>{
  if(path==='/browser/session')return json(session);
  const body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;calls.push({path:String(path),body});
  if(path==='/browser/api/social/drafts')return json(facts);
  if(path==='/browser/api/social/voice-preferences/read')return json({guide:voice});
  if(path==='/browser/api/social/drafts/request')return send();
  if(path==='/browser/api/social/drafts/request/receipt')return json(receipt);
  if(path==='/browser/api/social/drafts/read')return detail();
  if(path==='/browser/api/social/private-drafts/list')return json({drafts:[],nextAfterId:null});
  throw Error('Unexpected route');
 });
 const storage={getItem:(key:string)=>localStorage.getItem(key),setItem:(key:string,value:string)=>localStorage.setItem(key,value),removeItem:(key:string)=>localStorage.removeItem(key)};
 const makeClient=()=>new BrowserClient({fetch,storage,navigate:vi.fn(),randomUUID:()=>id});
 return {client:makeClient(),makeClient,calls,storage,voice:(value:SocialVoiceGuide)=>{voice=value;},facts:(value:SocialDraftWorkspace)=>{facts=value;},receipt:(value:unknown)=>{receipt=value;},send:(value:()=>Promise<Response>)=>{send=value;},detail:(value:()=>Promise<Response>)=>{detail=value;},change:(patch:Partial<typeof session>)=>{session={...session,...patch};}};
}
async function mount(s:ReturnType<typeof setup>){await s.client.refresh();const onCurrentRequest=vi.fn();const view=render(<BrowserSocialGeneration client={s.client} onCurrentRequest={onCurrentRequest}/>);return {...view,onCurrentRequest};}
const button=(name:string)=>screen.getByRole('button',{name});
async function select(){fireEvent.click(button('Read current generation inputs'));await screen.findByRole('checkbox',{name:/Use saved voice guide/u});fireEvent.click(screen.getByRole('checkbox',{name:/Use saved voice guide/u}));fireEvent.click(screen.getByRole('checkbox',{name:/A bounded local workspace/u}));}
beforeEach(()=>{localStorage.clear();vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{value:lockManager(),configurable:true});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
it('requires explicit exact guide and approved facts, sends no prose/clientVersion, and reads accepted ID before showing ready selection',async()=>{
 const s=setup(),v=await mount(s);expect(button('Request guided social suggestion')).toHaveProperty('disabled',true);await select();expect(screen.queryByRole('checkbox',{name:/Untagged/u})).toBeNull();fireEvent.click(button('Request guided social suggestion'));
 await waitFor(()=>expect(v.onCurrentRequest).toHaveBeenCalledWith(request));
 const commands=s.calls.filter(call=>call.path.endsWith('/request'));expect(commands).toHaveLength(1);expect(commands[0]!.body).toEqual({mode:'linkedin_grounded',voiceGuideRef:{guideId:id,revision:1},sourceRefs:[],factBlocks:[{id,version:1}],commandId:expect.any(String)});
 expect(s.calls.map(call=>call.path)).toEqual(['/browser/api/social/drafts','/browser/api/social/voice-preferences/read','/browser/api/social/drafts','/browser/api/social/voice-preferences/read','/browser/api/social/drafts/request','/browser/api/social/drafts/read']);
 expect(JSON.stringify({...localStorage})).not.toMatch(/Neutral private|workspace is planned|Controlled ready/u);expect(s.calls.some(call=>call.path.includes('save'))).toBe(false);s.client.dispose();
});
it.each(['guide','fact','guideRemoved','factLost'] as const)('fresh %s change refuses without remint or silent upgrade',async mode=>{
 const s=setup();await mount(s);await select();
 if(mode==='guide')s.voice({...guide,revision:2});if(mode==='guideRemoved')s.voice({state:'removed',guideId:id,revision:2,removedAt:'2026-10-26T00:00:00.000Z',createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z'});
 if(mode==='fact')s.facts({...workspace,facts:[{...workspace.facts[0]!,version:2}]});if(mode==='factLost')s.facts({...workspace,facts:[]});
 fireEvent.click(button('Request guided social suggestion'));await screen.findByText(/Selection changed, access refused/u);expect(s.calls.some(call=>call.path.endsWith('/request'))).toBe(false);expect(localStorage.length).toBe(0);s.client.dispose();
});
it('canonical fingerprint equals actual parsed gateway payloadHashOf and derives only matching selected public refs',async()=>{
 const s=setup();await s.client.refresh();const fact={...workspace.facts[0]!,socialInput:{...workspace.facts[0]!.socialInput!,sourceRef:{kind:'public' as const,id:other,revision:4,url:'https://public.example.test/original',checkedAt:'2026-10-26T00:00:00.000Z'}}};
 const selection={guide,facts:[fact]},input=guidedSocialSelection(selection);expect(input.sourceRefs).toEqual([{kind:'public',id:other,revision:4}]);
 expect(()=>guidedSocialSelection({guide,facts:[workspace.facts[1]!]})).toThrow();expect(()=>revalidateSocialSelection(selection,workspace,guide)).toThrow();
 const custody=new SocialGenerationCustody(s.client,s.storage),prepared=await custody.exclusive(()=>custody.prepare(input,()=>true));
 const {commandId:_id,clientVersion:_version,...payload}=socialDraftRequestCommandSchema.parse({...prepared.payload,commandId:prepared.held.commandId,clientVersion:'1.4.0'});
 expect(prepared.held.payloadSHA256).toBe(payloadHashOf(payload));expect(JSON.stringify({...localStorage})).not.toContain(fact.text);s.client.dispose();
});
it('two-tab response loss plus lock release never remints, UNKNOWN and navigation preserve shared opaque custody',async()=>{
 const s=setup(),v=await mount(s);await select();s.send(async()=>{throw Error('Lost response');});fireEvent.click(button('Request guided social suggestion'));await screen.findByRole('button',{name:'Reconcile guided request receipt'});await waitFor(()=>expect(button('Reconcile guided request receipt')).toHaveProperty('disabled',false));const original=JSON.stringify({...localStorage});v.unmount();
 const next=s.makeClient();await next.refresh();const otherView=render(<BrowserSocialGeneration client={next} onCurrentRequest={vi.fn()}/>);expect(button('Request guided social suggestion')).toHaveProperty('disabled',true);fireEvent.click(button('Reconcile guided request receipt'));await screen.findByText(/outcome UNKNOWN/u);expect(JSON.stringify({...localStorage})).toBe(original);expect(s.calls.filter(call=>call.path.endsWith('/request'))).toHaveLength(1);
 otherView.unmount();const third=new SocialGenerationCustody(next,s.storage);await expect(third.exclusive(()=>third.prepare(guidedSocialSelection({guide,facts:[workspace.facts[0]!]}),()=>true))).rejects.toThrow();expect(JSON.stringify({...localStorage})).toBe(original);next.dispose();s.client.dispose();
});
it('accepted receipt is IDs only followed by fresh read, no sameUUID retry or automatic polling',async()=>{
 const s=setup(),v=await mount(s);await select();s.send(async()=>{throw Error('Lost');});fireEvent.click(button('Request guided social suggestion'));await waitFor(()=>expect(button('Reconcile guided request receipt')).toHaveProperty('disabled',false));s.receipt({state:'accepted',result:{requestId:id}});fireEvent.click(button('Reconcile guided request receipt'));await waitFor(()=>expect(v.onCurrentRequest).toHaveBeenCalledWith(request));expect(s.calls.filter(call=>call.path.endsWith('/request'))).toHaveLength(1);expect(s.calls.filter(call=>call.path.endsWith('/receipt'))[0]!.body).toEqual({commandId:expect.any(String),payloadSHA256:expect.stringMatching(/^[a-f0-9]{64}$/u)});expect(localStorage.length).toBe(0);expect(screen.queryByRole('button',{name:/Retry/u})).toBeNull();s.client.dispose();
});
it.each(['unmount','auth','role'] as const)('%s fences a late request response and never deletes uncertain custody',async mode=>{
 const s=setup(),v=await mount(s);await select();const held=deferred<Response>();s.send(()=>held.promise);fireEvent.click(button('Request guided social suggestion'));await waitFor(()=>expect(s.calls.filter(call=>call.path.endsWith('/request'))).toHaveLength(1));const before=JSON.stringify({...localStorage});
 if(mode==='unmount')v.unmount();else if(mode==='auth')act(()=>s.client.invalidate(false));else{s.change({role:'salesperson'});await act(async()=>{await s.client.refresh().catch(()=>{});});}
 await act(async()=>held.resolve(json({status:'accepted',replayed:false,result:{requestId:id}})));expect(v.onCurrentRequest).not.toHaveBeenCalledWith(request);expect(JSON.stringify({...localStorage})).toBe(before);expect(s.calls.some(call=>call.path.endsWith('/drafts/read'))).toBe(false);s.client.dispose();
});
it('storage event clears old inputs and prevents late output, foreign identity custody is never removed',async()=>{
 const s=setup(),v=await mount(s);await select();const custody=new SocialGenerationCustody(s.client,s.storage),binding=custody.binding()!;const held=await custody.exclusive(()=>custody.prepare(guidedSocialSelection({guide,facts:[workspace.facts[0]!]}),()=>true));act(()=>window.dispatchEvent(new StorageEvent('storage',{key:binding.key,newValue:JSON.stringify(held.held)})));expect(screen.queryByRole('checkbox')).toBeNull();expect(button('Request guided social suggestion')).toHaveProperty('disabled',true);
 s.change({userId:other});await act(async()=>{await s.client.refresh().catch(()=>{});});expect(localStorage.getItem(binding.key)).not.toBeNull();v.unmount();s.client.dispose();
});
it('missing locks, failed storage and corrupt/expired custody all fail closed',async()=>{
 const s=setup();await s.client.refresh();const input=guidedSocialSelection({guide,facts:[workspace.facts[0]!]}),custody=new SocialGenerationCustody(s.client,s.storage),binding=custody.binding()!;
 Object.defineProperty(navigator,'locks',{value:undefined,configurable:true});await expect(custody.exclusive(()=>custody.prepare(input,()=>true))).rejects.toThrow();expect(localStorage.length).toBe(0);
 const failed=new SocialGenerationCustody(s.client,{getItem:()=>{throw Error('Blocked');},setItem:()=>{throw Error('Blocked');},removeItem:vi.fn()});expect(()=>failed.read()).toThrow();
 localStorage.setItem(binding.key,'corrupt');expect(()=>custody.read()).toThrow();expect(localStorage.getItem(binding.key)).toBe('corrupt');localStorage.setItem(binding.key,JSON.stringify({identity:binding.identity,expiresAt:'2020-01-01T00:00:00.000Z',commandId:id,payloadSHA256:'a'.repeat(64)}));expect(()=>custody.read()).toThrow();expect(localStorage.getItem(binding.key)).not.toBeNull();s.client.dispose();
});
it('synchronous double activation mints only one command',async()=>{const s=setup();await mount(s);await select();const send=button('Request guided social suggestion');act(()=>{fireEvent.click(send);fireEvent.click(send);});await waitFor(()=>expect(s.calls.filter(call=>call.path.endsWith('/request'))).toHaveLength(1));await screen.findByText(/Current ready suggestion read/u);s.client.dispose();});
it.each(['success','failure'] as const)('integrated newer retained adoption/refinement survives older guided detail %s',async outcome=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);await select();const held=deferred<Response>();s.detail(()=>held.promise);fireEvent.click(button('Request guided social suggestion'));await waitFor(()=>expect(s.calls.filter(call=>call.path.endsWith('/drafts/read'))).toHaveLength(1));
 const newer:SocialDraftView={...request,id:other,concepts:[{theme:'build',factRefs:[{id,version:1}],variants:[{platform:'linkedin',text:'Newer selected private text.'}]}]};s.facts({...workspace,requests:[newer]});s.detail(async()=>json({request:newer}));fireEvent.click(button('Read retained social suggestions'));await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});fireEvent.click(button('Re-read and use linkedin suggestion 1.1'));await waitFor(()=>expect(screen.getByLabelText('Private social text')).toHaveProperty('value','Newer selected private text.'));fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Newer private refinement survives.'}});
 await act(async()=>held.resolve(outcome==='success'?json({request}):new Response('{}',{status:503})));expect(screen.getByLabelText('Private social text')).toHaveProperty('value','Newer private refinement survives.');expect(screen.getByText(/Selected origin request/u).textContent).toContain(other);expect(s.calls.filter(call=>call.path.endsWith('/request'))).toHaveLength(1);s.client.dispose();
});
