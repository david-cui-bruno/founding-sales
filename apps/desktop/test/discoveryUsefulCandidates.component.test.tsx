// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {DiscoveryUsefulCandidates,type UsefulDiscoveryList} from '../src/renderer/sourcing/DiscoveryUsefulCandidates.tsx';
import {DiscoveryReviewForm,type SaveDiscoveryReview} from '../src/renderer/sourcing/DiscoveryReviewForm.tsx';
import type {OperationOutput} from '../src/shared/operations.ts';
import {discoveryReviewCandidate,discoveryHumanReview} from '../../../packages/domain/test/sourcing/support/discoveryReviewFixtures.ts';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
const id='11111111-1111-4111-8111-111111111111';
const intake=discoveryReviewCandidate(),input=discoveryHumanReview(id);
const candidate={id,status:'needs_review' as const,revision:1,createdAt:'2026-10-21T03:00:00Z',payload:{kind:'discovery-v1' as const,row:intake.row},origins:intake.origins};
const review={id,candidateId:id,candidateRevision:1,reviewVersion:'discovery-review-v1' as const,contentDigest:'a'.repeat(64),evidence:input.evidence,assessment:input.assessment,reviewedAt:'2026-10-21T09:00:00Z'};
const populated:OperationOutput<'sourcing.discoveryUsefulList'>={view:{candidates:[{candidate,review,band:'review_first',admissionAuthorized:false,runtimeCallable:false}],hasMore:true},reason:null};
const empty:OperationOutput<'sourcing.discoveryUsefulList'>={view:{candidates:[],hasMore:false},reason:null};
afterEach(cleanup);
it('shows human interpretation/unknown boundaries and inert excerpts, never an acquisition or contact action',async()=>{
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValue(populated),save=vi.fn<SaveDiscoveryReview>();
  const {container}=render(<DiscoveryUsefulCandidates list={list} save={save}/>);
  await screen.findByText(candidate.payload.row.firmName);expect(screen.getByText(/Human priority: Review first/)).toBeTruthy();expect(screen.getByText(/Firm identity: not independently verified/)).toBeTruthy();
  expect(screen.getByText(/paragraph \[b16\]/)).toBeTruthy();expect(screen.getByText(/legal_clearance_unknown/)).toBeTruthy();expect(container.querySelector('a,script,img,iframe')).toBeNull();expect(save).not.toHaveBeenCalled();expect(list).toHaveBeenCalledTimes(1);
  for(const name of ['Fetch','Research','Qualify','Keep for research','Admit','Call','Send','Import'])expect(screen.queryByRole('button',{name})).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Refresh useful queue'}));await waitFor(()=>expect(list).toHaveBeenCalledTimes(2));expect(save).not.toHaveBeenCalled();
});
it('paginates 50 at a time and resets offset on status or priority changes',async()=>{
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValue(populated);render(<DiscoveryUsefulCandidates list={list}/>);await screen.findByText(candidate.payload.row.firmName);
  fireEvent.click(screen.getByRole('button',{name:'Next useful page'}));await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'needs_review',offset:50}));await screen.findByText(candidate.payload.row.firmName);
  fireEvent.change(screen.getByLabelText('Useful priority'),{target:{value:'tentative'}});await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'needs_review',offset:0,band:'tentative'}));await screen.findByText(candidate.payload.row.firmName);
  fireEvent.change(screen.getByLabelText('Useful status'),{target:{value:'dismissed'}});await waitFor(()=>expect(list).toHaveBeenLastCalledWith({status:'dismissed',offset:0,band:'tentative'}));
});
it('distinguishes empty unknown and refused views, missing evidence stays unreviewed rather than rejected',async()=>{
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValueOnce({view:null,reason:'refused'}).mockResolvedValueOnce(empty).mockResolvedValueOnce({view:{candidates:[{candidate,review:null,band:'unreviewed',admissionAuthorized:false,runtimeCallable:false}],hasMore:false},reason:null});
  render(<DiscoveryUsefulCandidates list={list}/>);await screen.findByRole('alert');expect(screen.queryByText(/No discovery candidates in this priority/)).toBeNull();
  fireEvent.click(screen.getByRole('button',{name:'Refresh useful queue'}));await screen.findByText(/No discovery candidates in this priority/);
  fireEvent.click(screen.getByRole('button',{name:'Refresh useful queue'}));await screen.findByText(/No current review. Missing, stale, changed or inaccessible/);expect(screen.getByText(/Human priority: Unreviewed/)).toBeTruthy();
});
it('does not read disabled views, clears old-owner rows/form synchronously, ignores late reads and saves',async()=>{
  let finish:(value:OperationOutput<'sourcing.discoveryUsefulList'>)=>void=()=>{};
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValueOnce(populated).mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),save=vi.fn<SaveDiscoveryReview>().mockImplementation(()=>new Promise(()=>{}));
  const {rerender}=render(<DiscoveryUsefulCandidates list={list} save={save} enabled={false} privacyKey="one"/>);expect(list).not.toHaveBeenCalled();
  rerender(<DiscoveryUsefulCandidates list={list} save={save} privacyKey="one"/>);await screen.findByText(candidate.payload.row.firmName);fireEvent.click(screen.getByRole('button',{name:`Review service signal for ${candidate.payload.row.firmName}`}));await screen.findByRole('form');
  rerender(<DiscoveryUsefulCandidates list={list} save={save} privacyKey="two"/>);expect(screen.queryByText(candidate.payload.row.firmName)).toBeNull();expect(screen.queryByRole('form')).toBeNull();
  const oldFinish=finish;rerender(<DiscoveryUsefulCandidates list={list} save={save} privacyKey="three"/>);
  await act(async()=>oldFinish(populated));expect(screen.queryByText(candidate.payload.row.firmName)).toBeNull();await act(async()=>finish(empty));await screen.findByText(/No discovery candidates in this priority/);
});
it('isolates previous session epoch without a changed privacy label',async()=>{
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValueOnce(populated).mockImplementation(()=>new Promise(()=>{}));
  const {rerender}=render(<DraftsProvider key="one"><DiscoveryUsefulCandidates list={list}/></DraftsProvider>);await screen.findByText(candidate.payload.row.firmName);
  rerender(<DraftsProvider key="two"><DiscoveryUsefulCandidates list={list}/></DraftsProvider>);expect(screen.queryByText(candidate.payload.row.firmName)).toBeNull();
});
it('saves an explicit unknown review without inventing evidence and refreshes only after command acceptance',async()=>{
  const list=vi.fn<UsefulDiscoveryList>().mockResolvedValue(populated),save=vi.fn<SaveDiscoveryReview>().mockResolvedValue({result:{review:{...review,evidence:[],assessment:{...review.assessment,serviceSignal:'unknown'}},alreadyRecorded:false},reason:null});
  render(<DiscoveryUsefulCandidates list={list} save={save}/>);await screen.findByText(candidate.payload.row.firmName);fireEvent.click(screen.getByRole('button',{name:`Review service signal for ${candidate.payload.row.firmName}`}));
  const form=screen.getByRole('form');expect(within(form).getByText(/No retained excerpt: service remains unknown/)).toBeTruthy();expect((within(form).getByRole('button',{name:'Save human interpretation'}) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(within(form).getByRole('checkbox',{name:/I reviewed the minimized public-business/}));fireEvent.click(within(form).getByRole('button',{name:'Save human interpretation'}));
  await waitFor(()=>expect(save).toHaveBeenCalledTimes(1));expect(save.mock.calls[0]![0]).toMatchObject({candidateId:id,expectedRevision:1,reviewVersion:'discovery-review-v1',evidence:[],assessment:{serviceSignal:'unknown',websiteAssociation:'unknown'}});await waitFor(()=>expect(list).toHaveBeenCalledTimes(2));
});
it('requires original retained provenance and refuses heading-only paragraph submission locally',async()=>{
  const save=vi.fn<SaveDiscoveryReview>(),onSaved=vi.fn();render(<DiscoveryReviewForm candidate={candidate} save={save} onSaved={onSaved} onCancel={()=>{}}/>);
  fireEvent.click(screen.getByRole('checkbox',{name:'Include one retained excerpt'}));
  for(const [label,value] of [['Original page URL',input.evidence[0]!.url],['Original content SHA-256',input.evidence[0]!.contentHash],['Original retrieved-at ISO timestamp',input.evidence[0]!.retrievedAt],['Original block ID','b16'],['Minimized public-business excerpt',input.evidence[0]!.blocks[0]!.text]])fireEvent.change(screen.getByLabelText(label!),{target:{value}});
  fireEvent.change(screen.getByLabelText('Block kind'),{target:{value:'heading'}});fireEvent.change(screen.getByLabelText('Human service interpretation'),{target:{value:'paragraph_supported'}});
  fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed the minimized public-business/}));fireEvent.click(screen.getByRole('button',{name:'Save human interpretation'}));await screen.findByRole('alert');expect(save).not.toHaveBeenCalled();
  save.mockResolvedValue({result:{review,alreadyRecorded:false},reason:null});fireEvent.change(screen.getByLabelText('Block kind'),{target:{value:'paragraph'}});fireEvent.click(screen.getByRole('button',{name:'Save human interpretation'}));await waitFor(()=>expect(onSaved).toHaveBeenCalledTimes(1));
  expect(save.mock.calls[0]![0]).toMatchObject({evidence:[{source:{provider:intake.row.source.provider,release:intake.row.source.release,recordId:intake.row.source.recordId},url:input.evidence[0]!.url,retrievedAt:input.evidence[0]!.retrievedAt,basis:'retained_excerpt',completeness:'unknown',blocks:[{kind:'paragraph',blockId:'b16'}]}]});
});
it('reconciles an uncertain save using the same command ID and ignores response after form unmount',async()=>{
  let finish:(value:OperationOutput<'sourcing.discoveryReview'>)=>void=()=>{};
  const save=vi.fn<SaveDiscoveryReview>().mockRejectedValueOnce(Error('offline')).mockImplementation(()=>new Promise(resolve=>{finish=resolve;})),onSaved=vi.fn();
  const {unmount}=render(<DiscoveryReviewForm candidate={candidate} save={save} onSaved={onSaved} onCancel={()=>{}}/>);
  fireEvent.click(screen.getByRole('checkbox',{name:/I reviewed the minimized public-business/}));fireEvent.click(screen.getByRole('button',{name:'Save human interpretation'}));await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button',{name:'Save human interpretation'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[1]![0].commandId).toBe(save.mock.calls[0]![0].commandId);
  unmount();await act(async()=>finish({result:{review,alreadyRecorded:false},reason:null}));expect(onSaved).not.toHaveBeenCalled();
});
