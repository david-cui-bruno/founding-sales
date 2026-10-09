// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {Ask,type AskPorts} from '../src/renderer/ask/Ask.tsx';
afterEach(cleanup);
const one='11111111-1111-4111-8111-111111111111',two='22222222-2222-4222-8222-222222222222';
it('lets the user find records without silently choosing an ambiguous person',async()=>{
 const read=vi.fn<AskPorts['read']>(async()=>({operation:'records',selection:'ambiguous',records:[{recordId:one,kind:'person',name:'Alex Lee',firmId:null},{recordId:two,kind:'person',name:'Alex Lee',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}));
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Alex'}});
 fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 await waitFor(()=>expect(screen.getByText('Choose a record; these names are not unique.')).toBeTruthy());
 expect(screen.getAllByRole('button',{name:/Select Alex Lee/u})).toHaveLength(2);
 expect(read).toHaveBeenCalledTimes(1);expect(read).toHaveBeenCalledWith({operation:'records',query:'Alex',kind:'people',limit:20});
});
