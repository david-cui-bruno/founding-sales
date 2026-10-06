// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {SocialAccounts,type AccountPorts} from '../src/renderer/social/SocialAccounts.tsx';
afterEach(cleanup);
it('connects only on a click and preserves the same IDs on an ambiguous retry',async()=>{
 const connect=vi.fn<AccountPorts['connect']>().mockResolvedValueOnce({accepted:false,reason:'offline'}).mockResolvedValueOnce({accepted:true,reason:null});const changed=vi.fn();
 render(<SocialAccounts accounts={[]} onChanged={changed} ports={{connect,disconnect:vi.fn()}}/>);
 expect(connect).not.toHaveBeenCalled();fireEvent.click(screen.getByText('Connect LinkedIn'));fireEvent.click(await screen.findByText('Retry connection'));
 await waitFor(()=>expect(changed).toHaveBeenCalledOnce());expect(connect.mock.calls[0]).toEqual(connect.mock.calls[1]);expect(screen.getByText(/Scheduling still needs verification/)).toBeTruthy();
});
