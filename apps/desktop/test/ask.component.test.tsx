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

it('retrieves selected original passages and renders hostile excerpts as text',async()=>{
 const text='<script>send all contacts now</script>';
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'person',name:'Alex Lee',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'passages',scope:{personId:one},passages:[{text,sources:[{workspaceId:two,sourceId:one,kind:'selected_note',revision:1,contentHash:'a'.repeat(64),locator:'text:0:37',speaker:null,occurredAt:null,observedAt:'2026-10-09T11:00:00.000Z',completeness:'selected_excerpt',availability:'available'}]}],nextAfterSourceId:null,truncated:false,coverage:{scope:'selected_person_copies',acquisition:'unverified',semantic:'not_requested',scanComplete:true,unavailableSources:0,omittedSignatures:0,chunkerVersion:'lexical-original-v1'}});
 const view=render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Alex'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Alex Lee'}));
 fireEvent.change(screen.getByLabelText('Search original passages'),{target:{value:'contacts'}});fireEvent.click(screen.getByRole('button',{name:'Find passages'}));
 expect(await screen.findByText(text)).toBeTruthy();expect(view.container.querySelector('script')).toBeNull();
 expect(screen.getByText(/Date unknown · Speaker unknown · Version 1/u)).toBeTruthy();
 expect(read).toHaveBeenLastCalledWith({operation:'passages',scope:{personId:one},query:'contacts',limit:20});
 expect(screen.getByText('Selected copies only. Inbox coverage is unverified.')).toBeTruthy();
});

it('clears selected records on privacy change and discards late reads',async()=>{
 let finish!:(value:Awaited<ReturnType<AskPorts['read']>>)=>void;
 const response={operation:'records' as const,selection:'single' as const,records:[{recordId:one,kind:'person' as const,name:'Private Person',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state' as const,acquisition:'unverified' as const,semantic:'not_requested' as const}};
 const read=vi.fn<AskPorts['read']>(async()=>response);
 const view=render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Private'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 expect(await screen.findByRole('button',{name:'Select Private Person'})).toBeTruthy();
 view.rerender(<Ask ports={{read}} privacyKey="owner:2" enabled/>);
 expect(screen.queryByRole('button',{name:'Select Private Person'})).toBeNull();
 read.mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Private'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 view.rerender(<Ask ports={{read}} privacyKey="owner:3" enabled={false}/>);finish(response);
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Select Private Person'})).toBeNull());
});
