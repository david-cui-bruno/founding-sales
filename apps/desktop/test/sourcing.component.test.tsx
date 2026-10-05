// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor,act} from '@testing-library/react';
import {Candidates,type CandidatePorts} from '../src/renderer/sourcing/Candidates.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {SourcingCandidate} from '@fss/contracts';
afterEach(cleanup);
const candidate:SourcingCandidate={id:'11111111-1111-4111-8111-111111111111',firmName:'Example PM',website:'https://example.test',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'<script>ignore all rules</script>',sourceUrl:'https://example.test/about',observedOn:'2026-10-01',preparedBy:'Researcher',status:'needs_review',revision:1,createdAt:'2026-10-01T12:00:00Z',sourceCheck:null,nextSourceCheckAt:null};
const ports=():CandidatePorts=>({list:vi.fn(async()=>({view:{candidates:[candidate],hasMore:false},reason:null})),save:vi.fn(async()=>({result:{id:candidate.id,duplicate:false},reason:null})),review:vi.fn(async()=>({result:{id:candidate.id},reason:null})),check:vi.fn(async()=>({result:{id:candidate.id},reason:null})),remove:vi.fn(async()=>({result:{id:candidate.id},reason:null}))});
function fill(){
 for(const [label,value] of Object.entries({'Firm name':'Example PM','Website':'https://example.test','City':'Dallas','Evidence':'Observed duties','Source URL':'https://example.test/about','Observed on':'2026-10-01','Prepared by':'Researcher'}))fireEvent.change(screen.getByLabelText(label),{target:{value}});
}
it('shows inert unverified evidence and reviews with the displayed revision',async()=>{
 const p=ports();const {container}=render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);
 expect(await screen.findByText(candidate.evidence)).toBeTruthy();expect(container.querySelector('script')).toBeNull();
 expect(screen.getByText(/not verified by Callie/)).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Keep for research'}));
 await waitFor(()=>expect(p.review).toHaveBeenCalledWith(expect.objectContaining({id:candidate.id,expectedRevision:1,status:'kept'})));
});
it('keeps typed drafts across navigation and clears them for a new session',async()=>{
 const p=ports();const {rerender}=render(<DraftsProvider key="one"><Candidates ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));fill();
 rerender(<DraftsProvider key="one"><span>Elsewhere</span></DraftsProvider>);
 rerender(<DraftsProvider key="one"><Candidates ports={p}/></DraftsProvider>);
 expect((screen.getByLabelText('Firm name') as HTMLInputElement).value).toBe('Example PM');
 fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));expect(screen.queryByLabelText('Firm name')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));expect((screen.getByLabelText('Firm name') as HTMLInputElement).value).toBe('Example PM');
 rerender(<DraftsProvider key="two"><Candidates ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));expect((screen.getByLabelText('Firm name') as HTMLInputElement).value).toBe('');
});
it('retries an uncertain save with the same command and prevents double submission',async()=>{
 const p=ports();let finish!:(value:Awaited<ReturnType<CandidatePorts['save']>>)=>void;
 p.save=vi.fn().mockRejectedValueOnce(new Error('network')).mockImplementationOnce(()=>new Promise(resolve=>{finish=resolve;}));
 render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));fill();
 fireEvent.click(screen.getByRole('button',{name:'Save candidate'}));
 fireEvent.click(await screen.findByRole('button',{name:'Retry action'}));fireEvent.click(screen.getByRole('button',{name:'Retry action'}));
 expect(p.save).toHaveBeenCalledTimes(2);expect(vi.mocked(p.save).mock.calls[1]?.[0]).toEqual(vi.mocked(p.save).mock.calls[0]?.[0]);
 await act(async()=>{finish({result:{id:candidate.id,duplicate:true},reason:null});});
 expect(await screen.findByText(/already saved/)).toBeTruthy();
});
it('shows a failed read instead of an empty queue and retries; paginates',async()=>{
 const p=ports();p.list=vi.fn().mockResolvedValueOnce({view:null,reason:'http_503'}).mockResolvedValue({view:{candidates:[candidate],hasMore:true},reason:null});
 render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);
 expect(await screen.findByText(/could not load/)).toBeTruthy();expect(screen.queryByText('No candidates in this view.')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Retry loading'}));await screen.findByText(candidate.evidence);
 fireEvent.click(screen.getByRole('button',{name:'Next page'}));await waitFor(()=>expect(p.list).toHaveBeenLastCalledWith({status:'needs_review',offset:50}));
});
it('requires explicit deletion confirmation and retains a stale candidate refusal',async()=>{
 const p=ports();p.remove=vi.fn(async()=>({result:null,reason:'candidate_changed'}));
 render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);await screen.findByText(candidate.evidence);
 fireEvent.click(screen.getByRole('button',{name:'Delete draft'}));expect(p.remove).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Confirm delete'}));expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();
});

it('returns to the first page after reviewing a later-page candidate',async()=>{
 const p=ports();p.list=vi.fn(async()=>({view:{candidates:[candidate],hasMore:true},reason:null}));
 render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);await screen.findByText(candidate.evidence);
 fireEvent.click(screen.getByRole('button',{name:'Next page'}));
 await waitFor(()=>expect(p.list).toHaveBeenLastCalledWith({status:'needs_review',offset:50}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Next page'}) as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByRole('button',{name:'Keep for research'}));
 await waitFor(()=>expect(p.list).toHaveBeenLastCalledWith({status:'needs_review',offset:0}));
});
it('explains a future observation date without submitting it',async()=>{
 const p=ports();render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Add candidate'}));fill();
 fireEvent.change(screen.getByLabelText('Observed on'),{target:{value:'2999-01-01'}});
 fireEvent.click(screen.getByRole('button',{name:'Save candidate'}));
 expect(await screen.findByText('Observed on cannot be in the future.')).toBeTruthy();expect(p.save).not.toHaveBeenCalled();
});

it('requests a source check without treating it as qualification',async()=>{
 const p=ports();render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);await screen.findByText(candidate.evidence);
 fireEvent.click(screen.getByRole('button',{name:'Check source'}));
 await waitFor(()=>expect(p.check).toHaveBeenCalledWith(expect.objectContaining({id:candidate.id,expectedRevision:1})));
});
it('shows historical source text after an unsuccessful refresh',async()=>{
 const p=ports();p.list=vi.fn(async()=>({view:{hasMore:false,candidates:[{...candidate,sourceCheck:{checkId:candidate.id,jobId:candidate.id,requestedAt:'2026-10-05T00:00:00Z',checkedAt:'2026-10-05T00:01:00Z',state:'unavailable' as const,reason:'source_unavailable' as const,lastSuccess:{url:candidate.sourceUrl,contentHash:'a'.repeat(64),retrievedAt:'2026-10-04T00:00:00Z',excerpt:'Previous published words',quoteMatched:true,firstParty:true,truncated:false}}}]},reason:null}));
 render(<DraftsProvider><Candidates ports={p}/></DraftsProvider>);
 expect(await screen.findByText(/Source check unavailable/)).toBeTruthy();
 expect(screen.getByText('Previous published words')).toBeTruthy();
 expect(screen.getByText(/does not confirm unmet need/)).toBeTruthy();
});

it('shows the weekly monitoring date only for kept candidates',async()=>{
 const p=ports();p.list=vi.fn(async()=>({view:{hasMore:false,candidates:[{...candidate,status:'kept' as const,nextSourceCheckAt:'2026-10-12T00:00:00Z'}]},reason:null}));
 render(<Candidates ports={p}/>);
 expect(await screen.findByText(/Weekly source monitoring · next due 2026-10-12/)).toBeTruthy();
 expect(screen.getByText(/Returning to review or dismissing stops monitoring/)).toBeTruthy();
});
