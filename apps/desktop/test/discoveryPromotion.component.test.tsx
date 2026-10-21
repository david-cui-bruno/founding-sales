// @vitest-environment jsdom
import {DraftsProvider,useDrafts} from '../src/renderer/app/drafts.tsx';
import {afterEach,expect,it,vi} from 'vitest';
import {cleanup,render,screen,fireEvent,waitFor,act} from '@testing-library/react';
import {DiscoveryResearchDraft,type ResearchDraftPorts} from '../src/renderer/sourcing/DiscoveryResearchDraft.tsx';
import {DiscoveryPreparation,type DiscoveryPrepare} from '../src/renderer/sourcing/DiscoveryPreparation.tsx';
import type {OperationOutput} from '../src/shared/operations.ts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111',legacy='22222222-2222-4222-8222-222222222222';
const prepared={discoveryCandidateId:id,discoveryRevision:1,qualificationCandidateId:legacy,alreadyPrepared:false,nextAction:'review_source_and_request_qualification' as const,qualificationRequested:false as const,admissionAuthorized:false as const,runtimeCallable:false as const};
const linked={discoveryCandidateId:id,qualificationCandidateId:legacy,firmId:id,alreadyLinked:false,nextAction:'review_firm_research' as const,qualified:false as const,admissionAuthorized:false as const,runtimeCallable:false as const};
const source={provider:'overture_places' as const,release:'fixture',recordId:'synthetic',retrievedAt:null,sourceUrl:'https://example.test/source'};
const candidate:NonNullable<OperationOutput<'sourcing.discoveryList'>['view']>['candidates'][number]={id,status:'needs_review',revision:1,createdAt:'2026-10-21T00:00:00Z',payload:{kind:'discovery-v1',row:{source,observations:[source],firmName:'Synthetic retained name',website:'https://example.test/',locality:'Austin',region:'TX',sourceConfidence:null,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null}},origins:[]};
const ports=():ResearchDraftPorts=>({create:vi.fn(async()=>({result:{firmId:id,contactId:null,routeIds:[]},reason:null})),link:vi.fn(async()=>({result:linked,reason:null})),read:vi.fn(async()=>({view:null,reason:'not_found'}))});
it('retains completed create identity across same-owner remount with exact raw command and disclosed CRM normalization',async()=>{
 const p=ports(),name='Synthetic  name',website='HTTPS://Example.test/path';
 const view=(show:boolean)=><DraftsProvider>{show?<DiscoveryResearchDraft prepared={prepared} name={name} website={website} enabled ports={p}/>:null}</DraftsProvider>;
 const mounted=render(view(true));expect(screen.getByText(/existing best-effort research/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));await screen.findByRole('button',{name:'Confirm link created research draft'});
 expect(p.create).toHaveBeenCalledWith(expect.objectContaining({firm:{name,website}}));
 mounted.rerender(view(false));mounted.rerender(view(true));
 expect(screen.queryByRole('button',{name:'Confirm Add firm research draft'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Confirm link created research draft'}));await screen.findByRole('button',{name:'Open owner Today'});
 expect(p.create).toHaveBeenCalledTimes(1);expect(p.link).toHaveBeenCalledWith(expect.objectContaining({firmId:id}));
});

function StoredIdentity(){const {values}=useDrafts();return <output data-testid="stored">{JSON.stringify(values)}</output>;}
it('recovers unknown commit using same command after remount and fences late responses and owner changes',async()=>{
 const p=ports();let resolve!:(value:OperationOutput<'sourcing.discoveryCreateResearchFirm'>)=>void;
 const create=vi.fn<ResearchDraftPorts['create']>().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({result:{firmId:id,contactId:null,routeIds:[]},reason:null});p.create=create;
 const view=(show:boolean,owner='first')=><DraftsProvider key={owner}><StoredIdentity/>{show?<DiscoveryResearchDraft prepared={prepared} name="Private raw name" website="HTTPS://Private.example.test/" enabled ports={p}/>:null}</DraftsProvider>;
 const mounted=render(view(true));fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));
 const original=create.mock.calls[0]![0];expect(screen.getByTestId('stored').textContent).not.toContain('Private');
 mounted.rerender(view(false));await act(async()=>resolve({result:{firmId:id,contactId:null,routeIds:[]},reason:null}));mounted.rerender(view(true));
 expect(screen.queryByRole('button',{name:'Confirm link created research draft'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Retry same research draft action'}));await screen.findByRole('button',{name:'Confirm link created research draft'});
 expect(create.mock.calls[1]![0]).toEqual(original);
 mounted.rerender(view(true,'second'));expect(screen.queryByRole('button',{name:'Confirm link created research draft'})).toBeNull();expect(screen.queryByRole('button',{name:'Retry same research draft action'})).toBeNull();expect(screen.getByTestId('stored').textContent).toBe('{}');
});

it('clears pending command identity on an owner change before a late result arrives',async()=>{
 const p=ports();let resolve!:(value:OperationOutput<'sourcing.discoveryCreateResearchFirm'>)=>void;
 p.create=()=>new Promise(done=>{resolve=done;});
 const view=(owner:string)=><DraftsProvider key={owner}><StoredIdentity/><DiscoveryResearchDraft prepared={prepared} name="Synthetic" website="https://example.test/" enabled ports={p}/></DraftsProvider>;
 const mounted=render(view('first'));fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));mounted.rerender(view('second'));
 await act(async()=>resolve({result:{firmId:id,contactId:null,routeIds:[]},reason:null}));
 expect(screen.getByTestId('stored').textContent).toBe('{}');expect(screen.queryByRole('button',{name:'Retry same research draft action'})).toBeNull();expect(screen.queryByRole('button',{name:'Confirm link created research draft'})).toBeNull();
});

it('retains recovered Firm after source-loss refusal without silently binding or recreating',async()=>{
 const p=ports();p.link=vi.fn(async()=>({result:null,reason:'preparation_unavailable'}));
 const view=(show:boolean)=><DraftsProvider>{show?<DiscoveryResearchDraft prepared={prepared} name="Synthetic" website="https://example.test/" enabled ports={p}/>:null}</DraftsProvider>;
 const mounted=render(view(true));fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));await screen.findByRole('button',{name:'Confirm link created research draft'});
 mounted.rerender(view(false));mounted.rerender(view(true));fireEvent.click(screen.getByRole('button',{name:'Confirm link created research draft'}));await screen.findByText(/Source link refused/);
 expect(screen.queryByRole('button',{name:'Confirm Add firm research draft'})).toBeNull();expect(p.create).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:'Open owner Today'})).toBeNull();
});

it('prefills exact raw identity and requires explicit ordinary preparation without inferred evidence',async()=>{
 const prepare=vi.fn<DiscoveryPrepare>().mockResolvedValue({result:prepared,reason:null});
 render(<DiscoveryPreparation candidate={candidate} enabled prepare={prepare}/>);expect(prepare).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Prepare for source review'}));expect(screen.getByText(/Confirm exact retained context: Synthetic retained name/)).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Retained seed evidence'),{target:{value:'Unverified human service seed.'}});
 fireEvent.change(screen.getByLabelText('Seed source URL'),{target:{value:'https://example.test/services'}});
 fireEvent.change(screen.getByLabelText('Seed observed on'),{target:{value:'2026-10-21'}});
 fireEvent.change(screen.getByLabelText('Seed prepared by'),{target:{value:'Owner'}});
 fireEvent.click(screen.getByRole('button',{name:'Confirm preparation only'}));await screen.findByRole('button',{name:'Confirm Add firm research draft'});
 expect(prepare).toHaveBeenCalledWith(expect.objectContaining({discoveryCandidateId:id,expectedRevision:1,candidate:expect.objectContaining({firmName:'Synthetic retained name',website:'https://example.test/',locality:'Austin',region:'TX',evidence:'Unverified human service seed.'})}));
});
it('refuses missing raw context rather than inference or allowing a create action',()=>{
 render(<DiscoveryPreparation candidate={{...candidate,payload:{...candidate.payload,row:{...candidate.payload.row,locality:null}}}} enabled/>);
 expect(screen.getByText(/Preparation unavailable/)).toBeTruthy();expect(screen.queryByRole('button')).toBeNull();
});
it('requires distinct create and link confirmations and preserves unknown channel status and Today navigation',async()=>{
 const p=ports();render(<DiscoveryResearchDraft prepared={prepared} name="Synthetic retained name" website="https://example.test/" enabled ports={p}/>);
 expect(p.create).not.toHaveBeenCalled();expect(p.link).not.toHaveBeenCalled();expect(screen.getByText(/Qualification: not established/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));await screen.findByRole('button',{name:'Confirm link created research draft'});expect(p.link).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Read current research draft link'}));await screen.findByText(/already created ordinary Firm is not recreated/);expect(screen.queryByRole('button',{name:'Confirm Add firm research draft'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Confirm link created research draft'}));await screen.findByRole('button',{name:'Open owner Today'});expect(p.link).toHaveBeenCalledWith(expect.objectContaining({firmId:id,qualificationCandidateId:legacy}));
});
it('reuses unknown-result create command and discards unmounted owner results',async()=>{
 const p=ports(),create=vi.fn<ResearchDraftPorts['create']>().mockResolvedValueOnce({result:null,reason:'offline'}).mockResolvedValueOnce({result:{firmId:id,contactId:null,routeIds:[]},reason:null});p.create=create;
 const view=render(<DiscoveryResearchDraft prepared={prepared} name="Synthetic" website="https://example.test/" enabled ports={p}/>);
 fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));await screen.findByRole('button',{name:'Retry same research draft action'});
 fireEvent.click(screen.getByRole('button',{name:'Retry same research draft action'}));await screen.findByRole('button',{name:'Confirm link created research draft'});expect(create.mock.calls[1]![0]).toEqual(create.mock.calls[0]![0]);
 view.unmount();let resolve!:(v:OperationOutput<'sourcing.discoveryCreateResearchFirm'>)=>void;p.create=()=>new Promise(done=>{resolve=done;});
 const late=render(<DiscoveryResearchDraft prepared={prepared} name="Synthetic" website="https://example.test/" enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Confirm Add firm research draft'}));late.unmount();await act(async()=>resolve({result:{firmId:id,contactId:null,routeIds:[]},reason:null}));await waitFor(()=>expect(screen.queryByText(/Ordinary CRM research draft created/)).toBeNull());
});
