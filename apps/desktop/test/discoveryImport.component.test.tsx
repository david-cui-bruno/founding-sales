// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DiscoveryImport} from '../src/renderer/sourcing/DiscoveryImport.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {createGeneration} from '../src/renderer/app/generation.ts';
import {FirmsRoute} from '../src/renderer/firms/FirmsRoute.tsx';
import {resetCrmMemory} from '../src/renderer/firms/crmMemory.ts';
import type {OperationApi} from '../src/shared/operations.ts';
import type {DiscoverySavePort} from '../src/renderer/sourcing/discoveryImportController.ts';
import type {DiscoveryListPort} from '../src/renderer/sourcing/discoveryImportReconcile.ts';
import {crmState,pipelineView} from './e2e/support/crmFixtures.ts';
import {rawDiscoveryEntry,discoveryReceipt,emptyDiscoveryList} from './support/discoveryImportFixtures.ts';
beforeEach(()=>vi.stubGlobal('crypto',webcrypto));
afterEach(()=>{cleanup();vi.unstubAllGlobals();globalThis.callieApi=undefined;resetCrmMemory();});
const authority={isAdmin:true,current:()=>true};
const accepted={result:discoveryReceipt,reason:null};
const list=vi.fn<DiscoveryListPort>().mockResolvedValue(emptyDiscoveryList);
function fileOf(text=JSON.stringify([rawDiscoveryEntry()])){
  const file=new File([text],'synthetic.json',{type:'application/json'});Object.defineProperty(file,'arrayBuffer',{value:async()=>new TextEncoder().encode(text).buffer,configurable:true});return file;
}
function select(file=fileOf()){fireEvent.change(screen.getByLabelText(/Select raw discovery JSON/),{target:{files:[file]}});}
async function confirm(){await screen.findByText(/raw rows ·/);fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Confirm and save raw observations'}));}
it('requires admin, explicit file choice and confirmation, renders unknowns and notices as inert references',async()=>{
  const save=vi.fn<DiscoverySavePort>().mockResolvedValue(accepted);
  const {container,rerender}=render(<DiscoveryImport authority={{...authority,isAdmin:false}} enabled privacyKey="owner" save={save} list={list}/>);
  expect(screen.queryByLabelText(/Select raw discovery/)).toBeNull();expect(save).not.toHaveBeenCalled();
  rerender(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);
  select();await screen.findByText(/1 raw rows · 1 exact source observations · 1 unknown websites · 1 notice references/);
  expect(screen.getByText(/<script>Inert notice<\/script>/)).toBeTruthy();expect(container.querySelector('a,script,img,iframe')).toBeNull();
  expect((screen.getByRole('button',{name:'Confirm and save raw observations'}) as HTMLButtonElement).disabled).toBe(true);expect(save).not.toHaveBeenCalled();
  await confirm();await screen.findByText(/1\/1 unique commands acknowledged/);await screen.findByText(/0 exact rows present, 1 missing/);
  expect(save).toHaveBeenCalledTimes(1);expect(screen.getByText(/not CRM net-new counts/)).toBeTruthy();
});
it('validates the final entry before sending anything and rejects oversized files before reading',async()=>{
  const save=vi.fn<DiscoverySavePort>();render(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);
  select(fileOf(JSON.stringify([rawDiscoveryEntry(),{row:rawDiscoveryEntry('last').row,origins:[]}])));await screen.findByText(/Invalid raw discovery JSON/);expect(save).not.toHaveBeenCalled();
  const huge=fileOf();Object.defineProperty(huge,'size',{value:10_000_001});const text=vi.fn();Object.defineProperty(huge,'arrayBuffer',{value:text,configurable:true});
  select(huge);await screen.findByText(/File exceeds the 10 MB limit/);expect(text).not.toHaveBeenCalled();
});
it('ambiguous response pauses until explicit same-ID resume, changed file is refused after an attempt',async()=>{
  const save=vi.fn<DiscoverySavePort>().mockResolvedValueOnce({result:null,reason:'offline'}).mockResolvedValue(accepted);
  render(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);select();await confirm();
  await screen.findByText(/Stopped: ambiguous_response/);expect(save).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button',{name:'Explicitly resume same payload and IDs'}));await screen.findByText(/1\/1 unique commands acknowledged/);
  expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[0]?.[0]).toBe(save.mock.calls[1]?.[0]);
  select(fileOf(JSON.stringify([rawDiscoveryEntry('changed')])));await screen.findByText(/This session already attempted a different batch/);expect(save).toHaveBeenCalledTimes(2);
});
it('rejects invalid UTF-8 before any command instead of silently replacing source bytes',async()=>{
  const save=vi.fn<DiscoverySavePort>(),file=fileOf();Object.defineProperty(file,'arrayBuffer',{value:async()=>new Uint8Array([0xff,0xfe]).buffer});
  render(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);select(file);
  await screen.findByText(/Invalid raw discovery JSON/);expect(save).not.toHaveBeenCalled();
});
it('refusal blocks resume even after read-only reconciliation',async()=>{
  const save=vi.fn<DiscoverySavePort>().mockResolvedValue({result:null,reason:'source_conflict'});
  render(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);select();await confirm();await screen.findByText(/Stopped: source_conflict/);
  expect((screen.getByRole('button',{name:'Explicitly resume same payload and IDs'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button',{name:'Reconcile current queue (read only)'}));await screen.findByText(/0 exact rows present, 1 missing/);
  expect((screen.getByRole('button',{name:'Explicitly resume same payload and IDs'}) as HTMLButtonElement).disabled).toBe(true);expect(save).toHaveBeenCalledTimes(1);
});
it('cancel stops remaining writes, keeps no selected body, reselecting unchanged file retains IDs',async()=>{
  let resolve!:(value:typeof accepted)=>void;const save=vi.fn<DiscoverySavePort>().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue(accepted);
  const text=JSON.stringify([rawDiscoveryEntry(),rawDiscoveryEntry('second')]);
  render(<DiscoveryImport authority={authority} enabled privacyKey="owner" save={save} list={list}/>);select(fileOf(text));await confirm();await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button',{name:'Cancel raw import'}));expect(screen.queryByText(/raw rows ·/)).toBeNull();expect(screen.getByText(/in-flight save may have completed/)).toBeTruthy();
  await act(async()=>resolve(accepted));expect(save).toHaveBeenCalledTimes(1);
  select(fileOf(text));await confirm();await screen.findByText(/2\/2 unique commands acknowledged/);expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
});
it.each(['owner','disabled','unmount'] as const)('drops pending save and all remaining writes on %s transition',async kind=>{
  let resolve!:(value:typeof accepted)=>void;const save=vi.fn<DiscoverySavePort>(()=>new Promise(done=>{resolve=done;}));
  const guard=createGeneration(),live={isAdmin:true,current:()=>guard.guard.fresh(0)};
  const view=render(<DiscoveryImport authority={live} enabled privacyKey="old-owner" save={save} list={list}/>);
  select(fileOf(JSON.stringify([rawDiscoveryEntry(),rawDiscoveryEntry('second')])));await confirm();await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));
  if(kind==='owner'){guard.note(1);view.rerender(<DiscoveryImport authority={{isAdmin:true,current:()=>guard.guard.fresh(1)}} enabled privacyKey="new-owner" save={save} list={list}/>);}
  else if(kind==='disabled')view.rerender(<DiscoveryImport authority={live} enabled={false} privacyKey="old-owner" save={save} list={list}/>);else view.unmount();
  await act(async()=>resolve(accepted));expect(save).toHaveBeenCalledTimes(1);expect(screen.queryByText(/raw rows ·/)).toBeNull();expect(screen.queryByText(/unique commands acknowledged/)).toBeNull();
});
it('drops a selected file read after a synchronous owner-generation switch before React rerenders',async()=>{
  const guard=createGeneration(),save=vi.fn<DiscoverySavePort>();let resolve!:(text:string)=>void;
  const file=fileOf();Object.defineProperty(file,'arrayBuffer',{value:()=>new Promise<ArrayBuffer>(done=>{resolve=text=>done(new TextEncoder().encode(text).buffer);}),configurable:true});
  render(<DiscoveryImport authority={{isAdmin:true,current:()=>guard.guard.fresh(0)}} enabled privacyKey="owner" save={save} list={list}/>);select(file);
  guard.note(1);await act(async()=>resolve(JSON.stringify([rawDiscoveryEntry()])));expect(save).not.toHaveBeenCalled();expect(screen.queryByText(/raw rows ·/)).toBeNull();
});
it.each(['admin','salesperson'] as const)('normal %s route keeps empty admin queue reachable and denies nonadmin file selection',async role=>{
  const read=vi.fn(async(name:string)=>name==='crm.state'?crmState({screen:'pipeline',firm:null,pipeline:pipelineView(),role}):emptyDiscoveryList);
  const command=vi.fn(async()=>accepted);globalThis.callieApi={read,command} as unknown as OperationApi;const {guard}=createGeneration();
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><DraftsProvider><FirmsRoute route={{name:'firms'}} identity={`owner-${role}`} generation={0} guard={guard}/></DraftsProvider></QueryClientProvider>);
  await screen.findByTestId('firms-list');await act(async()=>{});
  if(role==='admin'){
    fireEvent.click(await screen.findByRole('button',{name:'Candidates'}));select();await confirm();await screen.findByText(/1\/1 unique commands acknowledged/);
    expect(command).toHaveBeenCalledWith('sourcing.discoverySave',expect.objectContaining({commandId:expect.stringMatching(/^discovery126:/u)}));
  }else{expect(screen.queryByRole('button',{name:'Candidates'})).toBeNull();expect(screen.queryByLabelText(/Select raw discovery JSON/)).toBeNull();expect(command).not.toHaveBeenCalled();}
});
