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

it('reads exact open opportunities for an explicitly selected firm without invoking inference',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'firm',name:'Orion',firmId:one}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'opportunities',scope:{firmId:one},dateBasis:'opportunity_opened_at',count:'2',records:[],truncated:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}});
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Record kind'),{target:{value:'firms'}});fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Orion'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Orion'}));fireEvent.click(screen.getByRole('button',{name:'Open opportunities'}));
 expect(await screen.findByText('2 open opportunities')).toBeTruthy();
 expect(screen.getByText('Exact CRM state. Conversation coverage is unverified.')).toBeTruthy();
 expect(read).toHaveBeenLastCalledWith({operation:'opportunities',scope:{firmId:one},status:'open',limit:20});
});

it('shows exact task counts without claiming the acquired conversations are complete',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'firm',name:'Orion',firmId:one}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'tasks',scope:{firmId:one},dateBasis:'task_due_at',count:'1',records:[{key:`callback:${two}`,kind:'callback',label:'callback',dueAt:'2026-10-20T14:00:00.000Z',status:'open'}],truncated:false,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}});
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Record kind'),{target:{value:'firms'}});fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Orion'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Orion'}));fireEvent.click(screen.getByRole('button',{name:'Open work'}));
 expect(await screen.findByText('1 open tasks')).toBeTruthy();expect(screen.getByText(/callback · 2026-10-20/u)).toBeTruthy();
 expect(read).toHaveBeenLastCalledWith({operation:'tasks',scope:{firmId:one},limit:20});
});

it('requires a fresh record selection after changing identity search',async()=>{
 const read=vi.fn<AskPorts['read']>(async()=>({operation:'records',selection:'single',records:[{recordId:one,kind:'firm',name:'Orion',firmId:one}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}));
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Record kind'),{target:{value:'firms'}});fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Orion'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Orion'}));
 expect(screen.getByRole('button',{name:'Open opportunities'})).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Different firm'}});
 expect(screen.queryByRole('button',{name:'Open opportunities'})).toBeNull();
 expect(screen.queryByRole('heading',{name:'Orion'})).toBeNull();
});

it('shows verified reply evidence without claiming unanswered mail from partial coverage',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'firm',name:'Orion',firmId:one}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'reply_status',scope:{firmId:one},dateBasis:'provider_event_at',verifiedOutgoingCount:'2',withoutVerifiedReplyCount:'1',unanswered:'not_established',truncated:false,coverage:{scope:'authorized_progress_receipts',acquisition:'partial',semantic:'not_requested'}});
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Record kind'),{target:{value:'firms'}});fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Orion'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Orion'}));fireEvent.click(screen.getByRole('button',{name:'Reply evidence'}));
 expect(await screen.findByText('1 verified outgoing messages lack a verified reply receipt.')).toBeTruthy();
 expect(screen.getByText('This does not establish unanswered mail; captured history is partial.')).toBeTruthy();
 expect(read).toHaveBeenLastCalledWith({operation:'reply_status',scope:{firmId:one}});
});

it('reads dated operational activity for an explicitly selected firm',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'firm',name:'Orion',firmId:one}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'activity',scope:{firmId:one},dateBasis:'operational_event_at',events:[{key:`call:${two}`,at:'2026-10-08T15:00:00.000Z',kind:'call',code:'connected',detail:'Asked about maintenance',cursor:'2026-10-08T15:00:00.000000|call|example'}],nextBefore:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}});
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Record kind'),{target:{value:'firms'}});fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Orion'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Select Orion'}));fireEvent.click(screen.getByRole('button',{name:'Activity'}));
 expect(await screen.findByText('2026-10-08T15:00:00.000Z · call · Asked about maintenance')).toBeTruthy();
 expect(screen.getByText('Operational event dates. Conversation coverage is unverified.')).toBeTruthy();
 expect(read).toHaveBeenLastCalledWith({operation:'activity',scope:{firmId:one}});
});

it('loads another bounded identity page without treating a later match as globally unique',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>({operation:'records',selection:'unresolved',records:input.operation==='records'&&input.afterId===one?[{recordId:two,kind:'person',name:'Alex Later',firmId:null}]:[],nextAfterId:input.operation==='records'&&input.afterId===one?null:one,scanComplete:input.operation==='records'&&input.afterId===one,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}));
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Alex'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));
 fireEvent.click(await screen.findByRole('button',{name:'Next record page'}));
 expect(await screen.findByRole('button',{name:'Select Alex Later'})).toBeTruthy();
 expect(screen.queryByRole('heading',{name:'Alex Later'})).toBeNull();
 expect(read).toHaveBeenLastCalledWith({operation:'records',query:'Alex',kind:'people',limit:20,afterId:one});
});

it('lets the user search the next bounded copied-source page',async()=>{
 const read=vi.fn<AskPorts['read']>(async input=>input.operation==='records'?{operation:'records',selection:'single',records:[{recordId:one,kind:'person',name:'Alex',firmId:null}],nextAfterId:null,scanComplete:true,coverage:{scope:'current_permitted_crm_state',acquisition:'unverified',semantic:'not_requested'}}:{operation:'passages',scope:{personId:one},passages:[],nextAfterSourceId:input.operation==='passages'&&'afterSourceId' in input.scope?null:two,truncated:false,coverage:{scope:'selected_person_copies',acquisition:'unverified',semantic:'not_requested',scanComplete:input.operation==='passages'&&'afterSourceId' in input.scope,unavailableSources:0,omittedSignatures:0,chunkerVersion:'lexical-original-v1'}});
 render(<Ask ports={{read}} privacyKey="owner:1" enabled/>);
 fireEvent.change(screen.getByLabelText('Find a person or firm'),{target:{value:'Alex'}});fireEvent.click(screen.getByRole('button',{name:'Find records'}));fireEvent.click(await screen.findByRole('button',{name:'Select Alex'}));
 fireEvent.change(screen.getByLabelText('Search original passages'),{target:{value:'maintenance'}});fireEvent.click(screen.getByRole('button',{name:'Find passages'}));
 fireEvent.click(await screen.findByRole('button',{name:'Next copied-source page'}));
 await waitFor(()=>expect(read).toHaveBeenLastCalledWith({operation:'passages',scope:{personId:one,afterSourceId:two},query:'maintenance',limit:20}));
});
