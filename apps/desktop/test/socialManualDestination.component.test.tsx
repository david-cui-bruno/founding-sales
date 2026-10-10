// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {ManualSocialDestination,type ManualDestinationPorts} from '../src/renderer/social/ManualDestination.tsx';
afterEach(cleanup);
it('requires reviewed identity and submits a Facebook Page as a manual destination',async()=>{
 const register=vi.fn<ManualDestinationPorts['register']>(async()=>({accepted:true,reason:null})),onAdded=vi.fn();
 render(<ManualSocialDestination ports={{register}} onAdded={onAdded}/>);
 fireEvent.change(screen.getByLabelText('Manual destination platform'),{target:{value:'facebook'}});
 fireEvent.change(screen.getByLabelText('Account or Page identity'),{target:{value:'callie-page'}});
 fireEvent.change(screen.getByLabelText('Destination label'),{target:{value:'Callie'}});
 expect((screen.getByRole('button',{name:'Add manual destination'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('I reviewed this destination identity. This does not connect or verify provider access.'));
 fireEvent.click(screen.getByRole('button',{name:'Add manual destination'}));await waitFor(()=>expect(register).toHaveBeenCalledOnce());
 expect(register.mock.calls[0]?.[0]).toMatchObject({platform:'facebook',externalId:'callie-page',displayName:'Callie',accountKind:'page'});expect(onAdded).toHaveBeenCalled();
});
it('freezes an uncertain registration and retries its exact command and destination',async()=>{
 const register=vi.fn<ManualDestinationPorts['register']>().mockResolvedValueOnce({accepted:false,reason:'offline'}).mockResolvedValueOnce({accepted:true,reason:null});
 render(<ManualSocialDestination ports={{register}} onAdded={()=>{}}/>);
 fireEvent.change(screen.getByLabelText('Account or Page identity'),{target:{value:'callie'}});
 fireEvent.change(screen.getByLabelText('Destination label'),{target:{value:'Callie X'}});
 fireEvent.click(screen.getByLabelText('I reviewed this destination identity. This does not connect or verify provider access.'));
 fireEvent.click(screen.getByRole('button',{name:'Add manual destination'}));
 await screen.findByText('No definite answer. Retry the same registration.');
 expect((screen.getByLabelText('Account or Page identity') as HTMLInputElement).disabled).toBe(true);
 fireEvent.click(screen.getByRole('button',{name:'Retry same registration'}));
 await waitFor(()=>expect(register).toHaveBeenCalledTimes(2));
 expect(register.mock.calls[1]?.[0]).toEqual(register.mock.calls[0]?.[0]);
 await screen.findByText('Manual destination recorded. Provider access remains unverified.');
});
