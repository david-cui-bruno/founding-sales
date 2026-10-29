// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {createRoot} from 'react-dom/client';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialConversations} from '../../src/client/BrowserSocialConversations.tsx';
import {publicThreadFixture} from '../../../../packages/domain/test/social/publicThreadFixture.ts';
const id='10000000-0000-4000-8000-000000000001';
afterEach(()=>{cleanup();vi.useRealTimers();});
function setup(){
 const now=Date.now(),input=publicThreadFixture(new Date(now-1000).toISOString(),id);
 const thread={threadId:id,revision:1,capturedAt:input.capturedAt,expiresAt:new Date(now+60000).toISOString(),availability:'available' as const,snapshot:input.snapshot};
 const metadata={threadId:id,revision:1,capturedAt:thread.capturedAt,expiresAt:thread.expiresAt,availability:'available' as const,coverage:'partial' as const,messageCount:2};
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()};
 const storage={getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()},requests:{path:string;body:unknown}[]=[];
 let delay=false,deliver:((response:Response)=>void)|undefined;
 const json=(value:unknown)=>new Response(JSON.stringify(value));
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,options)=>{
  if(url==='/browser/session')return json(session);
  requests.push({path:String(url),body:JSON.parse(String(options?.body))});
  if(String(url).endsWith('/read'))return delay?new Promise<Response>(resolve=>{deliver=resolve;}):json({thread});
  return json({threads:[metadata],nextAfterId:null});
 });
 const client=new BrowserClient({storage,fetch,randomUUID:vi.fn(),navigate:vi.fn()});
 return {client,storage,requests,thread,metadata,session,delay:()=>{delay=true;},deliver:()=>deliver?.(json({thread}))};
}
async function list(){await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Read retained public threads'}));});}
async function open(){await act(async()=>{fireEvent.click(screen.getByRole('button',{name:`Open snapshot ${id}`}));});}
it('reads only metadata until exact open, shows explicit gaps and stores no source prose',async()=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialConversations client={f.client}/>);expect(f.requests).toEqual([]);
 await list();expect(screen.queryByText(f.thread.snapshot.messages[0]!.text)).toBeNull();await open();
 expect(screen.getByText(f.thread.snapshot.messages[0]!.text)).toBeTruthy();expect(screen.getByText(/Author unknown/u)).toBeTruthy();expect(screen.getByText(/Text coverage truncated/u)).toBeTruthy();
 expect(f.requests).toEqual([{path:'/browser/api/social/threads/list',body:{}},{path:'/browser/api/social/threads/read',body:{threadId:id,expectedRevision:1}}]);
 expect(f.storage.setItem).not.toHaveBeenCalled();await act(async()=>{f.client.dispose();});
});
it.each(['revision','expired'] as const)('holds an exact-open response with changed %s',async change=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialConversations client={f.client}/>);await list();
 if(change==='revision')f.thread.revision=2;else f.thread.expiresAt=new Date(Date.now()-1).toISOString();await open();
 expect(screen.queryByText(f.thread.snapshot.messages[0]!.text)).toBeNull();expect(screen.getByRole('status').textContent).toContain('changed, expired or unavailable');await act(async()=>{f.client.dispose();});
});
it.each([false,true])('clears visible expired originals and refuses late expired content (late=%s)',async late=>{
 vi.useFakeTimers();const f=setup();f.thread.expiresAt=new Date(Date.now()+1000).toISOString();f.metadata.expiresAt=f.thread.expiresAt;
 await f.client.refresh();render(<BrowserSocialConversations client={f.client}/>);await list();if(late)f.delay();await open();
 if(!late)expect(screen.getByText(f.thread.snapshot.messages[0]!.text)).toBeTruthy();
 await act(async()=>{vi.advanceTimersByTime(1001);f.deliver();});
 expect(screen.queryByText(f.thread.snapshot.messages[0]!.text)).toBeNull();expect(screen.queryByRole('button',{name:`Open snapshot ${id}`})).toBeNull();await act(async()=>{f.client.dispose();});
});
it.each(['role','logout','revision'] as const)('clears source projections and fences late results on %s change',async change=>{
 const f=setup();await f.client.refresh();render(<BrowserSocialConversations client={f.client}/>);await list();f.delay();await open();
 await act(async()=>{if(change==='logout')f.client.invalidate();else{if(change==='role')f.session.role='salesperson';else f.session.revision='two';await expect(f.client.refresh()).rejects.toThrow('session_changed');}f.deliver();});
 expect(screen.queryByText(f.thread.snapshot.messages[0]!.text)).toBeNull();expect(screen.queryByRole('button',{name:`Open snapshot ${id}`})).toBeNull();await act(async()=>{f.client.dispose();});
});
it('unmount drops pending results and remount retains no page or source data',async()=>{
 const f=setup();await f.client.refresh();const mounted=render(<BrowserSocialConversations client={f.client}/>);await list();f.delay();await open();mounted.unmount();render(<BrowserSocialConversations client={f.client}/>);
 await act(async()=>{f.deliver();});expect(screen.queryByText(f.thread.snapshot.messages[0]!.text)).toBeNull();expect(screen.queryByRole('button',{name:`Open snapshot ${id}`})).toBeNull();expect(f.requests).toHaveLength(2);await act(async()=>{f.client.dispose();});
});
it('accepts the first visible read before passive effects flush',async()=>{
 const f=setup();await f.client.refresh();const container=document.createElement('div');document.body.append(container);const root=createRoot(container);let clicked=false;
 const observer=new MutationObserver(()=>{const button=screen.queryByRole('button',{name:'Read retained public threads'});if(button&&!clicked){clicked=true;fireEvent.click(button);}});
 observer.observe(container,{childList:true,subtree:true});
 try{root.render(<BrowserSocialConversations client={f.client}/>);await waitFor(()=>expect(screen.getByRole('button',{name:`Open snapshot ${id}`})).toBeTruthy());expect(clicked).toBe(true);expect(f.requests).toHaveLength(1);}
 finally{observer.disconnect();await act(async()=>{root.unmount();f.client.dispose();});container.remove();}
});
it('offers no retained-public reader to a nonadmin',async()=>{
 const f=setup();f.session.role='salesperson';await f.client.refresh();render(<BrowserSocialConversations client={f.client}/>);
 expect(screen.queryByRole('button',{name:'Read retained public threads'})).toBeNull();expect(f.requests).toEqual([]);await act(async()=>{f.client.dispose();});
});
