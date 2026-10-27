// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import type {AnswerBlock,SocialVoiceGuide} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialWorkspace} from '../../src/client/BrowserSocialWorkspace.tsx';
import {BrowserSocialFacts} from '../../src/client/BrowserSocialFacts.tsx';
import {BrowserSocialFactsCustody} from '../../src/client/BrowserSocialFactsCustody.ts';
const id='10000000-0000-4000-8000-000000000001';
const factId='20000000-0000-4000-8000-000000000002';
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const fact=(version=1):AnswerBlock=>({id:factId,version,kind:'product',text:'A local fact workspace is planned.',approvedAt:null,retiredAt:null,socialInput:{topic:'build',status:'planned',sanitized:true}});
const guide:Extract<SocialVoiceGuide,{state:'available'}>={state:'available',guideId:id,revision:1,entries:[{entryId:id,dimension:'tone',guidance:'Write plainly.'}],createdAt:'2026-10-27T00:00:00Z',updatedAt:'2026-10-27T00:00:00Z'};
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function setup(){
 let blocks:AnswerBlock[]=[],unknown=false,held:ReturnType<typeof deferred>|null=null;
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'fact-authoring',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 const calls:{path:string;body:Record<string,unknown>}[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(async(path,init)=>{
  if(path==='/browser/session')return json(session);
  const body=JSON.parse(String(init?.body??'{}')) as Record<string,unknown>;calls.push({path:String(path),body});
  if(path==='/browser/api/outreach/answer-blocks')return held?held.promise:json({blocks});
  if(path==='/browser/api/outreach/answer-blocks/save'){
   if(unknown)throw Error('Lost response');
   const prior=blocks.find(b=>b.id===body['id']);
   if(prior&&prior.version!==body['expectedVersion'])return json({status:'refused',replayed:false,reason:'stale_version'});
   const next={...fact(prior?prior.version+1:1),text:String(body['text']),socialInput:body['socialInput'] as AnswerBlock['socialInput']};blocks=[next];
   return json({status:'accepted',replayed:false,result:{id:factId,version:next.version}});
  }
  if(path==='/browser/api/outreach/answer-blocks/approve'||path==='/browser/api/outreach/answer-blocks/retire'){
   if(unknown)throw Error('Lost response');
   const current=blocks[0]!;
   if(current.version!==body['version'])return json({status:'refused',replayed:false,reason:'stale_version'});
   blocks=[{...current,...(String(path).endsWith('/approve')?{approvedAt:new Date().toISOString()}:{retiredAt:new Date().toISOString()})}];
   return json({status:'accepted',replayed:false,result:{id:factId,version:current.version}});
  }
  if(path==='/browser/api/social/private-drafts/list')return json({drafts:[],nextAfterId:null});
  if(path==='/browser/api/social/drafts')return json({sources:[],facts:blocks.filter(b=>b.approvedAt&&!b.retiredAt).map(({id,version,text,socialInput})=>({id,version,text,socialInput})),requests:[]});
  if(path==='/browser/api/social/voice-preferences/read')return json({guide});
  if(path==='/browser/api/social/drafts/request')return json({status:'refused',replayed:false,reason:'readiness_required'});
  throw Error('Unexpected route');
 });
 const makeClient=()=>new BrowserClient({storage:localStorage,fetch,navigate:vi.fn(),randomUUID:()=>id});
 return {client:makeClient(),makeClient,calls,blocks:()=>blocks,setBlocks:(value:AnswerBlock[])=>{blocks=value;},lose:()=>{unknown=true;},hold:()=>{held=deferred();return held;},role:()=>{session={...session,role:'salesperson'};}};
}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);localStorage.clear();const tails=new Map<string,Promise<unknown>>();Object.defineProperty(navigator,'locks',{configurable:true,value:{request:(name:string,_options:unknown,work:()=>Promise<unknown>)=>{const next=(tails.get(name)??Promise.resolve()).catch(()=>{}).then(work);tails.set(name,next);return next;}}});});
afterEach(()=>{cleanup();localStorage.clear();vi.unstubAllGlobals();});
const button=(name:string)=>screen.getByRole('button',{name});
async function read(){fireEvent.click(button('Read current facts'));await screen.findByText('Current shared facts read. Saving creates an unapproved version. Approval is a separate explicit action.');await waitFor(()=>expect(button('Read current facts')).toHaveProperty('disabled',false));}
async function mount(){const s=setup();await s.client.refresh();const view=render(<BrowserSocialWorkspace client={s.client}/>);fireEvent.click(button('Author shared facts'));await read();return {...s,view};}
it('news exposes its unavailable source prerequisite without desktop bridge or source IO',async()=>{
 const s=await mount();typeFact();fireEvent.change(screen.getByLabelText('LinkedIn topic'),{target:{value:'news'}});
 expect(screen.getByText(/News-source selection is unavailable in this browser/u)).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Load existing checked public sources'})).toBeNull();
 expect(screen.queryByLabelText('Original public news source')).toBeNull();
 expect(s.calls.some(c=>/sourcing|source-check|fetch/u.test(c.path))).toBe(false);s.client.dispose();
});
it('edited controlled textarea keeps its accessible textbox name when wrapping label text includes the retained value',async()=>{
 const s=await mount();s.setBlocks([fact()]);await read();fireEvent.click(button('Edit fact'));
 const input=screen.getByRole('textbox',{name:'Answer fact'});
 expect(input).toHaveProperty('value',fact().text);
 expect(input.closest('label')?.textContent).toBe('Answer fact'+fact().text);
 s.client.dispose();
});
function typeFact(text='A local fact workspace is planned.'){
 fireEvent.change(screen.getByLabelText('Answer fact'),{target:{value:text}});
 fireEvent.click(screen.getByLabelText('Sanitized LinkedIn factual input'));
}
it('supported Social surface reuses editor, saves sanitized versions separately from approval and selects exact approved ref',async()=>{
 const s=await mount();expect(s.calls.filter(c=>c.path.includes('/answer-blocks'))).toHaveLength(1);
 typeFact();fireEvent.click(button('Save fact draft'));await screen.findByText(/version 1 saved unapproved/u);expect(s.blocks()[0]?.approvedAt).toBeNull();expect(s.calls.some(c=>c.path.endsWith('/approve'))).toBe(false);
 await read();fireEvent.click(button('Edit fact'));fireEvent.change(screen.getByLabelText('Answer fact'),{target:{value:'A bounded local fact workspace is planned.'}});fireEvent.click(button('Save fact draft'));await screen.findByText(/version 2 saved unapproved/u);
 await read();expect(screen.getByText('Current · Draft · version 2')).toBeTruthy();fireEvent.click(button('Approve exact text'));await screen.findByText(/version 2 approved/u);expect(s.blocks()[0]?.approvedAt).not.toBeNull();
 fireEvent.click(button('Read current generation inputs'));await screen.findByRole('checkbox',{name:/Use saved voice guide/u});fireEvent.click(screen.getByRole('checkbox',{name:/Use saved voice guide/u}));fireEvent.click(screen.getByRole('checkbox',{name:/A bounded local fact workspace/u}));fireEvent.click(button('Request guided social suggestion'));
 await waitFor(()=>expect(s.calls.filter(c=>c.path.endsWith('/drafts/request'))).toHaveLength(1));
 expect(s.calls.find(c=>c.path.endsWith('/drafts/request'))?.body['factBlocks']).toEqual([{id:factId,version:2}]);
 expect(s.calls.filter(c=>c.path.endsWith('/save')).map(c=>c.body)).toEqual([expect.objectContaining({text:'A local fact workspace is planned.',socialInput:{topic:'build',status:'planned',sanitized:true}}),expect.objectContaining({id:factId,expectedVersion:1,text:'A bounded local fact workspace is planned.'})]);
 expect(s.calls.find(c=>c.path.endsWith('/approve'))?.body).toEqual({id:factId,version:2,commandId:expect.any(String)});
 expect(s.calls.some(c=>/publish|activate|settings|cohort|authorization/u.test(c.path))).toBe(false);expect(JSON.stringify({...localStorage})).not.toContain('fact workspace');s.client.dispose();
});
it('stale version retains typed draft and requires explicit comparison before a new unapproved save',async()=>{
 const s=await mount();s.setBlocks([fact()]);await read();fireEvent.click(button('Edit fact'));fireEvent.change(screen.getByLabelText('Answer fact'),{target:{value:'Retained typed correction.'}});s.setBlocks([{...fact(2),text:'Changed elsewhere.'}]);fireEvent.click(button('Save fact draft'));await screen.findByText(/Fact action refused/u);expect(screen.getByLabelText('Answer fact')).toHaveProperty('value','Retained typed correction.');await read();await screen.findByText('Your draft is based on version 1. Compare it with current version 2 before saving.');expect(button('Save fact draft')).toHaveProperty('disabled',true);fireEvent.click(button('Use current version as base'));fireEvent.click(button('Save fact draft'));await screen.findByText(/version 3 saved unapproved/u);expect(s.blocks()[0]?.approvedAt).toBeNull();s.client.dispose();
});
it('UNKNOWN save survives navigation, fresh reads and second client without replay or replacement',async()=>{
 const s=await mount();typeFact('Private typed fact must not enter custody.');s.lose();fireEvent.click(button('Save fact draft'));await screen.findByText(/Fact action unavailable or outcome UNKNOWN/u);const bytes=JSON.stringify({...localStorage});expect(bytes).not.toContain('Private typed');expect(bytes).toContain('fact_save');s.view.unmount();const next=s.makeClient();await next.refresh();render(<BrowserSocialFacts client={next} onFactsChanged={vi.fn()}/>);await read();expect(button('Save fact draft')).toHaveProperty('disabled',true);expect(screen.queryByRole('button',{name:/Retry|Resend/u})).toBeNull();expect(JSON.stringify({...localStorage})).toBe(bytes);expect(s.calls.filter(c=>c.path.endsWith('/save'))).toHaveLength(1);next.dispose();s.client.dispose();
});
it.each(['role','logout','unmount'] as const)('%s prevents late fact read projection',async mode=>{
 const s=await mount(),held=s.hold();fireEvent.click(button('Read current facts'));await waitFor(()=>expect(s.calls.filter(c=>c.path.endsWith('/answer-blocks'))).toHaveLength(2));if(mode==='unmount')s.view.unmount();else if(mode==='logout')act(()=>s.client.invalidate(false));else{s.role();await act(async()=>{await s.client.refresh().catch(()=>{});});}await act(async()=>held.resolve(json({blocks:[fact()]})));expect(screen.queryByText('Current · Draft · version 1')).toBeNull();s.client.dispose();
});
it('retire does not approve and invalidates previously selected guided facts',async()=>{
 const s=await mount();s.setBlocks([{...fact(),approvedAt:new Date().toISOString()}]);await read();fireEvent.click(button('Read current generation inputs'));await screen.findByRole('checkbox',{name:/Use saved voice guide/u});fireEvent.click(screen.getByRole('checkbox',{name:/Use saved voice guide/u}));fireEvent.click(screen.getByRole('checkbox',{name:/A local fact workspace/u}));expect(button('Request guided social suggestion')).toHaveProperty('disabled',false);fireEvent.click(button('Retire fact'));await screen.findByText(/version 1 retired/u);expect(button('Request guided social suggestion')).toHaveProperty('disabled',true);expect(s.calls.some(c=>c.path.endsWith('/approve'))).toBe(false);s.client.dispose();
});
it('corrupt, expired or foreign-revision custody and unavailable locks fail closed without deletion',async()=>{
 const s=setup();await s.client.refresh();const custody=new BrowserSocialFactsCustody(s.client),binding=custody.binding()!;for(const bytes of ['corrupt',JSON.stringify({identity:binding.identity,expiresAt:'2020-01-01T00:00:00Z',commandId:id,action:'fact_save'}),JSON.stringify({identity:'foreign',expiresAt:binding.expiresAt,commandId:id,action:'fact_save'})]){localStorage.setItem(binding.key,bytes);expect(()=>custody.read()).toThrow();expect(localStorage.getItem(binding.key)).toBe(bytes);}localStorage.clear();Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});await expect(custody.exclusive(async()=>undefined)).rejects.toThrow();s.client.dispose();
});
it('two clients serialize marker preparation and never replace an unknown write',async()=>{
 const s=setup();await s.client.refresh();const second=s.makeClient();await second.refresh();const first=new BrowserSocialFactsCustody(s.client),other=new BrowserSocialFactsCustody(second);
 const results=await Promise.allSettled([first.exclusive(async()=>first.prepare('fact_save',id)),other.exclusive(async()=>other.prepare('fact_approve',factId))]);
 expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(first.read()?.commandId).toBe(id);expect(other.read()).toEqual(first.read());expect(JSON.stringify({...localStorage})).not.toContain('Public');second.dispose();s.client.dispose();
});
it('blocked storage fails before any write marker or network dispatch',async()=>{
 const s=setup();await s.client.refresh();const custody=new BrowserSocialFactsCustody(s.client,{getItem:()=>null,setItem:()=>{throw Error('Storage unavailable');},removeItem:vi.fn()});
 await expect(custody.exclusive(async()=>custody.prepare('fact_save',id))).rejects.toThrow('Storage unavailable');expect(s.calls).toEqual([]);s.client.dispose();
});
it('storage event clears exact text and selection, but never deletes unknown marker',async()=>{
 const s=await mount();typeFact('Unpersisted input.');const custody=new BrowserSocialFactsCustody(s.client);await custody.exclusive(async()=>custody.prepare('fact_save',id));act(()=>window.dispatchEvent(new StorageEvent('storage',{key:custody.binding()!.key})));expect(screen.getByLabelText('Answer fact')).toHaveProperty('value','');expect(button('Save fact draft')).toHaveProperty('disabled',true);expect(custody.read()).not.toBeNull();s.client.dispose();
});
