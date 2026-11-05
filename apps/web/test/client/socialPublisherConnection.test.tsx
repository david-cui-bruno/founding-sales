// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {afterEach,it,expect,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserSocialPublisherConnection} from '../../src/client/BrowserSocialPublisherConnection.tsx';
import type {SocialPublisherConnectionInput,SocialPublisherConnectionResult} from '@fss/contracts';
const id='10000000-0000-4000-8000-000000000001';
const channel={organizationId:'a'.repeat(24),channelId:'b'.repeat(24),externalId:'fictional-profile-id',displayName:'Fictional owner',profileUrl:'https://www.linkedin.com/in/fictional'};
const clients:BrowserClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());});
function fixture(){
 let signedIn=true;
 const storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 const client=new BrowserClient({storage,navigate:vi.fn(),fetch:vi.fn<typeof fetch>(async()=>new Response(JSON.stringify(signedIn?{status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()}:{status:'signed_out',csrfToken:'c'.repeat(40)}),{status:200})),randomUUID:()=>id});clients.push(client);
 const transport=vi.fn(async(input:SocialPublisherConnectionInput,current:()=>void):Promise<SocialPublisherConnectionResult>=>{
  current();if(input.operation==='discover')return {state:'channels',channels:[channel]};
  if(input.operation==='connect')return {state:'connected',accountId:id,revision:2,externalId:channel.externalId,displayName:channel.displayName};
  return {state:'closed'};
 });
 return {client,storage,transport,logout:()=>{signedIn=false;}};
}
function enterKey(){fireEvent.change(screen.getByLabelText('Buffer API key'),{target:{value:'private-fixture-key'}});}
async function discover(){enterKey();fireEvent.click(screen.getByRole('button',{name:'Discover LinkedIn profiles'}));await screen.findAllByRole('radio');}
it('discovers privately and requires an explicit profile choice, with no activation or browser persistence',async()=>{
 const f=fixture();await f.client.refresh();const connected=vi.fn();render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport} reconnectAccountId={id} onConnected={connected}/>);
 expect(f.transport).not.toHaveBeenCalled();expect(screen.getByRole('link',{name:'Buffer Settings → API'}).getAttribute('href')).toBe('https://publish.buffer.com/settings/api');
 await discover();expect(screen.getByRole('radio')).toHaveProperty('checked',false);
 const connect=screen.getByRole('button',{name:'Reconnect selected profile'});expect(connect).toHaveProperty('disabled',true);expect(connected).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('radio'));fireEvent.click(connect);await waitFor(()=>expect(connected).toHaveBeenCalledTimes(1));
 expect(f.transport.mock.calls.map(([input])=>input)).toEqual([{operation:'discover',apiKey:'private-fixture-key'},{operation:'connect',accountId:id,apiKey:'private-fixture-key',organizationId:channel.organizationId,channelId:channel.channelId}]);
 expect(screen.getByLabelText('Buffer API key')).toHaveProperty('value','');expect(screen.queryByRole('radio')).toBeNull();expect(f.storage.setItem).not.toHaveBeenCalled();
});
it('invalidates discovered choices when the key changes',async()=>{
 const f=fixture();await f.client.refresh();render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport}/>);await discover();fireEvent.click(screen.getByRole('radio'));
 fireEvent.change(screen.getByLabelText('Buffer API key'),{target:{value:'different-private-key'}});expect(screen.queryByRole('radio')).toBeNull();expect(f.transport).toHaveBeenCalledTimes(1);
});
it('requires a fresh explicit choice across multiple discovered profiles',async()=>{
 const f=fixture();await f.client.refresh();f.transport.mockResolvedValueOnce({state:'channels',channels:[channel,{...channel,channelId:'c'.repeat(24),displayName:'Other owner'}]});
 render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport}/>);await discover();expect(screen.getAllByRole('radio').every(radio=>!(radio as HTMLInputElement).checked)).toBe(true);
 fireEvent.click(screen.getAllByRole('radio')[1]!);fireEvent.click(screen.getByRole('button',{name:'Connect selected profile'}));await waitFor(()=>expect(f.transport).toHaveBeenCalledTimes(2));
 expect(f.transport.mock.calls[1]?.[0]).toMatchObject({operation:'connect',organizationId:channel.organizationId,channelId:'c'.repeat(24)});
});
it.each(['logout','unmount','client replacement'] as const)('clears secrets and fences late connection completion after %s',async mode=>{
 const f=fixture();await f.client.refresh();const connected=vi.fn();const view=render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport} onConnected={connected}/>);await discover();
 const key=screen.getByLabelText('Buffer API key');fireEvent.click(screen.getByRole('radio'));
 const pending=Promise.withResolvers<SocialPublisherConnectionResult>();f.transport.mockImplementationOnce(async()=>pending.promise);
 fireEvent.click(screen.getByRole('button',{name:'Connect selected profile'}));
 if(mode==='unmount')view.unmount();
 else if(mode==='logout')await act(async()=>{f.logout();await expect(f.client.refresh()).rejects.toThrow('session_changed');});
 else{const replacement=fixture();await replacement.client.refresh();view.rerender(<BrowserSocialPublisherConnection client={replacement.client} transport={replacement.transport} onConnected={connected}/>);}
 await act(async()=>{pending.resolve({state:'connected',accountId:id,revision:2,externalId:channel.externalId,displayName:channel.displayName});});
 expect(key).toHaveProperty('value','');expect(connected).not.toHaveBeenCalled();expect(screen.queryByRole('radio')).toBeNull();expect(f.storage.setItem).not.toHaveBeenCalled();
});
it('clears the key and hides raw provider errors without retrying',async()=>{
 const f=fixture();await f.client.refresh();f.transport.mockRejectedValueOnce(Error('RAW_PROVIDER_ERROR private-fixture-key'));render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport}/>);
 enterKey();const button=screen.getByRole('button',{name:'Discover LinkedIn profiles'});fireEvent.click(button);fireEvent.click(button);
 await waitFor(()=>expect(screen.getByLabelText('Buffer API key')).toHaveProperty('value',''));expect(f.transport).toHaveBeenCalledTimes(1);expect(screen.queryByText(/RAW_PROVIDER_ERROR/u)).toBeNull();expect(screen.queryByRole('radio')).toBeNull();
});
it('shows no connect action for empty discovery and clears the key',async()=>{
 const f=fixture();await f.client.refresh();f.transport.mockResolvedValueOnce({state:'channels',channels:[]});render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport}/>);enterKey();fireEvent.click(screen.getByRole('button',{name:'Discover LinkedIn profiles'}));
 await waitFor(()=>expect(screen.getByLabelText('Buffer API key')).toHaveProperty('value',''));expect(screen.queryByRole('button',{name:'Connect selected profile'})).toBeNull();expect(f.transport).toHaveBeenCalledTimes(1);
});
it('disconnects only on request, clears secrets and preserves the remote schedule warning',async()=>{
 const f=fixture();await f.client.refresh();const disconnected=vi.fn();render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport} reconnectAccountId={id} onDisconnected={disconnected}/>);enterKey();
 fireEvent.click(screen.getByRole('button',{name:'Disconnect account (remote schedules remain)'}));await waitFor(()=>expect(disconnected).toHaveBeenCalledTimes(1));
 expect(f.transport.mock.calls.map(([input])=>input)).toEqual([{operation:'disconnect',accountId:id}]);expect(screen.getByLabelText('Buffer API key')).toHaveProperty('value','');expect(screen.getByRole('status').textContent).toMatch(/remote schedules may remain/u);
});
it.each(['logout','unmount'] as const)('does not project a late discovered profile after %s',async mode=>{
 const f=fixture();await f.client.refresh();const pending=Promise.withResolvers<SocialPublisherConnectionResult>();f.transport.mockImplementationOnce(async()=>pending.promise);
 const view=render(<BrowserSocialPublisherConnection client={f.client} transport={f.transport}/>);enterKey();const key=screen.getByLabelText('Buffer API key');
 fireEvent.click(screen.getByRole('button',{name:'Discover LinkedIn profiles'}));
 if(mode==='unmount')view.unmount();else await act(async()=>{f.logout();await expect(f.client.refresh()).rejects.toThrow('session_changed');});
 await act(async()=>{pending.resolve({state:'channels',channels:[channel]});});
 expect(key).toHaveProperty('value','');expect(screen.queryByRole('radio')).toBeNull();expect(f.transport).toHaveBeenCalledTimes(1);
});
