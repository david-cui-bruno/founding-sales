// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {manualProspectPhoneEvidenceSchema,manualProspectSchema} from '@fss/contracts';
import {RetainedPhoneEvidence} from '../../src/client/RetainedPhoneEvidence.tsx';
import {CallingContext} from '../../src/client/CallingContext.tsx';
import {CallingQueue,type CallingQueueEntry} from '../../src/client/CallingQueue.tsx';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {ManualProspectCard} from '../../src/client/ManualProspectCard.tsx';
import {ManualProspectTable} from '../../src/client/ManualProspectTable.tsx';

const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const now=Date.parse('2026-10-26T07:00:00.000Z'),value='+12145550123';
const source={runId:id,observationId:other,blockId:'contact',url:'https://phone.example.test/contact',retrievedAt:'2026-10-25T12:34:56.000Z'};
const literal={...source,method:'retained_original_literal',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',literal:'214-555-0123',start:8,end:20,label:'Office',labelStart:0,labelEnd:6,normalizedValue:value,normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{kind:'candidate_source',sourceUrl:source.url},lineage:{kind:'provider_original'}};
const coverage={parser:'manual-literal-phone-v1',state:'complete',observations:3,blocks:3};
function temporary(milliseconds:number){return {...literal,authority:{kind:'phone_discovery',runId:id,expiresAt:new Date(now+milliseconds).toISOString()}};}
function evidence(milliseconds=1000){return manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[source,temporary(5000),temporary(milliseconds)],coverage});}
function clock(){vi.useFakeTimers();vi.setSystemTime(now);}
const clients:BrowserClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(client=>client.dispose());localStorage.clear();vi.restoreAllMocks();vi.useRealTimers();});

it.each([true,false])('retained expiry clears the entire mixed-source enrichment at its earliest dependency, compact=%s',compact=>{
 clock();render(<RetainedPhoneEvidence compact={compact} evidence={evidence()}/>);
 expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(999));expect(screen.queryByText(/observed, not call-ready/u)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(1));expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();expect(document.body.textContent).not.toContain(value);
 expect(screen.queryByRole('link')).toBeNull();expect(screen.queryByText(/Source label:|Retained phone scan:|Source retrieved:/u)).toBeNull();
 act(()=>vi.advanceTimersByTime(10000));expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
});
it('retained expiry clears conflicting provenance without selecting a surviving source',()=>{
 clock();render(<RetainedPhoneEvidence evidence={manualProspectPhoneEvidenceSchema.parse({state:'conflicting',reason:'unresolved_retained_literal',sources:[source,temporary(1000)],coverage})}/>);
 expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();
 act(()=>vi.advanceTimersByTime(1000));expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 expect(screen.queryByRole('link')).toBeNull();expect(screen.queryByText(/Retained phone scan:/u)).toBeNull();
});
it('retained expiry refuses an already-expired snapshot on first render and unrelated rerender',()=>{
 clock();const expired=evidence(0);const view=render(<RetainedPhoneEvidence evidence={expired}/>);
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(screen.queryByRole('link')).toBeNull();
 view.rerender(<RetainedPhoneEvidence compact evidence={expired}/>);expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
});
it('retained expiry rejects stale evidence on rerender even when the cleanup callback was delayed',()=>{
 clock();const retained=evidence(),view=render(<RetainedPhoneEvidence evidence={retained}/>);
 vi.setSystemTime(now+1000);view.rerender(<RetainedPhoneEvidence compact evidence={retained}/>);
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
});
it('retained expiry cancels obsolete callbacks for current new props and on unmount',()=>{
 clock();const schedule=vi.spyOn(globalThis,'setTimeout'),view=render(<RetainedPhoneEvidence evidence={evidence()}/>);
 const obsolete=schedule.mock.calls[0]?.[0];if(typeof obsolete!=='function')throw Error('Expiry callback not scheduled');
 expect(vi.getTimerCount()).toBe(1);act(()=>vi.advanceTimersByTime(500));
 view.rerender(<RetainedPhoneEvidence evidence={evidence(3000)}/>);
 // Even an already-queued obsolete callback may only rerender current evidence.
 act(()=>obsolete());
 expect(vi.getTimerCount()).toBe(1);act(()=>vi.advanceTimersByTime(500));
 expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(2000));expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
 view.rerender(<RetainedPhoneEvidence evidence={evidence(10000)}/>);
 expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();expect(vi.getTimerCount()).toBe(1);
 view.unmount();expect(vi.getTimerCount()).toBe(0);act(()=>vi.advanceTimersByTime(10000));
});
it('retained expiry preserves evidence without finite discovery authority and cancels its old timer',()=>{
 clock();const view=render(<RetainedPhoneEvidence evidence={evidence()}/>);
 const retained=manualProspectPhoneEvidenceSchema.parse({state:'observed',value,sources:[source,literal],coverage});
 view.rerender(<RetainedPhoneEvidence evidence={retained}/>);expect(vi.getTimerCount()).toBe(0);
 act(()=>vi.advanceTimersByTime(10000));expect(screen.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 expect(screen.getByText(/Source label: Office/u)).toBeTruthy();
});

function prospect(){return manualProspectSchema.parse({candidateId:id,revision:1,observedName:'Expiry fixture',website:'https://company.example.test/',locality:'Dallas',region:'TX',observedPhone:value,phoneBasis:'retained_observation',phoneEvidence:evidence(),sources:[{label:'Raw retained source',url:'https://company.example.test/',observedAt:source.retrievedAt}],sourceNotices:[],retainedAt:source.retrievedAt,state:'new',unknowns:['Identity unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});}
it('retained expiry clears actual ManualProspectCard inspector enrichment while preserving raw review',()=>{
 clock();const p=prospect(),feedback=vi.fn(),activity=vi.fn(),prepare=vi.fn();
 render(<ManualProspectCard prospect={p} disabled={false} feedback={feedback} activity={activity} prepare={prepare}/>);
 const card=within(screen.getByRole('article',{name:`Manual prospect ${id}`}));
 fireEvent.click(card.getByText('Observed name, sources and details'));
 expect(card.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 expect(card.getAllByRole('link',{name:source.url})).toHaveLength(3);
 act(()=>vi.advanceTimersByTime(1000));
 expect(card.getByText('Phone unknown · not extracted')).toBeTruthy();
 expect(screen.getByRole('article').textContent).not.toContain(value);
 expect(card.queryByRole('link',{name:source.url})).toBeNull();
 expect(card.queryByText(/Retained phone scan:|Retained original literal:|Captured content hash|Authority:/u)).toBeNull();
 expect(card.getByRole('heading',{name:p.observedName})).toBeTruthy();
 expect(card.getByRole('link',{name:'Raw retained source'})).toBeTruthy();
 expect(card.getByRole('button',{name:'Keep'}).hasAttribute('disabled')).toBe(false);
 expect(feedback).not.toHaveBeenCalled();expect(activity).not.toHaveBeenCalled();expect(prepare).not.toHaveBeenCalled();
});
it('retained expiry clears actual ManualProspectTable row without changing its timeless neighbor or selection',()=>{
 clock();const p=prospect(),select=vi.fn();
 const timeless=manualProspectSchema.parse({...p,candidateId:other,observedName:'Timeless fixture',phoneEvidence:{state:'observed',value,sources:[source]}});
 render(<ManualProspectTable prospects={[p,timeless]} selected={p.candidateId} select={select}/>);
 const table=within(screen.getByRole('table'));
 const row=table.getByRole('row',{name:/Expiry fixture/u}),neighbor=table.getByRole('row',{name:/Timeless fixture/u});
 expect(within(row).getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 act(()=>vi.advanceTimersByTime(1000));
 expect(within(row).getByText('Phone unknown · not extracted')).toBeTruthy();expect(row.textContent).not.toContain(value);
 expect(row.querySelector('.manual-phone-not_extracted')).not.toBeNull();
 expect(within(neighbor).getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();
 const button=within(row).getByRole('button',{name:/Expiry fixture/u});expect(button.getAttribute('aria-current')).toBe('true');
 expect(select).not.toHaveBeenCalled();fireEvent.click(button);expect(select).toHaveBeenCalledExactlyOnceWith(p.candidateId);
 expect(p.phoneEvidence?.state).toBe('observed');expect(p.observedPhone).toBe(value);
});
async function clientFixture(){
 const fetcher=vi.fn<typeof fetch>(async url=>{
  const path=String(url);
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(now+60000).toISOString()});
  if(path.endsWith('/today/actions/v4'))return Response.json({version:4,workspaceId:id,businessTimeZone:'America/New_York',asOf:new Date(now).toISOString(),actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});
  if(path.endsWith('/prospects/list'))return Response.json({prospects:[prospect()],hasMore:false});
  throw Error('Unexpected expiry-test IO');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);await client.refresh();return {client,fetcher};
}
it('retained expiry removes the compact Calling queue phone without IO or hiding its selectable raw row',async()=>{
 clock();const {client,fetcher}=await clientFixture();const selected=vi.fn();
 await act(async()=>{render(<CallingQueue client={client} onSelect={selected} disabled={false}/>);});
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'Retained list'}));});
 expect(screen.getByRole('button',{name:/Expiry fixture.*Phone \+12145550123/u})).toBeTruthy();const calls=fetcher.mock.calls.length;
 act(()=>vi.advanceTimersByTime(1000));const row=screen.getByRole('button',{name:/Expiry fixture.*Phone unknown/u});
 expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();fireEvent.click(row);
 expect(selected).toHaveBeenCalledWith(expect.objectContaining({subject:{kind:'candidate',candidateId:id,expectedCandidateRevision:1}}));
 expect(fetcher).toHaveBeenCalledTimes(calls);
});
it('retained expiry removes full Calling brief phone and all phone-specific sources with no new IO',async()=>{
 clock();const {client,fetcher}=await clientFixture(),p=prospect();const entry:CallingQueueEntry={subject:{kind:'candidate',candidateId:id,expectedCandidateRevision:1},label:p.observedName,prospect:p};
 await act(async()=>{render(<CallingContext client={client} entry={entry} onReady={vi.fn()}/>);});
 const brief=within(screen.getByRole('region',{name:'Current calling brief'}));
 expect(brief.getByText(`Phone ${value} · observed, not call-ready`)).toBeTruthy();expect(brief.getAllByRole('link',{name:source.url})).toHaveLength(3);
 act(()=>vi.advanceTimersByTime(1000));expect(brief.getByText('Phone unknown · not extracted')).toBeTruthy();
 expect(brief.queryByRole('link',{name:source.url})).toBeNull();expect(brief.queryByText(/Retained phone scan:|Source label:/u)).toBeNull();
 expect(brief.getByRole('heading',{name:p.observedName})).toBeTruthy();expect(brief.getByRole('link',{name:'Open observed website ↗'})).toBeTruthy();
 expect(fetcher.mock.calls.map(([url])=>String(url))).toEqual(['/browser/session']);
});
