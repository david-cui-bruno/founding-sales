// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,renderHook,screen,fireEvent,cleanup,waitFor,act} from '@testing-library/react';
import {DiscoveryCandidates,type DiscoveryList} from '../src/renderer/sourcing/DiscoveryCandidates.tsx';
import {Candidates,useCandidateReviewVisibility,type CandidatePorts} from '../src/renderer/sourcing/Candidates.tsx';
import type {OperationOutput} from '../src/shared/operations.ts';
import type {OperationApi} from '../src/shared/operations.ts';
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {createGeneration} from '../src/renderer/app/generation.ts';
import {FirmsRoute} from '../src/renderer/firms/FirmsRoute.tsx';
import {resetCrmMemory} from '../src/renderer/firms/crmMemory.ts';
import {crmState,pipelineView} from './e2e/support/crmFixtures.ts';
import type {SourcingCandidate} from '@fss/contracts';
afterEach(cleanup);
const source={provider:'overture_places' as const,recordId:'record-example',release:'2026-10-01',retrievedAt:null,sourceUrl:'https://example.test/source'};
const candidate:NonNullable<OperationOutput<'sourcing.discoveryList'>['view']>['candidates'][number]={id:'11111111-1111-4111-8111-111111111111',status:'needs_review',revision:1,createdAt:'2026-10-01T12:00:00Z',payload:{kind:'discovery-v1',row:{source,observations:[source],firmName:'<script>untrusted firm</script>',website:'http://example.test/raw',locality:null,region:null,sourceConfidence:0.99,residentialFit:'unknown',websiteAssociation:'unknown',officePhoneEvidence:'unknown',probableGroupKey:null}},origins:[{source,sourceMetadata:{sourcesJson:'[{"resource":"PRIVATE RAW BODY"}]'},licenses:['Example'],notices:[{label:'Notice',url:'https://example.test/notice',sha256:'a'.repeat(64)}]}]};
const populated={view:{candidates:[candidate],hasMore:true},reason:null};
const empty={view:{candidates:[],hasMore:false},reason:null};
it('renders only inert source summaries, unknowns and confidence explicitly not fit, with no raw actions',async()=>{
 const list=vi.fn<DiscoveryList>().mockResolvedValue(populated);
 const {container}=render(<DiscoveryCandidates list={list}/>);
 expect(await screen.findByText(candidate.payload.row.firmName)).toBeTruthy();
 expect(screen.getByText('Website (unverified text): http://example.test/raw')).toBeTruthy();
 expect(screen.getByText(/Unknown city, Unknown state/)).toBeTruthy();
 expect(screen.getByText(/Source confidence \(not fit\): 0.99/)).toBeTruthy();
 expect(screen.getByText(/Provider: overture_places · Release: 2026-10-01/)).toBeTruthy();
 expect(screen.getByText(/Observed: Unknown · Observations: 1/)).toBeTruthy();
 expect(screen.getByText(/Residential fit: unknown.*Office phone evidence: unknown/)).toBeTruthy();
 expect(container.querySelector('a,script,img,iframe')).toBeNull();
 expect(screen.queryByText(/PRIVATE RAW BODY/)).toBeNull();
 for(const name of ['Keep for research','Check source','Dismiss','Delete draft','Import','Send'])expect(screen.queryByRole('button',{name})).toBeNull();
 expect(list).toHaveBeenCalledTimes(1);
});
it('paginates by 50, returns to first page on status change and respects hasMore',async()=>{
 const list=vi.fn<DiscoveryList>().mockResolvedValueOnce(populated).mockResolvedValueOnce({...populated,view:{...populated.view,hasMore:false}}).mockResolvedValue(empty);
 render(<DiscoveryCandidates list={list}/>);await screen.findByText(candidate.payload.row.firmName);
 fireEvent.click(screen.getByRole('button',{name:'Next raw page'}));
 await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'needs_review',offset:50}));
 await waitFor(()=>expect((screen.getByRole('button',{name:'Next raw page'}) as HTMLButtonElement).disabled).toBe(true));
 fireEvent.click(screen.getByRole('button',{name:'Previous raw page'}));
 await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'needs_review',offset:0}));
 await screen.findByText('No raw discovery observations in this status.');
 fireEvent.click(screen.getByRole('button',{name:'Raw: Dismissed'}));
 await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'dismissed',offset:0}));
});
it('keeps unknown confidence and missing website explicit',async()=>{
 const unknown={...candidate,payload:{...candidate.payload,row:{...candidate.payload.row,sourceConfidence:null,website:null}}};
 const list=vi.fn<DiscoveryList>().mockResolvedValue({view:{candidates:[unknown],hasMore:false},reason:null});
 render(<DiscoveryCandidates list={list}/>);
 await screen.findByText('Source confidence (not fit): Unknown');expect(screen.getByText('Website (unverified text): Unknown')).toBeTruthy();
});
it.each(['refused','thrown'] as const)('distinguishes %s reads from empty and permits manual retry',async kind=>{
 const list=vi.fn<DiscoveryList>();
 if(kind==='refused')list.mockResolvedValueOnce({view:null,reason:'forbidden'});else list.mockRejectedValueOnce(new Error('offline'));
 list.mockResolvedValue(empty);render(<DiscoveryCandidates list={list}/>);
 await screen.findByRole('alert');expect(screen.queryByText('No raw discovery observations in this status.')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Refresh raw discovery'}));await screen.findByText('No raw discovery observations in this status.');
});
it('does not read disabled views and discards old-owner pending reads immediately',async()=>{
 const finishes:Array<(value:OperationOutput<'sourcing.discoveryList'>)=>void>=[];
 const list=vi.fn<DiscoveryList>(()=>new Promise(resolve=>finishes.push(resolve)));
 const onObserved=vi.fn();
 const {rerender}=render(<DiscoveryCandidates list={list} privacyKey="one" enabled={false} onObserved={onObserved}/>);expect(list).not.toHaveBeenCalled();
 rerender(<DiscoveryCandidates list={list} privacyKey="one" onObserved={onObserved}/>);await screen.findByText('Loading raw discovery…');
 rerender(<DiscoveryCandidates list={list} privacyKey="two" onObserved={onObserved}/>);
 await act(async()=>finishes[0]!(populated));expect(screen.queryByText(candidate.payload.row.firmName)).toBeNull();expect(onObserved).not.toHaveBeenCalled();
 await act(async()=>finishes[1]!(empty));await screen.findByText('No raw discovery observations in this status.');
});
it('clears displayed rows synchronously when privacy identity changes',async()=>{
 const list=vi.fn<DiscoveryList>().mockResolvedValueOnce(populated).mockImplementation(()=>new Promise(()=>{}));
 const {rerender}=render(<DiscoveryCandidates list={list} privacyKey="one"/>);await screen.findByText(candidate.payload.row.firmName);
 rerender(<DiscoveryCandidates list={list} privacyKey="two"/>);expect(screen.queryByText(candidate.payload.row.firmName)).toBeNull();
});
it('keeps Candidates discoverable when legacy is empty but raw exists in any status; errors stay unknown',async()=>{
 const legacy=vi.fn<CandidatePorts['list']>().mockResolvedValue(empty);
 const raw=vi.fn<DiscoveryList>(async input=>input.status==='kept'?populated:empty);
 const {result}=renderHook(()=>useCandidateReviewVisibility(true,'one',0,legacy,raw));
 await waitFor(()=>expect(raw).toHaveBeenCalledTimes(3));expect(result.current.visible).toBe(true);
 act(()=>result.current.onReviewEmpty(true));expect(result.current.visible).toBe(true);
});
it('ignores previous-generation raw visibility answers and keeps unknown visible',async()=>{
 const legacy=vi.fn<CandidatePorts['list']>().mockResolvedValue(empty);
 const finishes:Array<(value:OperationOutput<'sourcing.discoveryList'>)=>void>=[];
 const raw=vi.fn<DiscoveryList>(()=>new Promise(resolve=>finishes.push(resolve)));
 const {result,rerender}=renderHook(({identity})=>useCandidateReviewVisibility(true,identity,0,legacy,raw),{initialProps:{identity:'one'}});
 rerender({identity:'two'});
 await act(async()=>{for(const finish of finishes.slice(0,3))finish(empty);});expect(result.current.visible).toBe(true);
 await act(async()=>{for(const finish of finishes.slice(3))finish({view:null,reason:'forbidden'});});expect(result.current.visible).toBe(true);
});
it('renders raw rows through the existing Candidates surface when the legacy queue is empty',async()=>{
 const ports:CandidatePorts={list:vi.fn().mockResolvedValue(empty),save:vi.fn(),review:vi.fn(),check:vi.fn(),remove:vi.fn()};
 const raw=vi.fn<DiscoveryList>().mockResolvedValue(populated);
 render(<Candidates ports={ports} rawList={raw}/>);
 await screen.findByText(candidate.payload.row.firmName);await screen.findByText('No candidates in this view.');
 expect(screen.getByRole('button',{name:'Add candidate'})).toBeTruthy();
 expect(ports.save).not.toHaveBeenCalled();expect(ports.check).not.toHaveBeenCalled();
});
it.each(['admin','salesperson'] as const)('exposes raw discovery only to the %s route role',async role=>{
 resetCrmMemory();
 const read=vi.fn(async(name:string)=>name==='crm.state'?crmState({screen:'pipeline',firm:null,pipeline:pipelineView(),role}):name==='sourcing.discoveryList'?populated:name==='sourcing.list'?empty:{view:null,reason:'unavailable'});
 const command=vi.fn();globalThis.callieApi={read,command} as unknown as OperationApi;
 const {guard}=createGeneration();
 try{
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><DraftsProvider><FirmsRoute route={{name:'firms'}} identity={`owner-${role}`} generation={0} guard={guard}/></DraftsProvider></QueryClientProvider>);
  await screen.findByTestId('firms-list');
  if(role==='admin'){
   fireEvent.click(await screen.findByRole('button',{name:'Candidates'}));
   await screen.findByText(candidate.payload.row.firmName);
   expect(screen.getByRole('region',{name:'Raw discovery'})).toBeTruthy();
  }else{
   expect(screen.queryByRole('button',{name:'Candidates'})).toBeNull();
   expect(read.mock.calls.some(([name])=>name==='sourcing.discoveryList')).toBe(false);
  }
  expect(command).not.toHaveBeenCalled();
 }finally{cleanup();globalThis.callieApi=undefined;resetCrmMemory();}
});
it.each([{delayed:false,unknown:false},{delayed:true,unknown:false},{delayed:true,unknown:true}])('retains newer child raw knowledge after legacy empties (delayed parent $delayed, unknown $unknown)',async({delayed,unknown})=>{
 resetCrmMemory();let dismissed=false,rawReads=0;
 const pending:Array<()=>void>=[];
 const legacy:SourcingCandidate={id:candidate.id,firmName:'Legacy review firm',website:'https://example.test',locality:'Dallas',region:'TX',signal:'fit_only',evidence:'Legacy source',sourceUrl:'https://example.test/about',observedOn:'2026-10-01',preparedBy:'Fixture',status:'needs_review',revision:1,createdAt:candidate.createdAt,sourceCheck:null,nextSourceCheckAt:null};
 const read=vi.fn(async(name:string)=>{
  if(name==='crm.state')return crmState({screen:'pipeline',firm:null,pipeline:pipelineView(),role:'admin'});
  if(name==='sourcing.list')return dismissed?empty:{view:{candidates:[legacy],hasMore:false},reason:null};
  if(name==='sourcing.discoveryList'){
   const index=rawReads++;
   if(index<3&&delayed)return new Promise<typeof empty>(resolve=>pending.push(()=>resolve(empty)));
   if(index<4)return empty;
   return unknown?{view:null,reason:'unavailable'}:populated;
  }
  return {view:null,reason:'unavailable'};
 });
 const command=vi.fn(async()=>{dismissed=true;return {result:{id:legacy.id},reason:null};});
 globalThis.callieApi={read,command} as unknown as OperationApi;const {guard}=createGeneration();
 try{
  render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><DraftsProvider><FirmsRoute route={{name:'firms'}} identity="same-owner" generation={0} guard={guard}/></DraftsProvider></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button',{name:'Candidates'}));
  await screen.findByText('No raw discovery observations in this status.');await screen.findByText('Legacy source');
  fireEvent.click(screen.getByRole('button',{name:'Refresh raw discovery'}));
  if(unknown)await screen.findByText(/Raw discovery could not load or was refused/);else await screen.findByText(candidate.payload.row.firmName);
  fireEvent.click(screen.getByRole('button',{name:'Dismiss'}));
  await waitFor(()=>expect(command).toHaveBeenCalledTimes(1));
  await act(async()=>{for(const finish of pending)finish();});
  await screen.findByText('No candidates in this view.');
  expect(screen.getByRole('region',{name:'Raw discovery'})).toBeTruthy();
  if(!unknown)expect(screen.getByText(candidate.payload.row.firmName)).toBeTruthy();
 }finally{cleanup();globalThis.callieApi=undefined;resetCrmMemory();}
});
