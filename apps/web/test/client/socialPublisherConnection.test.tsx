// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialPublisherConnection} from '../../src/client/BrowserSocialPublisherConnection.tsx';
import type {SocialPublisherConnectionInput,SocialPublisherConnectionResult} from '@fss/contracts';
const id='10000000-0000-4000-8000-000000000001';
const clients:BrowserClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());});
function fixture(){
 let signedIn=true;
 const storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 const client=new BrowserClient({storage,navigate:vi.fn(),fetch:vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(signedIn?{status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()}:{status:'signed_out',csrfToken:'c'.repeat(40)}),{status:200})),randomUUID:()=>id});clients.push(client);
 const transport=vi.fn(async(input:SocialPublisherConnectionInput,current:()=>void):Promise<SocialPublisherConnectionResult>=>{
  current();if(input.operation==='start')return {state:'connecting',connectionId:id,expiresAt:new Date(Date.now()+600000).toISOString()};
  if(input.operation==='frame'||input.operation==='input')return {state:'frame',connectionId:id,image:'/9j/',width:1280,height:900};
  if(input.operation==='complete')return {state:'connected',accountId:id,revision:2,externalId:'https://www.linkedin.com/in/fictional',displayName:'Fictional owner'};
  return {state:'closed'};
 });
 return {client,storage,transport,logout:()=>{signedIn=false;}};
}
it('passes only ephemeral sign-in events and independently verified results, never browser storage/custody',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport} reconnectAccountId={id}/>);
 fireEvent.click(screen.getByRole('button',{name:'Reconnect intended account'}));await screen.findByRole('button',{name:'Read sign-in screen'});
 fireEvent.click(screen.getByRole('button',{name:'Read sign-in screen'}));await screen.findByAltText(/Private LinkedIn sign-in screen/u);
 fireEvent.change(screen.getByLabelText('Private text for the selected sign-in field'),{target:{value:'private-fixture-credential'}});
 fireEvent.click(screen.getByRole('button',{name:'Enter private text'}));
 await waitFor(()=>expect(f.transport).toHaveBeenCalledWith({operation:'input',connectionId:id,event:{kind:'text',text:'private-fixture-credential'}},expect.any(Function)));
 await waitFor(()=>expect(screen.getByLabelText('Private text for the selected sign-in field')).toHaveProperty('value',''));
 fireEvent.click(screen.getByRole('button',{name:'Verify intended account'}));await screen.findByText(/Verified Fictional owner/u);
 expect(screen.queryByAltText(/Private LinkedIn sign-in screen/u)).toBeNull();expect(f.storage.setItem).not.toHaveBeenCalled();
 expect(f.transport.mock.calls.every(([input])=>!('externalId'in input))).toBe(true);
});
it('clears credentials/frames and fences a late screenshot response after logout',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport} reconnectAccountId={id}/>);
 fireEvent.click(screen.getByRole('button',{name:'Reconnect intended account'}));await screen.findByRole('button',{name:'Read sign-in screen'});
 const pending=Promise.withResolvers<SocialPublisherConnectionResult>();f.transport.mockImplementationOnce(async()=>pending.promise);
 fireEvent.change(screen.getByLabelText('Private text for the selected sign-in field'),{target:{value:'private-fixture-credential'}});
 fireEvent.click(screen.getByRole('button',{name:'Read sign-in screen'}));
 await act(async()=>{f.logout();await expect(f.client.refresh()).rejects.toThrow('session_changed');pending.resolve({state:'frame',connectionId:id,image:'/9j/',width:1280,height:900});});
 expect(screen.queryByLabelText('Private text for the selected sign-in field')).toBeNull();expect(screen.queryByAltText(/Private LinkedIn sign-in screen/u)).toBeNull();expect(f.storage.setItem).not.toHaveBeenCalled();
});
