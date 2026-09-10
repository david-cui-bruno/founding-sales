// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { LeadRow, LeadsListResponse } from '../../../shared/contracts/leadsContract';
import type { MutationReceipt } from '../../../shared/contracts/commonContract';
import type { LeadsApi } from '../../../preload/apis/leadsApi';
import { PresentationRoot } from '../../app/PresentationRoot';
import { CommandPalette } from '../../app/commandPalette/CommandPalette';
import { LeadsRoute } from './LeadsRoute';
import { useState } from 'react';
import { LeadInspector } from '../leadInspector/LeadInspector';
import { useLeadMutations, type InlineEditor } from './useLeadMutations';
import * as PageModule from './LeadsPage';
import type { LeadGridState } from './useLeadGridState';
import { LeadInspectorContext } from '../leadInspector/useLeadInspector';
const sizes: (PropertyDescriptor | undefined)[] = [];
beforeAll(() => {
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {configurable:true,value(){this.open=true;}});
  Object.defineProperty(HTMLDialogElement.prototype, "close", {configurable:true,value(){this.open=false;}});
  for (const [key, value] of [['offsetHeight',480],['offsetWidth',960]] as const) {
    sizes.push(Object.getOwnPropertyDescriptor(HTMLElement.prototype,key));
    Object.defineProperty(HTMLElement.prototype,key,{configurable:true,get:()=>value});
  }
});
afterAll(() => { ['offsetHeight','offsetWidth'].forEach((key,i)=>Object.defineProperty(HTMLElement.prototype,key,sizes[i] ?? {})); });
afterEach(cleanup);
const leadRow: LeadRow = {
  personId: 'person-1',
  salesCycleId: 'cycle-1',
  personName: 'Avery Landlord',
  initials: 'AL',
  organization: 'Landlord LLC',
  propertySummary: '12 Benefit St, Providence',
  stage: 'ready',
  source: 'frbo',
  segment: 'hot',
  cloudScores: { fit: 62, timing: 41 },
  priorityContext: {
    priority: 'P1',
    fitPoints: 24,
    fitBand: 'high',
    timingValue: 31,
    timingBand: 'hot',
    reachability: 'direct',
    dataConfidence: 8,
  },
  nextAction: {
    id: 'action-1',
    type: 'call_lead',
    channel: 'call',
    label: 'Call lead',
  },
  optedOut: false,
  lastActivityAt: '2026-08-30T12:00:00.000Z',
};

const rows = Array.from({length:208},(_,i):LeadRow=>({...leadRow,personId:`person-${i+1}`,salesCycleId:`cycle-${i+1}`,personName:`Person ${i+1}`}));
const receipt=(ids:string[]):MutationReceipt=>({revision:2,affectedPersonIds:ids,affectedSalesCycleIds:[]});
function deferred<T>() { let resolve!:(value:T)=>void;let reject!:(error:unknown)=>void; const promise=new Promise<T>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; }
function apiFor(overrides:Partial<LeadsApi>={}):LeadsApi { return {list:vi.fn(async()=>({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1})),updateField:vi.fn(async input=>receipt([input.personId])),bulkUpdate:vi.fn(async input=>receipt(input.personIds)),...overrides}; }
function mount(api:LeadsApi,palette=false) { return render(<PresentationRoot><LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()}/>{palette&&<CommandPalette navigate={vi.fn()} openImport={vi.fn()}/>}</PresentationRoot>); }
async function bulkInput() { fireEvent.click(await screen.findByRole('checkbox',{name:'Select Person 1'}));fireEvent.click(screen.getByRole('button',{name:'Set organization'}));const input=screen.getByRole('textbox',{name:'Organization for 1 selected'});fireEvent.change(input,{target:{value:'Exact organization'}});return input; }
describe('Leads mutation and continuation retention',()=>{
  it('loads the final eight with the exact opaque cursor and retains append failures',async()=>{
    const more=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,200),total:208,nextCursor:'opaque-page-2',revision:1}).mockReturnValueOnce(more.promise).mockResolvedValue({rows:rows.slice(200),total:208,nextCursor:null,revision:1})});mount(api);
    await screen.findByText('Showing 200 of 208');fireEvent.click(screen.getByRole('button',{name:'Load more'}));
    expect(api.list).toHaveBeenLastCalledWith({query:'',stages:[],priorities:[],sort:'priority',cursor:'opaque-page-2',limit:200});
    await act(async()=>more.reject(new Error('private cursor failure')));expect(screen.getByText('Showing 200 of 208')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'Retry more'}));await screen.findByText('Showing 208 of 208');expect(screen.queryByRole('button',{name:'Load more'})).toBeNull();expect(screen.getByRole('grid').getAttribute('aria-rowcount')).toBe('209');
  });
  it('submits all checked identities even when a filter hides one',async()=>{
    const api=apiFor({list:vi.fn(async request=>({rows:request.query?rows.slice(0,1):rows.slice(0,2),total:request.query?1:2,nextCursor:null,revision:1}))});mount(api);
    fireEvent.click(await screen.findByRole('checkbox',{name:'Select Person 1'}));fireEvent.click(screen.getByRole('checkbox',{name:'Select Person 2'}));
    fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Person 1'}});await waitFor(()=>expect(screen.queryByRole('checkbox',{name:'Select Person 2'})).toBeNull());
    expect(screen.getByText(/1 outside view/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Set organization'}));const input=screen.getByRole('textbox',{name:'Organization for 2 selected'});fireEvent.change(input,{target:{value:'Exact organization'}});fireEvent.keyDown(input,{key:'Enter'});
    await waitFor(()=>expect(api.bulkUpdate).toHaveBeenCalledWith({personIds:['person-1','person-2'],field:'organization_label',value:'Exact organization'}));
  });
  it.each(['bulk','name','organization','null'] as const)('retains %s input until acknowledgement and through rejection',async kind=>{
    const pending=deferred<MutationReceipt>();const api=apiFor({updateField:vi.fn(()=>pending.promise),bulkUpdate:vi.fn(()=>pending.promise)});mount(api);await screen.findByText('Person 1');
    let input:HTMLElement;
    if(kind==='bulk')input=await bulkInput();else {fireEvent.doubleClick(kind==='name'?screen.getByText('Person 1'):screen.getAllByText('Landlord LLC')[0]);input=screen.getByRole('textbox',{name:kind==='name'?'Edit name for Person 1':'Edit organization for Person 1'});fireEvent.change(input,{target:{value:kind==='null'?'':'Kept draft'}});}
    fireEvent.keyDown(input,{key:'Enter'});fireEvent.keyDown(input,{key:'Enter'});fireEvent.blur(input);fireEvent.keyDown(input,{key:'Escape'});
    expect(input.isConnected).toBe(true);expect((kind==='bulk'?api.bulkUpdate:api.updateField)).toHaveBeenCalledTimes(1);
    const captured=kind==='bulk'?{personIds:['person-1'],field:'organization_label',value:'Exact organization'}:{personId:'person-1',field:kind==='name'?'person_name':'organization_label',value:kind==='null'?null:'Kept draft'};
    expect(kind==='bulk'?api.bulkUpdate:api.updateField).toHaveBeenCalledWith(captured);
    await act(async()=>pending.reject(new Error('sensitive backend detail')));expect(input.isConnected).toBe(true);expect(screen.getByRole('alert').textContent).toContain('Your input is kept');expect(screen.queryByText(/sensitive backend/)).toBeNull();
  });
  it('does not clear checks or draft for a mismatched receipt',async()=>{
    const api=apiFor({bulkUpdate:vi.fn(async()=>receipt(['person-2']))});mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});await screen.findByRole('alert');expect(input.isConnected).toBe(true);expect((screen.getByRole('checkbox',{name:'Select Person 1'}) as HTMLInputElement).checked).toBe(true);
  });
  it('reports saved separately when refresh fails without resubmitting',async()=>{
    const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}).mockRejectedValue(new Error('read failed'))});mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});await screen.findByText('Saved; list refresh failed');expect(api.bulkUpdate).toHaveBeenCalledTimes(1);expect(screen.queryByRole('textbox',{name:/Organization for/})).toBeNull();
  });
  it('retains hidden inline work after filtering and offers unfinished-edit recovery',async()=>{
    const pending=deferred<MutationReceipt>();const api=apiFor({list:vi.fn(async request=>({rows:request.query?[]:rows.slice(0,2),total:request.query?0:2,nextCursor:null,revision:1})),updateField:vi.fn(()=>pending.promise)});mount(api);fireEvent.doubleClick(await screen.findByText('Person 1'));let input=screen.getByRole('textbox',{name:'Edit name for Person 1'});fireEvent.change(input,{target:{value:'Kept hidden'}});fireEvent.keyDown(input,{key:'Enter'});fireEvent.change(screen.getByRole('searchbox'),{target:{value:'missing'}});
    await screen.findByText('Unfinished edit');input=screen.getByRole('textbox',{name:'Edit name for Person 1'});expect((input as HTMLInputElement).value).toBe('Kept hidden');await act(async()=>pending.reject(new Error('unknown')));expect(input.isConnected).toBe(true);expect(api.updateField).toHaveBeenCalledTimes(1);
  });
  it('keeps failed bulk input and checked IDs when real palette owns Escape',async()=>{
    const api=apiFor({bulkUpdate:vi.fn(async()=>{throw new Error('unknown');})});mount(api,true);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});await screen.findByRole('alert');const checkbox=screen.getByRole('checkbox',{name:'Select Person 1'});fireEvent.keyDown(checkbox,{key:'k',ctrlKey:true,metaKey:true});await screen.findByRole('dialog');fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(input.isConnected).toBe(true);expect((input as HTMLInputElement).value).toBe('Exact organization');expect((checkbox as HTMLInputElement).checked).toBe(true);
  });
});


it('blocks more than 200 exact checked identities without chunking or clearing work', async () => {
  const api = apiFor({list:vi.fn(async request => {
    const index = request.query ? Number(request.query)-1 : 0;
    return { rows:[rows[index]], total:1, nextCursor:null, revision:1 };
  })}); mount(api);
  for(let i=1;i<=201;i++) {
    if(i>1)fireEvent.change(screen.getByRole('searchbox'),{target:{value:String(i)}});
    fireEvent.click(await screen.findByRole('checkbox',{name:`Select Person ${i}`}));
  }
  fireEvent.click(screen.getByRole('button',{name:'Set organization'}));
  const input=screen.getByRole('textbox',{name:'Organization for 201 selected'});
  fireEvent.change(input,{target:{value:'Retain all'}});fireEvent.keyDown(input,{key:'Enter'});
  await screen.findByText('Select 200 or fewer people for one update. No records submitted.');
  expect(api.bulkUpdate).not.toHaveBeenCalled();expect((input as HTMLInputElement).value).toBe('Retain all');
  expect(screen.getByText(/201 selected/)).toBeTruthy();
},15000);

it('keeps checks and draft on missing or extra receipt identities then retries only deliberately', async () => {
  const api=apiFor({bulkUpdate:vi.fn().mockResolvedValueOnce(receipt([])).mockResolvedValueOnce(receipt(['person-1','person-2'])).mockResolvedValueOnce(receipt(['person-1']))});
  mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});await screen.findByRole('alert');
  expect(api.bulkUpdate).toHaveBeenCalledTimes(1);expect(input.isConnected).toBe(true);
  fireEvent.keyDown(input,{key:'Enter'});await waitFor(()=>expect(api.bulkUpdate).toHaveBeenCalledTimes(2));await screen.findByRole('alert');expect(input.isConnected).toBe(true);
  fireEvent.keyDown(input,{key:'Enter'});await waitFor(()=>expect(screen.queryByRole('textbox',{name:/Organization for/})).toBeNull());expect(api.bulkUpdate).toHaveBeenCalledTimes(3);
});

it('fences Clear, checkbox and a second editor while a bulk request is unresolved', async () => {
  const pending=deferred<MutationReceipt>();const api=apiFor({bulkUpdate:vi.fn(()=>pending.promise)});mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});
  fireEvent.click(screen.getByRole('button',{name:'Clear'}));fireEvent.click(screen.getByRole('checkbox',{name:'Select Person 2'}));fireEvent.doubleClick(screen.getByText('Person 2'));
  expect((screen.getByRole('checkbox',{name:'Select Person 1'}) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('checkbox',{name:'Select Person 2'}) as HTMLInputElement).checked).toBe(false);
  expect(screen.queryByRole('textbox',{name:'Edit name for Person 2'})).toBeNull();expect(input.isConnected).toBe(true);
  await act(async()=>pending.reject(new Error('unknown')));fireEvent.click(screen.getByRole('button',{name:'Cancel organization'}));expect(input.isConnected).toBe(false);expect(api.bulkUpdate).toHaveBeenCalledTimes(1);
});

it('ignores late append after changing query and retains identity selection', async () => {
  const pending=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn(async request => {
    if(request.query)return {rows:[rows[2]],total:1,nextCursor:null,revision:2};
    if(request.cursor)return pending.promise;
    return {rows:rows.slice(0,2),total:208,nextCursor:'next',revision:1};
  })});mount(api);fireEvent.click(await screen.findByRole('checkbox',{name:'Select Person 1'}));fireEvent.click(screen.getByRole('button',{name:'Load more'}));fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Person 3'}});
  await screen.findByRole('checkbox',{name:'Select Person 3'});await act(async()=>pending.resolve({rows:rows.slice(2),total:208,nextCursor:null,revision:1}));
  expect(screen.getByText('Showing 1 of 1')).toBeTruthy();expect(screen.getByText(/1 selected.*1 outside view/)).toBeTruthy();expect(screen.queryByRole('checkbox',{name:'Select Person 2'})).toBeNull();
});

it.each(['bulk','name','organization'] as const)('allows the actual palette shortcut from focused %s editor without changing draft',async kind=>{
  const api=apiFor();mount(api,true);await screen.findByText('Person 1');
  let input:HTMLElement;
  if(kind==='bulk')input=await bulkInput();else {fireEvent.doubleClick(kind==='name'?screen.getByText('Person 1'):screen.getAllByText('Landlord LLC')[0]);input=screen.getByRole('textbox',{name:kind==='name'?'Edit name for Person 1':'Edit organization for Person 1'});fireEvent.change(input,{target:{value:'Shortcut draft'}});}
  input.focus();fireEvent.keyDown(input,{key:'k',ctrlKey:true,metaKey:true});
  await screen.findByRole('dialog');expect(input.isConnected).toBe(true);expect((input as HTMLInputElement).value).toBe(kind==='bulk'?'Exact organization':'Shortcut draft');
  expect(api.updateField).not.toHaveBeenCalled();expect(api.bulkUpdate).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});expect(input.isConnected).toBe(true);
});

it('does not cancel a live append merely because the user selects a loaded row',async()=>{
  const more=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:3,nextCursor:'next',revision:1}).mockReturnValueOnce(more.promise)});mount(api);
  await screen.findByText('Showing 2 of 3');fireEvent.click(screen.getByRole('button',{name:'Load more'}));fireEvent.click(screen.getByRole('row',{name:/Person 1/}));
  await act(async()=>more.resolve({rows:[rows[2]],total:3,nextCursor:null,revision:1}));expect(screen.getByText('Showing 3 of 3')).toBeTruthy();
});
it('submits nothing if the last checked person is unchecked with an idle bulk editor open',async()=>{
  const api=apiFor();mount(api);const input=await bulkInput();fireEvent.click(screen.getByRole('checkbox',{name:'Select Person 1'}));fireEvent.keyDown(input,{key:'Enter'});await screen.findByText('Select at least one person. No records submitted.');expect(api.bulkUpdate).not.toHaveBeenCalled();expect(input.isConnected).toBe(true);
});

it('keyboard-opens appended person 208 through the real virtual grid',async()=>{
  const api=apiFor({list:vi.fn(async request=>({rows:request.cursor?rows.slice(200):rows.slice(0,200),total:208,nextCursor:request.cursor?null:'opaque-next',revision:1}))});
  const onOpenLead=vi.fn();const view=render(<PresentationRoot><LeadsRoute api={api} onOpenLead={onOpenLead} onOpenImport={vi.fn()}/></PresentationRoot>);
  await screen.findByText('Showing 200 of 208');fireEvent.click(screen.getByRole('button',{name:'Load more'}));await screen.findByText('Showing 208 of 208');
  const scroll=view.container.querySelector('.leads-grid__scroll') as HTMLElement;
  Object.defineProperty(scroll,'scrollHeight',{configurable:true,value:208*46});
  Object.defineProperty(scroll,'clientHeight',{configurable:true,value:480});
  scroll.scrollTo=((options:ScrollToOptions|number,top?:number)=>{scroll.scrollTop=typeof options==='number'?top ?? 0:options.top ?? 0;fireEvent.scroll(scroll);}) as typeof scroll.scrollTo;
  fireEvent.scroll(scroll,{target:{scrollTop:9000}});
  const before=await screen.findByRole('row',{name:/Person 207 /});before.focus();fireEvent.keyDown(before,{key:'ArrowDown'});
  const last=await screen.findByRole('row',{name:/Person 208 /});await waitFor(()=>expect(document.activeElement).toBe(last));fireEvent.keyDown(last,{key:'Enter'});expect(onOpenLead).toHaveBeenCalledWith('person-208');
});

it.each([['priority','Priority'],['person_name','Name'],['last_contact','Last contact']] as const)('continues %s with identical current filters and opaque cursor',async(sort,label)=>{
  const api=apiFor({list:vi.fn(async request=>({rows:request.cursor?[rows[2]]:rows.slice(0,2),total:3,nextCursor:request.cursor?null:`opaque-${request.sort}`,revision:1}))});mount(api);await screen.findByText('Showing 2 of 3');
  fireEvent.click(screen.getByRole('combobox',{name:'Sort leads'}));fireEvent.click(screen.getByRole('option',{name:label}));
  fireEvent.click(screen.getByRole('button',{name:/^Ready/}));await waitFor(()=>expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({sort,stages:['ready'],cursor:null})));
  await screen.findByText('Showing 2 of 3');fireEvent.click(screen.getByRole('button',{name:'Load more'}));await screen.findByText('Showing 3 of 3');expect(api.list).toHaveBeenLastCalledWith({query:'',stages:['ready'],priorities:[],sort,cursor:`opaque-${sort}`,limit:200});
});

it('submits first and last-page checked identities exactly after filtering away the last page',async()=>{
  const api=apiFor({list:vi.fn(async request=>({rows:request.query?[rows[0]]:request.cursor?rows.slice(200):rows.slice(0,200),total:request.query?1:208,nextCursor:request.query||request.cursor?null:'opaque-next',revision:1}))});const view=mount(api);
  fireEvent.click(await screen.findByRole('checkbox',{name:'Select Person 1'}));fireEvent.click(screen.getByRole('button',{name:'Load more'}));await screen.findByText('Showing 208 of 208');
  const scroll=view.container.querySelector('.leads-grid__scroll') as HTMLElement;fireEvent.scroll(scroll,{target:{scrollTop:9000}});
  fireEvent.click(await screen.findByRole('checkbox',{name:'Select Person 208'}));fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Person 1'}});await screen.findByText('Showing 1 of 1');
  expect(screen.getByText(/2 selected.*1 outside view/)).toBeTruthy();fireEvent.click(screen.getByRole('button',{name:'Set organization'}));const input=screen.getByRole('textbox',{name:'Organization for 2 selected'});fireEvent.change(input,{target:{value:'Cross page'}});fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(api.bulkUpdate).toHaveBeenCalledWith({personIds:['person-1','person-208'],field:'organization_label',value:'Cross page'}));expect(api.bulkUpdate).toHaveBeenCalledTimes(1);
});
it('retains a pending then rejected inline draft when its real virtual row leaves the viewport',async()=>{
  const pending=deferred<MutationReceipt>();const api=apiFor({list:vi.fn(async()=>({rows:rows.slice(0,200),total:208,nextCursor:'opaque',revision:1})),updateField:vi.fn(()=>pending.promise)});const view=mount(api);
  fireEvent.doubleClick(await screen.findByText('Person 1'));const input=screen.getByRole('textbox',{name:'Edit name for Person 1'});fireEvent.change(input,{target:{value:'Virtual draft'}});fireEvent.keyDown(input,{key:'Enter'});
  const scroll=view.container.querySelector('.leads-grid__scroll') as HTMLElement;fireEvent.scroll(scroll,{target:{scrollTop:8000}});await screen.findByText('Unfinished edit');
  const recovered=screen.getByRole('textbox',{name:'Edit name for Person 1'});expect((recovered as HTMLInputElement).value).toBe('Virtual draft');expect(screen.getAllByRole('textbox',{name:'Edit name for Person 1'})).toHaveLength(1);
  await act(async()=>pending.reject(new Error('unknown')));expect(recovered.isConnected).toBe(true);expect(api.updateField).toHaveBeenCalledTimes(1);
});

it('does not confirm a malformed receipt even when its target IDs match',async()=>{
  const api=apiFor({bulkUpdate:vi.fn(async()=>({...receipt(['person-1']),revision:'invalid'} as unknown as MutationReceipt))});mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});await screen.findByRole('alert');expect(input.isConnected).toBe(true);expect((screen.getByRole('checkbox',{name:'Select Person 1'}) as HTMLInputElement).checked).toBe(true);
});
it('prevents a same-turn old-cursor append after explicit refresh has started',async()=>{
  const pending=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:3,nextCursor:'old',revision:1}).mockReturnValue(pending.promise)});mount(api);await screen.findByText('Showing 2 of 3');
  const more=screen.getByRole('button',{name:'Load more'});const refresh=screen.getByRole('button',{name:'Refresh list'});
  act(()=>{fireEvent.click(refresh);fireEvent.click(more);});
  expect(api.list).toHaveBeenCalledTimes(2);expect(api.list).toHaveBeenLastCalledWith(expect.objectContaining({cursor:null}));
  await act(async()=>pending.resolve({rows:rows.slice(0,2),total:2,nextCursor:null,revision:2}));
});

it('does not label a superseded post-save refresh as failed after new controls succeed',async()=>{
  const read=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}).mockReturnValueOnce(read.promise).mockResolvedValue({rows:[rows[0]],total:1,nextCursor:null,revision:2})});mount(api);const input=await bulkInput();fireEvent.keyDown(input,{key:'Enter'});
  await waitFor(()=>expect(api.list).toHaveBeenCalledTimes(2));fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Person 1'}});await screen.findByText('Showing 1 of 1');await act(async()=>read.reject(new Error('superseded read')));
  expect(screen.getByText('Saved')).toBeTruthy();expect(screen.queryByText('Saved; list refresh failed')).toBeNull();expect(api.bulkUpdate).toHaveBeenCalledTimes(1);
});


it.each(['resolve','reject'] as const)('keeps an actual active Person header append alive on %s',async outcome=>{
  const pending=deferred<LeadsListResponse>();
  const api=apiFor({list:vi.fn(async request=>request.cursor?pending.promise:{rows:rows.slice(0,2),total:3,nextCursor:'same-sort-next',revision:1})});
  mount(api);await screen.findByText('Showing 2 of 3');fireEvent.click(screen.getByRole('button',{name:'Person'}));await waitFor(()=>expect(api.list).toHaveBeenCalledTimes(2));await screen.findByText('Showing 2 of 3');
  fireEvent.click(screen.getByRole('button',{name:'Load more'}));fireEvent.click(screen.getByRole('button',{name:'Person'}));
  if(outcome==='resolve'){await act(async()=>pending.resolve({rows:[rows[2]],total:3,nextCursor:null,revision:1}));await screen.findByText('Showing 3 of 3');}
  else {await act(async()=>pending.reject(new Error('safe append failure')));expect(await screen.findByRole('button',{name:'Retry more'})).toBeTruthy();}
  expect(api.list).toHaveBeenCalledTimes(3);
  expect(api.list).toHaveBeenLastCalledWith({query:'',stages:[],priorities:[],sort:'person_name',cursor:'same-sort-next',limit:200});
});

it('keeps an actual already-selected All first-page read alive',async()=>{
  const pending=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn(()=>pending.promise)});mount(api);
  fireEvent.click(screen.getByRole('button',{name:/^All/}));
  await act(async()=>pending.resolve({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}));
  await screen.findByText('Showing 2 of 2');expect(api.list).toHaveBeenCalledTimes(1);
});

// Targeted page-prop seam: exposes otherwise unreachable equivalent array inputs,
// while still rendering the actual Page and exercising real Route read ownership.
it.each(['query','sort','stages','priorities'] as const)('preserves pending read and review registration for canonical %s no-ops',async control=>{
  let state!:LeadGridState;const ActualPage=PageModule.LeadsPage;
  const page=vi.spyOn(PageModule,'LeadsPage').mockImplementation(props=>{state=props.state;return <ActualPage {...props}/>;});
  const dispose=vi.fn();const register=vi.fn(()=>dispose);
  const pending=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn(async request=>request.cursor?pending.promise:{rows:rows.slice(0,2),total:3,nextCursor:'canonical-next',revision:1})});
  try {
    render(<PresentationRoot><LeadInspectorContext.Provider value={{openLead:vi.fn(),openFullPage:vi.fn(),closeLead:vi.fn(),selectedPersonId:null,setReviewAdvance:register}}><LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()}/></LeadInspectorContext.Provider></PresentationRoot>);
    await screen.findByText('Showing 2 of 3');
    if(control==='stages')act(()=>state.setStages(['ready','unreviewed']));
    if(control==='priorities')act(()=>state.setPriorities(['P1','P2']));
    await screen.findByText('Showing 2 of 3');
    fireEvent.click(screen.getByRole('button',{name:'Load more'}));
    const reads=vi.mocked(api.list).mock.calls.length;const registrations=register.mock.calls.length;const disposals=dispose.mock.calls.length;
    act(()=>{
      if(control==='query')state.setQuery('');
      if(control==='sort')state.setSort('priority');
      if(control==='stages')state.setStages(['unreviewed','ready','unreviewed']);
      if(control==='priorities')state.setPriorities(['P2','P1','P2']);
    });
    expect(register).toHaveBeenCalledTimes(registrations);expect(dispose).toHaveBeenCalledTimes(disposals);
    await act(async()=>pending.resolve({rows:[rows[2]],total:3,nextCursor:null,revision:1}));await screen.findByText('Showing 3 of 3');expect(api.list).toHaveBeenCalledTimes(reads);
    act(()=>state.setQuery('a genuinely different query'));
    await waitFor(()=>expect(api.list).toHaveBeenCalledTimes(reads+1));expect(dispose.mock.calls.length).toBeGreaterThan(disposals);expect(register.mock.calls.length).toBeGreaterThan(registrations);
  } finally {cleanup();page.mockRestore();}
});


it('keeps Search focus through passive recovery in both directions and resumes only deliberately',async()=>{
  const read=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}).mockReturnValue(read.promise)});mount(api);
  fireEvent.doubleClick(await screen.findByText('Person 1'));const input=screen.getByRole('textbox',{name:'Edit name for Person 1'});expect(document.activeElement).toBe(input);
  fireEvent.change(input,{target:{value:'Preserved exact draft'}});const search=screen.getByRole('searchbox');search.focus();
  fireEvent.change(search,{target:{value:'T'}});expect(document.activeElement).toBe(search);
  fireEvent.change(search,{target:{value:'Te'}});expect(document.activeElement).toBe(search);
  expect(screen.getAllByRole('textbox',{name:'Edit name for Person 1'})).toHaveLength(1);
  expect((screen.getByRole('textbox',{name:'Edit name for Person 1'}) as HTMLInputElement).value).toBe('Preserved exact draft');
  await act(async()=>read.resolve({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}));await screen.findByText('Showing 2 of 2');expect(document.activeElement).toBe(search);
  fireEvent.click(screen.getByRole('button',{name:'Resume edit'}));expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'Edit name for Person 1'}));expect(api.updateField).not.toHaveBeenCalled();expect(api.list).toHaveBeenCalledTimes(3);
});

it('places edit actions and unknown-result feedback outside the fixed virtual row with one input',async()=>{
  const write=deferred<MutationReceipt>();const api=apiFor({updateField:vi.fn(()=>write.promise)});mount(api);fireEvent.doubleClick(await screen.findByText('Person 1'));
  const input=screen.getByRole('textbox',{name:'Edit name for Person 1'});fireEvent.change(input,{target:{value:'Exact name'}});
  const save=screen.getByRole('button',{name:'Save edit'});expect(save.closest('[role="row"]')).toBeNull();fireEvent.click(save);
  expect((screen.getByRole('button',{name:'Cancel edit'}) as HTMLButtonElement).disabled).toBe(true);await act(async()=>write.reject(new Error('private write failure')));
  const error=await screen.findByRole('alert');expect(error.closest('[role="row"]')).toBeNull();expect(error.textContent).toContain('could not be confirmed');
  expect(screen.getAllByRole('textbox',{name:'Edit name for Person 1'})).toHaveLength(1);expect((screen.getByRole('textbox',{name:'Edit name for Person 1'}) as HTMLInputElement).value).toBe('Exact name');
  fireEvent.click(screen.getByRole('button',{name:'Cancel edit'}));expect(screen.queryByRole('textbox',{name:'Edit name for Person 1'})).toBeNull();expect(api.updateField).toHaveBeenCalledTimes(1);
});

it('does not steal palette focus when a passive edit input returns from recovery',async()=>{
  const read=deferred<LeadsListResponse>();const api=apiFor({list:vi.fn().mockResolvedValueOnce({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}).mockReturnValueOnce(read.promise)});mount(api,true);
  fireEvent.doubleClick(await screen.findByText('Person 1'));const search=screen.getByRole('searchbox');search.focus();fireEvent.change(search,{target:{value:'T'}});
  fireEvent.keyDown(search,{key:'k',metaKey:true,ctrlKey:true});const palette=within(await screen.findByRole('dialog')).getByRole('combobox');palette.focus();
  await act(async()=>read.resolve({rows:rows.slice(0,2),total:2,nextCursor:null,revision:1}));await screen.findByText('Showing 2 of 2');expect(document.activeElement).toBe(palette);expect(api.updateField).not.toHaveBeenCalled();
});


it('keeps deliberate Search focus across virtual removal and return of the same draft',async()=>{
  const api=apiFor({list:vi.fn(async()=>({rows,total:208,nextCursor:null,revision:1}))});const view=mount(api);fireEvent.doubleClick(await screen.findByText('Person 1'));
  const input=screen.getByRole('textbox',{name:'Edit name for Person 1'});fireEvent.change(input,{target:{value:'Virtual draft'}});const search=screen.getByRole('searchbox');search.focus();
  const scroll=view.container.querySelector('.leads-grid__scroll') as HTMLElement;fireEvent.scroll(scroll,{target:{scrollTop:9000}});
  await waitFor(()=>expect(screen.getByRole('textbox',{name:'Edit name for Person 1'}).closest('[aria-label="Unfinished edit"]')).not.toBeNull());expect(document.activeElement).toBe(search);
  fireEvent.scroll(scroll,{target:{scrollTop:0}});await waitFor(()=>expect(screen.getByRole('textbox',{name:'Edit name for Person 1'}).closest('[role="row"]')).not.toBeNull());expect(document.activeElement).toBe(search);
  expect(screen.getAllByRole('textbox',{name:'Edit name for Person 1'})).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'Resume edit'}));expect(document.activeElement).toBe(screen.getByRole('textbox',{name:'Edit name for Person 1'}));expect(api.updateField).not.toHaveBeenCalled();
});

// Focus-owner hook seam: simulate a newer layer refusing the first mount,
// then verify remount cannot defer that consumed intent into a later focus steal.
it('consumes blocked initial focus once and rejects old session/API focus callbacks',()=>{
  let editor!:InlineEditor;const api=apiFor();const nextApi=apiFor();
  function Owner({api}:{api:LeadsApi}){editor=useLeadMutations(api,new Set(),()=>{},async()=>true).editor;return <input aria-label="Focus fixture"/>;}
  const view=render(<Owner api={api}/>);const input=screen.getByRole('textbox',{name:'Focus fixture'}) as HTMLInputElement;const focus=vi.spyOn(input,'focus');
  const start=()=>editor.start({personId:'person-1',field:'person_name',personLabel:'Person 1',draft:'Draft'});
  act(start);const old=editor;act(()=>editor.bindInput(input,false));act(()=>{editor.bindInput(null,true);editor.bindInput(input,true);});expect(focus).not.toHaveBeenCalled();
  act(()=>editor.focusInput());expect(focus).toHaveBeenCalledTimes(1);
  act(()=>editor.cancel());act(start);act(()=>old.bindInput(input,true));act(()=>old.focusInput());expect(focus).toHaveBeenCalledTimes(1);
  act(()=>editor.bindInput(input,true));expect(focus).toHaveBeenCalledTimes(2);const beforeApi=editor;view.rerender(<Owner api={nextApi}/>);act(()=>{beforeApi.bindInput(input,true);beforeApi.focusInput();});expect(focus).toHaveBeenCalledTimes(2);expect(api.updateField).not.toHaveBeenCalled();focus.mockRestore();
});


it.each(['focus','enter','escape'] as const)('preserves explicit editor %s with a real docked nonmodal inspector',async behavior=>{
  const write=deferred<MutationReceipt>();const api=apiFor({updateField:vi.fn(()=>write.promise)});const closed=vi.fn();
  function Composition(){const [open,setOpen]=useState(true);return <PresentationRoot><LeadsRoute api={api} onOpenLead={vi.fn()} onOpenImport={vi.fn()}/>{open&&<LeadInspector state={{status:'loading'}} onClose={()=>{closed();setOpen(false);}} onRetry={vi.fn()} onOpenFullPage={vi.fn()} onBeginOutbound={vi.fn()} onConfirmTransition={vi.fn()} onDismissLead={vi.fn()} onOverrideCloudScore={vi.fn()}/>}</PresentationRoot>;}
  render(<Composition/>);await screen.findByRole('complementary',{name:'Lead details'});fireEvent.doubleClick(await screen.findByText('Person 1'));const input=screen.getByRole('textbox',{name:'Edit name for Person 1'});fireEvent.change(input,{target:{value:'Exact nonmodal draft'}});
  if(behavior==='focus'){
    expect(document.activeElement).toBe(input);screen.getByRole('searchbox').focus();fireEvent.click(screen.getByRole('button',{name:'Resume edit'}));expect(document.activeElement).toBe(input);expect(api.updateField).not.toHaveBeenCalled();expect(closed).not.toHaveBeenCalled();
  } else if(behavior==='enter'){
    input.focus();fireEvent.keyDown(input,{key:'Enter'});expect(api.updateField).toHaveBeenCalledTimes(1);expect(api.updateField).toHaveBeenCalledWith({personId:'person-1',field:'person_name',value:'Exact nonmodal draft'});fireEvent.keyDown(input,{key:'Enter'});expect(api.updateField).toHaveBeenCalledTimes(1);await act(async()=>write.reject(new Error('unknown result')));expect((screen.getByRole('textbox',{name:'Edit name for Person 1'}) as HTMLInputElement).value).toBe('Exact nonmodal draft');expect(closed).not.toHaveBeenCalled();
  } else {
    input.focus();fireEvent.keyDown(input,{key:'Escape'});expect(closed).toHaveBeenCalledTimes(1);expect(screen.queryByRole('complementary',{name:'Lead details'})).toBeNull();expect((screen.getByRole('textbox',{name:'Edit name for Person 1'}) as HTMLInputElement).value).toBe('Exact nonmodal draft');fireEvent.keyDown(input,{key:'Escape'});expect(screen.queryByRole('textbox',{name:'Edit name for Person 1'})).toBeNull();expect(api.updateField).not.toHaveBeenCalled();
  }
});
