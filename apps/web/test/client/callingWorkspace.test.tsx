// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {manualProspectSchema,type CallingWrapInput} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingWorkspace} from '../../src/client/CallingWorkspace.tsx';
import {CALLING_PENDING_KEY,installCallingCustody} from '../../src/client/CallingPending.ts';
import {CallingContext,callingSafeWebsite,callingWebsiteIdentitySupported} from '../../src/client/CallingContext.tsx';
import {CallingQueue,type CallingQueueEntry} from '../../src/client/CallingQueue.tsx';
const id='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002';
const prospect=manualProspectSchema.parse({candidateId:id,revision:1,observedName:'Synthetic unknown-phone candidate',website:'https://synthetic.example.test/',locality:'Dallas',region:'TX',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Synthetic retained source',url:'https://source.example.test/',observedAt:'2026-10-20T00:00:00.000Z'}],sourceNotices:[],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
const clients:BrowserClient[]=[];
function setup(){let lost=false;const writes:CallingWrapInput[]=[],routes:string[]=[];const storage=localStorage;const fetcher=vi.fn<typeof fetch>(async(url,init)=>{const path=String(url);routes.push(path);if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});if(path.endsWith('/prospects/list'))return Response.json({prospects:[prospect],hasMore:false});if(path.endsWith('/today/actions/v4'))return Response.json({version:4,workspaceId:id,businessTimeZone:'America/New_York',asOf:'2026-10-26T00:00:00.000Z',actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});if(path.endsWith('/calling/wrap')){const input=JSON.parse(String(init?.body)) as CallingWrapInput;writes.push(input);if(lost)throw Error('Response lost');if(input.kind!=='candidate')throw Error('Raw must not become Firm');return Response.json({status:'accepted',replayed:false,result:{kind:'candidate',activity:{candidateId:id,candidateRevision:1,attemptId:input.attemptId,activityRevision:1},staleIntroductions:'not_applicable',followUp:input.promisedEmail?{state:'queued_for_review',draftId:input.promisedEmail.draftId,revision:1}:{state:'not_requested'}}});}if(path.endsWith('/calling/follow-ups/read')){const input=writes[0];if(!input?.promisedEmail)throw Error('No draft');return Response.json({draft:{draftId:input.promisedEmail.draftId,revision:1,source:{kind:'candidate',candidateId:id,candidateRevision:1,attemptId:input.kind==='candidate'?input.attemptId:other},availability:'available',createdAt:'2026-10-26T00:00:00.000Z',updatedAt:'2026-10-26T00:00:00.000Z',content:{subject:input.promisedEmail.subject,body:input.promisedEmail.body},state:'queued_for_review',recipient:'unresolved',sendAuthority:'not_granted'}});}throw Error('Unexpected route');});
 const client=new BrowserClient({fetch:fetcher,storage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);installCallingCustody(client);return {client,writes,routes,lose:()=>{lost=true;}};}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);Object.defineProperty(navigator,'locks',{configurable:true,value:{request:vi.fn(async(_n:string,_o:unknown,work:()=>Promise<unknown>)=>work())}});});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();sessionStorage.clear();vi.unstubAllGlobals();});
async function open(){const f=setup();await f.client.refresh();render(<CallingWorkspace client={f.client} selection={{kind:'candidate',candidateId:id,expectedCandidateRevision:1}}/>);await waitFor(()=>expect(screen.getByLabelText('Actual outcome').matches(':disabled')).toBe(false));return f;}
it('unknown-phone manual report remains raw, attested and independent of dial/send authority',async()=>{const f=await open();expect(screen.getByRole('heading',{name:prospect.observedName})).not.toBeNull();expect(screen.getByRole('link',{name:'Open observed website ↗'}).getAttribute('href')).toBe(prospect.website);fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));await screen.findByRole('article',{name:'Recorded calling outcome'});expect(f.writes).toHaveLength(1);expect(f.writes[0]).toMatchObject({kind:'candidate',candidateId:id,expectedCandidateRevision:1,report:{result:'unknown',performedByUser:true,occurrence:{kind:'unknown'}}});expect(f.routes.some(r=>/dial|calls\/log|send|reserve/u.test(r))).toBe(false);});
it('promised text starts empty and private notes are not copied, accepted draft freshly read before navigation',async()=>{const f=await open();fireEvent.change(screen.getByLabelText('Actual outcome'),{target:{value:'conversation'}});fireEvent.change(screen.getByLabelText('Private call notes'),{target:{value:'PRIVATE personal context'}});fireEvent.change(screen.getByLabelText('Next action'),{target:{value:'promised_email'}});expect((screen.getByLabelText('Promised email body') as HTMLTextAreaElement).value).toBe('');fireEvent.change(screen.getByLabelText('Promised email subject'),{target:{value:'Independently authored overview'}});fireEvent.change(screen.getByLabelText('Promised email body'),{target:{value:'Independent recipient-facing text'}});fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome and promised email'}));await screen.findByRole('article',{name:'Recorded calling outcome'});expect(f.writes[0]?.promisedEmail).toMatchObject({subject:'Independently authored overview',body:'Independent recipient-facing text'});expect(JSON.stringify(f.writes[0]?.promisedEmail)).not.toContain('PRIVATE');await waitFor(()=>expect(f.routes).toContain('/browser/api/calling/follow-ups/read'));expect(localStorage.getItem(CALLING_PENDING_KEY)).not.toMatch(/PRIVATE|Independent/u);});
it('response loss holds Next and exact command, source view can be left without replay or prose persistence',async()=>{const f=await open();f.lose();fireEvent.click(screen.getByRole('checkbox',{name:/I personally performed/u}));fireEvent.click(screen.getByRole('button',{name:'Save outcome'}));await screen.findByText('Outcome UNKNOWN for this exact subject.');expect(screen.getByRole('button',{name:'Next prospect →'}).hasAttribute('disabled')).toBe(true);expect(f.writes).toHaveLength(1);expect(screen.getByRole('button',{name:'Recover exact Calling receipt'})).not.toBeNull();await act(async()=>{f.client.invalidate();});expect(screen.queryByLabelText('Private call notes')).toBeNull();expect(localStorage.getItem(CALLING_PENDING_KEY)).toBeNull();});
it('website links reject executable schemes, credential URLs and absent observations',()=>{for(const value of [null,'javascript:alert(1)','data:text/html,test','https://user:secret@example.test/'])expect(callingSafeWebsite(value)).toBeNull();expect(callingSafeWebsite('https://example.test/site')).toBe('https://example.test/site');});
it('a different entity host cannot make the observed website source-backed',()=>{expect(callingWebsiteIdentitySupported('https://selected.example.test/',['https://different.example.test/'])).toBe(false);expect(callingWebsiteIdentitySupported('https://selected.example.test/',['https://selected.example.test/about'])).toBe(true);expect(callingWebsiteIdentitySupported('https://selected.example.test/',['javascript:alert(1)'])).toBe(false);});

const phoneSource={runId:id,observationId:other,blockId:'phone',url:'https://phone-specific.example.test/contact',retrievedAt:'2026-10-25T12:34:56.000Z'};
const observed=manualProspectSchema.parse({...prospect,candidateId:other,revision:2,observedName:'Synthetic retained phone',observedPhone:'+12145550123',phoneBasis:'retained_observation',phoneEvidence:{state:'observed',value:'+12145550123',sources:[phoneSource]}});
function phoneEntry(p:typeof prospect):CallingQueueEntry{return {subject:{kind:'candidate',candidateId:p.candidateId,expectedCandidateRevision:p.revision},label:p.observedName,prospect:p};}
it('retained phone Calling brief uses phone-specific provenance, drops changed evidence and clears on session loss',async()=>{
 const f=setup();await f.client.refresh();const ready=vi.fn();
 const view=render(<CallingContext client={f.client} entry={phoneEntry(observed)} onReady={ready}/>);
 const brief=screen.getByRole('region',{name:'Current calling brief'});
 await within(brief).findByText('Phone +12145550123 · observed, not call-ready');
 expect(within(brief).getByRole('link',{name:phoneSource.url}).getAttribute('href')).toBe(phoneSource.url);
 expect(within(brief).getByText(/Source retrieved:/u).textContent).toContain(phoneSource.retrievedAt);
 expect(within(brief).getByText(/Phone type unknown\. Ownership/u)).toBeTruthy();
 expect(within(brief).queryByRole('link',{name:/source-backed website/u})).toBeNull();
 const changed=manualProspectSchema.parse({...observed,observedPhone:null,phoneBasis:'unknown',phoneEvidence:{state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}}});
 view.rerender(<CallingContext client={f.client} entry={phoneEntry(changed)} onReady={ready}/>);
 await within(brief).findByText('Phone unknown · not extracted');
 expect(within(brief).queryByRole('link',{name:phoneSource.url})).toBeNull();expect(brief.textContent).not.toContain('+12145550123');
 await act(async()=>{f.client.invalidate();});expect(screen.queryByLabelText('Retained phone evidence')).toBeNull();
 expect(f.writes).toHaveLength(0);expect(f.routes).toEqual(['/browser/session']);
});
it('retained phone queue keeps unknown and conflicting rows, selects exact page-two observation and refreshes availability',async()=>{
 const ambiguous=manualProspectSchema.parse({...prospect,candidateId:'00000000-0000-4000-8000-000000000003',observedName:'Synthetic ambiguous phone',phoneEvidence:{state:'conflicting',reason:'retained_source_ambiguous',sources:[phoneSource]}});
 let changed=false;const offsets:number[]=[];
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  if(path.endsWith('/today/actions/v4'))return Response.json({version:4,workspaceId:id,businessTimeZone:'America/New_York',asOf:'2026-10-26T00:00:00.000Z',actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});
  if(path.endsWith('/prospects/list')){const input=JSON.parse(String(init?.body)) as {offset:number};offsets.push(input.offset);return Response.json({prospects:input.offset===0?[prospect,ambiguous]:[changed?{...prospect,candidateId:observed.candidateId,revision:observed.revision,observedName:observed.observedName}:observed],hasMore:input.offset===0});}
  throw Error('Unexpected changed-path request');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);await client.refresh();const selected=vi.fn();
 render(<CallingQueue client={client} onSelect={selected} disabled={false}/>);
 await waitFor(()=>expect(offsets).toEqual([0]));
 fireEvent.click(screen.getByRole('button',{name:'Retained list'}));
 await screen.findByRole('button',{name:/Synthetic unknown-phone candidate.*Phone unknown/u});
 expect(screen.getByRole('button',{name:/Synthetic ambiguous phone.*Phone conflicting/u})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Next page'}));
 const row=await screen.findByRole('button',{name:/Synthetic retained phone.*Phone \+12145550123/u});fireEvent.click(row);
 expect(selected).toHaveBeenCalledWith(phoneEntry(observed));expect(offsets).toEqual([0,0,50]);expect(screen.queryByRole('link')).toBeNull();
 changed=true;fireEvent.click(screen.getByRole('button',{name:'Refresh'}));
 await screen.findByRole('button',{name:/Synthetic retained phone.*Phone unknown/u});expect(screen.queryByText(/Phone \+12145550123/u)).toBeNull();
 expect(offsets).toEqual([0,0,50,50]);expect(fetcher.mock.calls.every(([url])=>/session|today\/actions\/v4|prospects\/list/u.test(String(url)))).toBe(true);
});
it('retained phone late candidate read cannot resurrect details after session loss',async()=>{
 let resolve:(value:Response)=>void=()=>{throw Error('Read not started');};
 const pending=new Promise<Response>(done=>{resolve=done;});
 const fetcher=vi.fn<typeof fetch>(async(url)=>String(url)==='/browser/session'?Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()}):pending);
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);await client.refresh();const ready=vi.fn();
 render(<CallingContext client={client} entry={{subject:phoneEntry(observed).subject,label:observed.observedName}} onReady={ready}/>);
 expect(fetcher).toHaveBeenCalledTimes(2);await act(async()=>{client.invalidate();resolve(Response.json({prospects:[observed],hasMore:false}));});
 expect(screen.queryByLabelText('Retained phone evidence')).toBeNull();expect(screen.queryByRole('link',{name:phoneSource.url})).toBeNull();expect(ready.mock.calls.every(([data])=>data===null)).toBe(true);
});
it('retained phone unavailable exact candidate does not borrow another observation provenance',async()=>{
 const f=setup();await f.client.refresh();const ready=vi.fn();
 render(<CallingContext client={f.client} entry={{subject:phoneEntry(observed).subject,label:observed.observedName}} onReady={ready}/>);
 await screen.findByText(/Current brief unavailable or source changed/u);
 expect(screen.queryByLabelText('Retained phone evidence')).toBeNull();expect(screen.queryByRole('link')).toBeNull();expect(ready.mock.calls.every(([data])=>data===null)).toBe(true);
 expect(f.writes).toHaveLength(0);
});
