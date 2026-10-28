// @vitest-environment jsdom
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingSetup} from '../../src/client/CallingSetup.tsx';
import {CallingMicrophoneCheck} from '../../src/client/CallingMicrophoneCheck.tsx';
const id='00000000-0000-4000-8000-000000000001';
const clients:BrowserClient[]=[];
const getUserMedia=vi.fn<typeof navigator.mediaDevices.getUserMedia>();
function fixture(){
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'salesperson',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()};
 const send=vi.fn<typeof fetch>(async url=>{
  if(url==='/browser/session')return Response.json(session);
  if(url==='/browser/api/calling/setup')return Response.json({callingProvider:{provider:'twilio',version:4},telephonyBudget:{dailyCeilingCents:100,maxMinutesPerCall:30,unitPriceMicros:14000,version:2},spentTodayCents:0,configured:true});
  throw Error('Forbidden network effect');
 });
 const client=new BrowserClient({fetch:send,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);return {client,send,session};
}
function stream(){const tracks=[{stop:vi.fn()},{stop:vi.fn()}];return {tracks,value:{getTracks:()=>tracks} as unknown as MediaStream};}
function held(){let finish!:(value:MediaStream)=>void;getUserMedia.mockReturnValueOnce(new Promise(resolve=>{finish=resolve;}));return finish;}
beforeEach(()=>{getUserMedia.mockReset();vi.stubGlobal('isSecureContext',true);Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());localStorage.clear();vi.unstubAllGlobals();});
it('offers an explicit microphone check in setup before a company is selected, stops tracks and starts no call',async()=>{
 const f=fixture(),audio=stream();getUserMedia.mockResolvedValueOnce(audio.value);await f.client.refresh();render(<CallingSetup client={f.client}/>);
 await screen.findByText('On · Twilio');expect(getUserMedia).not.toHaveBeenCalled();expect(screen.queryByRole('button',{name:'Enable browser calling'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));await screen.findByText('Microphone access is available. No call or recording started.');
 expect(getUserMedia).toHaveBeenCalledExactlyOnceWith({audio:true,video:false});audio.tracks.forEach(track=>expect(track.stop).toHaveBeenCalledTimes(1));
 expect(f.send.mock.calls.map(([url])=>url).every(url=>url==='/browser/session'||url==='/browser/api/calling/setup')).toBe(true);expect(localStorage.length).toBe(0);
});
it('coalesces pending clicks and gives a generic failure without exposing browser or device details',async()=>{
 const f=fixture();let reject!:(error:Error)=>void;getUserMedia.mockReturnValueOnce(new Promise((_resolve,no)=>{reject=no;}));await f.client.refresh();render(<CallingMicrophoneCheck client={f.client}/>);
 fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));expect(getUserMedia).toHaveBeenCalledTimes(1);
 await act(async()=>{reject(Error('Private device serial and browser exception'));});await screen.findByText('Microphone unavailable. Check your browser permission and try again.');expect(screen.queryByText(/Private device/u)).toBeNull();expect(screen.getByRole('button',{name:'Check microphone'}).matches(':disabled')).toBe(false);expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(['unmount','authority'] as const)('stops late tracks after %s and fences old success',async kind=>{
 const f=fixture(),finish=held(),audio=stream();await f.client.refresh();const view=render(<CallingMicrophoneCheck client={f.client}/>);fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));
 if(kind==='unmount')view.unmount();else act(()=>f.client.invalidate());
 await act(async()=>{finish(audio.value);});audio.tracks.forEach(track=>expect(track.stop).toHaveBeenCalledTimes(1));expect(screen.queryByText(/Microphone access is available/u)).toBeNull();expect(f.send).toHaveBeenCalledTimes(1);
});
it('allows a new authority generation while a prior request is pending without its late finally clearing the new operation',async()=>{
 const f=fixture(),old=held(),oldAudio=stream();await f.client.refresh();render(<CallingMicrophoneCheck client={f.client}/>);fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));
 act(()=>f.client.invalidate());await act(async()=>{await f.client.refresh();});const current=held(),audio=stream();
 await waitFor(()=>expect(screen.getByRole('button',{name:'Check microphone'}).matches(':disabled')).toBe(false));fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));expect(getUserMedia).toHaveBeenCalledTimes(2);
 await act(async()=>{old(oldAudio.value);});expect(screen.getByRole('button',{name:'Check microphone'}).matches(':disabled')).toBe(true);expect(screen.queryByText(/Microphone access is available/u)).toBeNull();
 await act(async()=>{current(audio.value);});await screen.findByText(/Microphone access is available/u);[...oldAudio.tracks,...audio.tracks].forEach(track=>expect(track.stop).toHaveBeenCalledTimes(1));expect(f.send.mock.calls.every(([url])=>url==='/browser/session')).toBe(true);
});
it('refuses insecure or unavailable microphone access without a media request',async()=>{
 vi.stubGlobal('isSecureContext',false);const f=fixture();await f.client.refresh();render(<CallingMicrophoneCheck client={f.client}/>);fireEvent.click(screen.getByRole('button',{name:'Check microphone'}));await screen.findByText(/Microphone unavailable/u);expect(getUserMedia).not.toHaveBeenCalled();
});
