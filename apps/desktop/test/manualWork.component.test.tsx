// @vitest-environment jsdom
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {z} from 'zod';
import type {askActionPageSchema} from '@fss/contracts';
import {ManualWork,type ManualWorkPorts} from '../src/renderer/ask/ManualWork.tsx';
afterEach(cleanup);
const actionId='11111111-1111-4111-8111-111111111111',personId='22222222-2222-4222-8222-222222222222';
const page:z.infer<typeof askActionPageSchema>={items:[{actionId,version:2,kind:'task',status:'open',provenance:'human',createdAt:'2026-10-09T11:00:00.000Z',updatedAt:'2026-10-09T11:00:00.000Z',completedAt:null,target:{kind:'person',personId},label:'Prepare scheduling options',text:null,due:{kind:'date',date:'2026-10-10',zone:'America/Chicago',expression:'2026-10-10'},reviewRequired:false,supportState:'current',sources:[]}],nextAfterId:null};
it('shows dated owner-private manual tasks as human work distinct from promises',async()=>{
 const actionRead=vi.fn(async()=>page);
 render(<ManualWork scope={{kind:'today'}} ports={{actionRead}} privacyKey='owner:1' enabled/>);
 expect(await screen.findByText('Prepare scheduling options')).toBeTruthy();
 expect(screen.getByText('Manual task · open')).toBeTruthy();
 expect(screen.getByText('Due 2026-10-10 (America/Chicago)')).toBeTruthy();
 expect(actionRead).toHaveBeenCalledWith({scope:{kind:'today'},limit:20});
 expect(screen.queryByText(/Promise/u)).toBeNull();
});

it('completes manual work with its current version and refreshes the recorded result',async()=>{
 const completed={...page,items:page.items.map(item=>({...item,version:3,status:'done' as const,completedAt:'2026-10-09T12:00:00.000Z'}))};
 const actionRead=vi.fn<ManualWorkPorts['actionRead']>(async()=>completed).mockResolvedValueOnce(page);
 const actionChange=vi.fn(async()=>({actionId,version:3,status:'done' as const,completedAt:'2026-10-09T12:00:00.000Z'}));
 render(<ManualWork scope={{kind:'person',personId}} ports={{actionRead,actionChange}} privacyKey='owner:1' enabled/>);
 fireEvent.click(await screen.findByRole('button',{name:'Complete manual task'}));
 expect(await screen.findByText('Manual task · done')).toBeTruthy();
 expect(actionChange).toHaveBeenCalledWith({actionId,expectedVersion:2,action:'complete_task'});
 expect(screen.queryByRole('button',{name:'Complete manual task'})).toBeNull();
});

it.each([
 ['task','open','Cancel manual task','cancel_task','cancelled'],
 ['preference','proposed','Dismiss preference proposal','dismiss_preference','dismissed'],
] as const)('explicitly changes %s through its own current-version action',async(kind,status,button,action,closed)=>{
 const current={...page,items:page.items.map(item=>({...item,kind,status,...(kind==='preference'?{target:null,label:null,text:'Prefer weekday calls.',due:null}:{})}))};
 const actionRead=vi.fn<ManualWorkPorts['actionRead']>(async()=>({...current,items:current.items.map(item=>({...item,version:3,status:closed}))})).mockResolvedValueOnce(current);
 const actionChange=vi.fn(async()=>({actionId,version:3,status:closed,completedAt:null}));
 render(<ManualWork scope={{kind:'history'}} ports={{actionRead,actionChange}} privacyKey='owner:1' enabled/>);
 fireEvent.click(await screen.findByRole('button',{name:button}));
 expect(await screen.findByText(kind==='task'?'Manual task · cancelled':'Private preference proposal · dismissed')).toBeTruthy();
 expect(actionChange).toHaveBeenCalledWith({actionId,expectedVersion:2,action});
});

it('shows manual work on the explicitly opened person record',async()=>{
 const {People}=await import('../src/renderer/firms/People.tsx');
 const {peoplePortsFixture}=await import('./support/manualPeopleFixture.ts');
 const actionRead=vi.fn(async()=>page);
 render(<People ports={peoplePortsFixture(personId)} enabled privacyKey='owner:1' {...{manual:{actionRead}}}/>);
 fireEvent.click(await screen.findByRole('button',{name:'Alex Example'}));
 expect(await screen.findByText('Prepare scheduling options')).toBeTruthy();
 expect(actionRead).toHaveBeenCalledWith({scope:{kind:'person',personId},limit:20});
});

it('evicts private work on a fresh access refusal and cannot change its stale task',async()=>{
 const actionRead=vi.fn<ManualWorkPorts['actionRead']>(async()=>page).mockResolvedValueOnce(page).mockRejectedValueOnce(new Error('denied'));
 const actionChange=vi.fn<ManualWorkPorts['actionChange']>();
 render(<ManualWork scope={{kind:'today'}} ports={{actionRead,actionChange}} privacyKey='owner:1' enabled/>);
 expect(await screen.findByText('Prepare scheduling options')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Read manual work'}));
 expect(await screen.findByText('Manual work is unavailable. Read current access again.')).toBeTruthy();
 expect(screen.queryByText('Prepare scheduling options')).toBeNull();
 expect(screen.queryByRole('button',{name:'Complete manual task'})).toBeNull();
 expect(actionChange).not.toHaveBeenCalled();
});
it('ignores a protected read completing after the owner or record changes',async()=>{
 let finish:((value:typeof page)=>void)|undefined;
 const late=new Promise<typeof page>(resolve=>{finish=resolve;});
 const actionRead=vi.fn<ManualWorkPorts['actionRead']>().mockReturnValueOnce(late).mockResolvedValue({items:[],nextAfterId:null});
 const view=render(<ManualWork scope={{kind:'person',personId}} ports={{actionRead}} privacyKey='owner:1' enabled/>);
 view.rerender(<ManualWork scope={{kind:'history'}} ports={{actionRead}} privacyKey='owner:2' enabled/>);
 expect(await screen.findByText('No manual work on this page.')).toBeTruthy();
 await act(async()=>{finish?.(page);await late;});
 expect(screen.queryByText('Prepare scheduling options')).toBeNull();
});
it('shows only neutral status for retired support and no completion or dismissal controls',async()=>{
 const actionRead=vi.fn<ManualWorkPorts['actionRead']>(async()=>({items:[{...page.items[0]!,supportState:'deleted',reviewRequired:true,target:null,label:null,text:null,due:null,sources:[]}],nextAfterId:null}));
 const actionChange=vi.fn<ManualWorkPorts['actionChange']>();
 render(<ManualWork scope={{kind:'history'}} ports={{actionRead,actionChange}} privacyKey='owner:1' enabled/>);
 expect(await screen.findByText('Supporting evidence is deleted. Private content is unavailable.')).toBeTruthy();
 expect(screen.queryByText('Prepare scheduling options')).toBeNull();
 expect(screen.queryByRole('button',{name:'Complete manual task'})).toBeNull();
 expect(screen.queryByRole('button',{name:'Cancel manual task'})).toBeNull();
});
