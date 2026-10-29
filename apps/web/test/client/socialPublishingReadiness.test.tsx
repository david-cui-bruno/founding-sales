// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialPublishingReadiness} from '../../src/client/BrowserSocialPublishingReadiness.tsx';
const id='10000000-0000-4000-8000-000000000001',date='2026-10-29T12:00:00Z';
const metadata={observedAt:date,runnerAvailable:false,publishingActivated:false,
 holds:['adapter_unavailable','current_account_unverified','current_publication_policy_unavailable'],
 accounts:[{accountId:id,revision:7,platform:'linkedin',accountKind:'profile',displayName:'Fictional saved profile',historicalState:'connected',
  currentAccountVerified:false,holds:['adapter_unavailable','current_account_unverified','current_publication_policy_unavailable']}]};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
const clients:BrowserClient[]=[];
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function setup(){
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 let pending:ReturnType<typeof deferred>|null=null,answer:unknown=metadata,status=200;
 const requests:unknown[]=[],storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session.status==='signed_out'?{status:'signed_out',csrfToken:session.csrfToken}:session);
  expect(url).toBe('/browser/api/social/publishing/readiness');expect(init?.method).toBe('POST');expect(init?.cache).toBe('no-store');
  requests.push(JSON.parse(String(init?.body)));return pending?pending.promise:json(answer,status);
 });
 const client=new BrowserClient({fetch:send,storage,navigate:vi.fn(),randomUUID:vi.fn(()=>id)});clients.push(client);
 return {client,storage,requests,send,delay:()=>{pending=deferred();return pending;},
  answer:(body:unknown,code=200)=>{answer=body;status=code;pending=null;},change:(patch:Partial<typeof session>)=>{session={...session,...patch};}};
}
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());});
const read=()=>fireEvent.click(screen.getByRole('button',{name:'Read publishing readiness'}));
it('explicit metadata read distinguishes historical connected from runner/account proof and exposes no write control',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialPublishingReadiness client={f.client}/>);
 expect(f.requests).toEqual([]);read();await screen.findByText('Fictional saved profile');
 expect(f.requests).toEqual([{}]);expect(screen.getByText(/Saved status: connected \(historical record\)/u)).toBeTruthy();
 expect(screen.getByText(/LinkedIn personal-profile text post is a potential target only/u)).toBeTruthy();
 expect(screen.getAllByText('Publishing runner unavailable')).toHaveLength(2);
 expect(screen.getAllByRole('button').map(button=>button.textContent)).toEqual(['Read publishing readiness']);expect(f.storage.setItem).not.toHaveBeenCalled();
});
it.each(['principal','device','role','logout'] as const)('late %s change clears metadata and fences a pending read',async change=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialPublishingReadiness client={f.client}/>);read();await screen.findByText('Fictional saved profile');
 const pending=f.delay();read();await waitFor(()=>expect(f.requests).toHaveLength(2));
 if(change==='principal')f.change({userId:'20000000-0000-4000-8000-000000000002'});
 if(change==='device')f.change({deviceId:'20000000-0000-4000-8000-000000000002'});
 if(change==='role')f.change({role:'salesperson'});if(change==='logout')f.change({status:'signed_out'});
  await act(async()=>{await expect(f.client.refresh()).rejects.toThrow('session_changed');pending.resolve(json(metadata));});
 expect(screen.queryByText('Fictional saved profile')).toBeNull();expect(f.requests).toHaveLength(2);expect(f.storage.setItem).not.toHaveBeenCalled();
});
it('unmount never resurrects a late account projection or sends another request',async()=>{
 const f=setup();await f.client.refresh();const view=render(<BrowserSocialPublishingReadiness client={f.client}/>),pending=f.delay();read();
 await waitFor(()=>expect(f.requests).toHaveLength(1));view.unmount();await act(async()=>pending.resolve(json(metadata)));
 expect(screen.queryByText('Fictional saved profile')).toBeNull();expect(f.requests).toHaveLength(1);
});
it.each([{}, {...metadata,publishingActivated:true},{...metadata,token:'PRIVATE'},null])('malformed or activation-shaped read refuses without retaining old metadata %#',async answer=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialPublishingReadiness client={f.client}/>);read();await screen.findByText('Fictional saved profile');
 f.answer(answer);read();await screen.findByRole('alert');expect(screen.queryByText('Fictional saved profile')).toBeNull();expect(screen.queryByText('PRIVATE')).toBeNull();expect(f.requests).toHaveLength(2);
});
