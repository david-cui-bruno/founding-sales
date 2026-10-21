// @vitest-environment jsdom
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
