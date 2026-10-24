// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialReview} from '../../src/client/BrowserSocialReview.tsx';
const id='10000000-0000-4000-8000-000000000001';
const suggestion={id,state:'ready',sourceRefs:[{kind:'public',id,revision:2}],factBlocks:[{id,version:3}],concepts:[{theme:'build',factRefs:[{id,version:3}],variants:[{platform:'linkedin',text:'Retained suggestion <img src=x onerror=alert(1)>'}]}],reason:null,createdAt:'2026-10-24T00:00:00.000Z',deadlineAt:new Date(Date.now()+600000).toISOString()};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function setup(empty=false){
 const storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'social-session',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 let request:unknown=suggestion,held:ReturnType<typeof deferred>|null=null,heldSession:ReturnType<typeof deferred>|null=null;
 const reads:string[]=[];
 const fetch=vi.fn<typeof globalThis.fetch>(async(url)=>{
  if(url==='/browser/session')return heldSession?await heldSession.promise:json(session);
  if(url==='/browser/logout')return json({status:'signed_out'});
  reads.push(String(url));
  if(held)return held.promise;
  if(url==='/browser/api/social/drafts')return json({sources:empty?[]:[{kind:'public',id,revision:2,label:'<script>Retained source</script>',observedAt:'2026-10-24T00:00:00.000Z'}],facts:empty?[]:[{id,version:3,text:'Approved fact'}],requests:empty?[]:[request]});
  expect(url).toBe('/browser/api/social/drafts/read');return json({request});
 });
 const client=new BrowserClient({storage,fetch,randomUUID:vi.fn(),navigate:vi.fn()});
 return {client,storage,reads,fetch,request:(value:unknown)=>{request=value;},change:(patch:Partial<typeof session>)=>{session={...session,...patch};},hold:()=>{held=deferred();return held;},holdSession:()=>{heldSession=deferred();return {...heldSession,session};}};
}
const load=()=>fireEvent.click(screen.getByRole('button',{name:'Read retained social suggestions'}));
const use=()=>fireEvent.click(screen.getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}));
afterEach(cleanup);
it('useful empty manual post/comment composer never stores or dispatches prose and explicit discard/reload loses it',async()=>{
 const s=setup(true);await s.client.refresh();const view=render(<BrowserSocialReview client={s.client}/>);fireEvent.change(screen.getByLabelText('Scratch format'),{target:{value:'comment'}});fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Private manual comment'}});expect(s.reads).toEqual([]);load();await screen.findByText(/No retained suggestions\./u);expect(screen.getByLabelText('Private social text')).toHaveProperty('value','Private manual comment');expect(s.storage.setItem).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'Discard private scratch'}));expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Lost on remount'}});view.unmount();render(<BrowserSocialReview client={s.client}/>);expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');s.client.dispose();
});
it('adopts only exact current ready variant after explicit reread and keeps visible provenance distinct from support',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);load();await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});expect(s.reads).toEqual(['/browser/api/social/drafts']);expect(screen.queryByRole('img')).toBeNull();use();await waitFor(()=>expect(screen.getByLabelText('Private social text')).toHaveProperty('value',suggestion.concepts[0]!.variants[0]!.text));expect(s.reads).toEqual(['/browser/api/social/drafts','/browser/api/social/drafts/read']);expect(screen.getByText(/Selected origin request/u).textContent).toContain(id);expect(screen.getByText(/All composer prose/u).textContent).toContain('unverified');fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Human edited'}});expect(s.storage.setItem).not.toHaveBeenCalled();load();await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');s.client.dispose();
});
it.each(['review','expired','changed'] as const)('refuses %s selected evidence and clears stale prose/provenance',async state=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);load();await screen.findByRole('button',{name:'Re-read and use linkedin suggestion 1.1'});s.request(state==='changed'?{...suggestion,concepts:[{...suggestion.concepts[0],variants:[{platform:'linkedin',text:'Changed text'}]}]}:{...suggestion,state,concepts:null});use();await screen.findByText(/Suggestion changed, expired or unavailable/u);expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');expect(screen.queryByText(/Selected origin request/u)).toBeNull();s.client.dispose();
});
it('synchronous duplicate guard coalesces reads and discard fences held read',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);const held=s.hold(),button=screen.getByRole('button',{name:'Read retained social suggestions'});act(()=>{fireEvent.click(button);fireEvent.click(button);});await waitFor(()=>expect(s.reads).toHaveLength(1));fireEvent.click(screen.getByRole('button',{name:'Discard private scratch'}));await act(async()=>{held.resolve(json({sources:[],facts:[],requests:[suggestion]}));});expect(screen.queryByRole('button',{name:'Re-read and use linkedin suggestion 1.1'})).toBeNull();s.client.dispose();
});
it.each(['revision','workspaceId','deviceId','role'] as const)('clears composer and held evidence on %s transition',async field=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Private old binding'}});const held=s.hold();load();await waitFor(()=>expect(s.reads).toHaveLength(1));s.change({[field]:field==='role'?'salesperson':field==='revision'?'changed':'20000000-0000-4000-8000-000000000002'});await act(async()=>{await s.client.refresh().catch(()=>{});});await act(async()=>{held.resolve(json({sources:[],facts:[],requests:[suggestion]}));});expect(screen.queryByLabelText('Private social text')).toBeNull();expect(screen.queryByRole('button',{name:'Re-read and use linkedin suggestion 1.1'})).toBeNull();s.client.dispose();
});
it('replacement client and late read cannot restore old private content',async()=>{
 const s=setup(),next=setup(true);await s.client.refresh();await next.client.refresh();const view=render(<BrowserSocialReview client={s.client}/>);fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Old private'}});const held=s.hold();load();await waitFor(()=>expect(s.reads).toHaveLength(1));view.rerender(<BrowserSocialReview client={next.client}/>);await act(async()=>{held.resolve(json({sources:[],facts:[],requests:[suggestion]}));});expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');expect(screen.queryByRole('button',{name:'Re-read and use linkedin suggestion 1.1'})).toBeNull();s.client.dispose();next.client.dispose();
});
it('session replacement during predispatch refresh dispatches no social read',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);const held=s.holdSession();load();await act(async()=>{held.resolve(json({...held.session,revision:'replaced'}));});expect(s.reads).toEqual([]);expect(screen.queryByLabelText('Private social text')).toBeNull();s.client.dispose();
});
it('logout and expiry clear private memory',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserSocialReview client={s.client}/>);fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Private scratch'}});s.change({expiresAt:new Date(Date.now()-1).toISOString()});await act(async()=>{await s.client.refresh().catch(()=>{});});expect(screen.queryByLabelText('Private social text')).toBeNull();await act(async()=>{await s.client.signOut().catch(()=>{});});expect(screen.queryByLabelText('Private social text')).toBeNull();s.client.dispose();
});
