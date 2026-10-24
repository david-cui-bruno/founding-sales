// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialReview} from '../../src/client/BrowserSocialReview.tsx';
const id='10000000-0000-4000-8000-000000000001';
afterEach(()=>{cleanup();vi.useRealTimers();});
it('expires an adopted suggestion and its edited prose at the known evidence deadline',async()=>{
 vi.useFakeTimers();const now=Date.now();const request={id,state:'ready',sourceRefs:[],factBlocks:[],concepts:[{theme:'build',factRefs:[],variants:[{platform:'linkedin',text:'Retained suggestion'}]}],reason:null,createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+1000).toISOString()};
 const json=(value:unknown)=>new Response(JSON.stringify(value));
 const storage={getItem:()=>null,setItem:vi.fn(),removeItem:vi.fn()};
 const client=new BrowserClient({storage,fetch:vi.fn<typeof globalThis.fetch>(async url=>url==='/browser/session'?json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'social-session',csrfToken:'c'.repeat(40),expiresAt:new Date(now+120000).toISOString()}):String(url).endsWith('/read')?json({request}):json({sources:[],facts:[],requests:[request]})),randomUUID:vi.fn(),navigate:vi.fn()});
 await client.refresh();render(<BrowserSocialReview client={client}/>);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Read retained social suggestions'}));});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Re-read and use linkedin suggestion 1.1'}));});
 expect(screen.getByLabelText('Private social text')).toHaveProperty('value','Retained suggestion');fireEvent.change(screen.getByLabelText('Private social text'),{target:{value:'Unverified human edit'}});
 act(()=>{vi.advanceTimersByTime(1001);});expect(screen.getByLabelText('Private social text')).toHaveProperty('value','');expect(screen.queryByText(/Selected origin request/u)).toBeNull();expect(storage.setItem).not.toHaveBeenCalled();client.dispose();
});
