// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {manualProspectSchema,prospectPhoneDiscoveryViewSchema,type ProspectPhoneDiscoveryView} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserPhoneDiscovery} from '../../src/client/BrowserPhoneDiscovery.tsx';
import {CallingContext} from '../../src/client/CallingContext.tsx';
import {QUALIFICATION_PENDING_KEY} from '../../src/client/QualificationPending.ts';
import {dispatchQualification,reconcilePhoneDiscovery} from '../../src/client/QualificationDispatch.ts';
import {privateDraftCanonicalJson,privateDraftSHA256} from '../../src/client/PrivateDraftCustody.ts';

const candidateId='00000000-0000-4000-8000-000000000001',other='00000000-0000-4000-8000-000000000002',runId='00000000-0000-4000-8000-000000000003',commandId='00000000-0000-4000-8000-000000000004';
const root='/sourcing/candidates/phone-discovery/';
const clients:BrowserClient[]=[];
function fresh():ProspectPhoneDiscoveryView{
 const now=new Date().toISOString(),expiresAt=new Date(Date.now()+5000).toISOString();
 return prospectPhoneDiscoveryViewSchema.parse({runId,candidateId,candidateRevision:1,state:'complete',reason:null,requestedAt:now,checkedAt:now,expiresAt,method:'company-public-phone-v1',phoneEvidence:{state:'observed',value:'+12145550123',coverage:{parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1},sources:[{runId,observationId:other,blockId:'phone',url:'https://company.example.test/contact',retrievedAt:now,method:'retained_original_literal',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',literal:'214-555-0123',start:8,end:20,label:'Office',labelStart:0,labelEnd:6,normalizedValue:'+12145550123',normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{kind:'phone_discovery',runId,expiresAt},lineage:{kind:'provider_original'}}]},website:'https://company.example.test/',channelAuthority:'not_granted'});
}
function setup(){
 let view:ProspectPhoneDiscoveryView|null=fresh(),lost=false,receipt:'unknown'|'accepted'|'refused'='accepted',requestGate:Promise<Response>|null=null,readGate:Promise<Response>|null=null;
 const calls:{path:string;body:unknown}[]=[],uuid=vi.fn(()=>commandId);
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  const path=String(url);
  if(path==='/browser/session')return Response.json({status:'signed_in',workspaceId:candidateId,userId:candidateId,deviceId:candidateId,role:'admin',revision:'session-one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  const suffix=path.replace('/browser/api','');calls.push({path:suffix,body:JSON.parse(String(init?.body)) as unknown});
  if(suffix===`${root}request`){if(requestGate)return requestGate;if(lost)throw Error('Lost response');return Response.json({status:'accepted',replayed:false,result:{runId}});}
  if(suffix===`${root}read`)return readGate??Response.json(view);
  if(suffix===`${root}receipt`)return Response.json(receipt==='accepted'?{state:receipt,result:{runId}}:{state:receipt});
  throw Error('Forbidden unexpected path');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:uuid});clients.push(client);
 return {client,calls,uuid,fetcher,setView:(next:ProspectPhoneDiscoveryView|null)=>{view=next;},lose:()=>{lost=true;},setReceipt:(next:'unknown'|'accepted'|'refused')=>{receipt=next;},holdRequest:(gate:Promise<Response>)=>{requestGate=gate;},holdRead:(gate:Promise<Response>)=>{readGate=gate;}};
}
async function mount(){const f=setup();await f.client.refresh();const view=render(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={1}/>);return {...f,view};}
async function click(name:string){await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));});}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();sessionStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();});

it('phone discovery explicit request then separate read uses exact IDs and server-owned version with no automatic IO',async()=>{
 const f=await mount();expect(f.calls).toEqual([]);
 await click('Find business phone');expect(f.calls).toEqual([{path:`${root}request`,body:{candidateId,expectedRevision:1,commandId}}]);
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByRole('button',{name:'Find business phone'}).matches(':disabled')).toBe(true);
 await click('Read phone result');expect(f.calls[1]).toEqual({path:`${root}read`,body:{candidateId,expectedRevision:1}});
 expect(screen.getByText('Phone +12145550123 · observed, not call-ready')).toBeTruthy();
 expect(screen.getByRole('link',{name:'https://company.example.test/contact'})).toBeTruthy();
 expect(screen.getByText(/Phone type unknown\. Ownership/u)).toBeTruthy();
 const bytes=localStorage.getItem(QUALIFICATION_PENDING_KEY)!;expect(bytes).not.toMatch(/12145550123|company\.example|phoneEvidence|clientVersion|checkedAt/u);
 expect(f.uuid).toHaveBeenCalledTimes(1);expect(f.calls.every(c=>!JSON.stringify(c.body).includes('clientVersion')&&c.path.startsWith(root))).toBe(true);
});
it('phone discovery scope dependencies retain result across same-binding rerenders and refresh, then clear for UNKNOWN',async()=>{
 const f=await mount();await click('Read phone result');const epoch=f.client.epoch;
 for(let index=0;index<3;index++){
  f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={1}/>);
  expect(screen.getByText('Phone +12145550123 · observed, not call-ready')).toBeTruthy();
 }
 await act(async()=>{await f.client.refresh();});
 expect(f.client.epoch).toBe(epoch);expect(screen.getByText('Phone +12145550123 · observed, not call-ready')).toBeTruthy();
 expect(screen.getByRole('button',{name:'Read phone result'}).matches(':disabled')).toBe(false);
 expect(f.calls).toEqual([{path:`${root}read`,body:{candidateId,expectedRevision:1}}]);expect(f.uuid).not.toHaveBeenCalled();
 act(()=>{f.client.qualification.prepare({kind:'phone_discovery',candidateId:other,expectedRevision:1});});
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByText(/Another command is unresolved/u)).toBeTruthy();
 await click('Find business phone');await click('Read phone result');expect(f.calls).toHaveLength(1);
});
it.each(['forbidden','role'] as const)('phone discovery scope dependencies clear retained result on current %s revocation',async(revocation)=>{
 const f=await mount();await click('Read phone result');expect(screen.getByLabelText('Current phone discovery result')).toBeTruthy();
 f.fetcher.mockImplementationOnce(async()=>revocation==='forbidden'?new Response(null,{status:403}):Response.json({status:'signed_in',workspaceId:candidateId,userId:candidateId,deviceId:candidateId,role:'salesperson',revision:'session-one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()}));
 await act(async()=>{await expect(f.client.refresh()).rejects.toThrow();});
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.queryByText(/Phone \+12145550123/u)).toBeNull();
 f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={1}/>);
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();
 expect(screen.getByRole('button',{name:'Find business phone'}).matches(':disabled')).toBe(true);expect(screen.getByRole('button',{name:'Read phone result'}).matches(':disabled')).toBe(true);
 await click('Find business phone');await click('Read phone result');
 expect(f.calls).toEqual([{path:`${root}read`,body:{candidateId,expectedRevision:1}}]);expect(f.uuid).not.toHaveBeenCalled();
});
it('phone discovery lost response stays held across remount and recovers receipt only, never redispatches',async()=>{
 const f=await mount();f.lose();await click('Find business phone');expect(f.calls.map(c=>c.path)).toEqual([`${root}request`]);
 const bytes=localStorage.getItem(QUALIFICATION_PENDING_KEY);expect(f.client.qualification.read()?.receipt).toBeUndefined();
 f.view.unmount();render(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={1}/>);
 expect(screen.getByRole('button',{name:'Find business phone'}).matches(':disabled')).toBe(true);expect(screen.getByRole('button',{name:'Read phone result'}).matches(':disabled')).toBe(true);
 f.setReceipt('unknown');await click('Check phone discovery receipt');expect(localStorage.getItem(QUALIFICATION_PENDING_KEY)).toBe(bytes);
 expect(f.calls.filter(c=>c.path===`${root}request`)).toHaveLength(1);expect(f.uuid).toHaveBeenCalledTimes(1);
 f.setReceipt('accepted');await click('Check phone discovery receipt');expect(f.client.qualification.read()?.receipt).toEqual({kind:'phone_discovery',result:{runId}});
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();await click('Read phone result');expect(screen.getByText('Phone +12145550123 · observed, not call-ready')).toBeTruthy();
 expect(f.calls.map(c=>c.path)).toEqual([`${root}request`,`${root}receipt`,`${root}receipt`,`${root}read`]);
});
it('phone discovery foreign unresolved custody is never dispatched or reconciled by this candidate control',async()=>{
 const f=setup();await f.client.refresh();f.client.qualification.prepare({kind:'phone_discovery',candidateId:other,expectedRevision:3});
 render(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={1}/>);
 expect(screen.getByText(/Another command is unresolved/u)).toBeTruthy();expect(screen.queryByRole('button',{name:'Check phone discovery receipt'})).toBeNull();
 await click('Find business phone');await click('Read phone result');expect(f.calls).toEqual([]);expect(f.uuid).toHaveBeenCalledTimes(1);
});
it.each(['candidate','revision','run'])('phone discovery rejects foreign %s result without showing phone evidence',async(kind)=>{
 const f=await mount();await click('Find business phone');const original=fresh();
 f.setView({...original,...(kind==='candidate'?{candidateId:other}:kind==='revision'?{candidateRevision:2}:{runId:other})});
 await click('Read phone result');expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.queryByText(/Phone \+12145550123/u)).toBeNull();expect(screen.getByRole('status')).toBeTruthy();
});
it.each(['pending','running','unavailable'] as const)('phone discovery reports %s without treating response payload as a selected endpoint',async(state)=>{
 const f=await mount();f.setView({...fresh(),state,reason:state==='unavailable'?'source_unavailable':null});await click('Read phone result');
 expect(screen.getByText(new RegExp(`Phone discovery ${state}`,'u'))).toBeTruthy();expect(screen.queryByText(/Phone \+12145550123/u)).toBeNull();expect(screen.getByText(new RegExp(`Phone evidence unavailable while discovery is ${state}`,'u'))).toBeTruthy();
});
it('phone discovery null and failed reads clear prior evidence while preserving unknown observation',async()=>{
 const f=await mount();await click('Read phone result');expect(screen.getByText(/Phone \+12145550123/u)).toBeTruthy();
 f.setView(null);await click('Read phone result');expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByText(/No phone discovery result is recorded/u)).toBeTruthy();
});
it.each(['candidate','revision','epoch','unmount'])('phone discovery late read cannot cross %s fence',async(change)=>{
 const f=await mount();let resolve:(value:Response)=>void=()=>{throw Error('No gate');};const gate=new Promise<Response>(done=>{resolve=done;});f.holdRead(gate);
 fireEvent.click(screen.getByRole('button',{name:'Read phone result'}));await waitFor(()=>expect(f.calls).toHaveLength(1));
 if(change==='candidate')f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={other} revision={1}/>);
 if(change==='revision')f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={candidateId} revision={2}/>);
 if(change==='epoch')await act(async()=>{f.client.invalidate();});
 if(change==='unmount')f.view.unmount();
 await act(async()=>{resolve(Response.json(fresh()));});expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.queryByText(/Phone \+12145550123/u)).toBeNull();expect(f.calls).toHaveLength(1);
});
it('phone discovery late request after candidate switch retains UNKNOWN receipt custody without new command',async()=>{
 const f=await mount();let resolve:(value:Response)=>void=()=>{throw Error('No gate');};f.holdRequest(new Promise<Response>(done=>{resolve=done;}));
 fireEvent.click(screen.getByRole('button',{name:'Find business phone'}));await waitFor(()=>expect(f.calls).toHaveLength(1));
 f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={other} revision={1}/>);
 await act(async()=>{resolve(Response.json({status:'accepted',replayed:false,result:{runId}}));});
 expect(f.client.qualification.read()?.receipt).toBeUndefined();expect(f.client.qualification.read()?.command.payload.candidateId).toBe(candidateId);expect(f.uuid).toHaveBeenCalledTimes(1);
 expect(screen.getByText(/Another command is unresolved/u)).toBeTruthy();expect(screen.queryByText(/Business phone discovery requested/u)).toBeNull();
});
it('phone discovery expiry clears result without polling, renewal or background capture',async()=>{
 vi.useFakeTimers();const f=await mount();await click('Read phone result');expect(screen.getByText(/Phone \+12145550123/u)).toBeTruthy();const count=f.calls.length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(5001);});
 expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByText(/Phone result expired/u)).toBeTruthy();expect(f.calls).toHaveLength(count);
});
it('phone discovery already expired response never renders stale evidence',async()=>{
 const f=await mount();f.setView({...fresh(),expiresAt:new Date(Date.now()-1).toISOString()});await click('Read phone result');expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByText(/Phone result expired/u)).toBeTruthy();
});
it('phone discovery earlier source-authority expiry clears evidence without IO',async()=>{
 vi.useFakeTimers();const f=await mount();const original=fresh();
 if(original.phoneEvidence.state!=='observed')throw Error('Expected literal fixture');
 const evidence={...original.phoneEvidence,sources:original.phoneEvidence.sources.map(source=>'method' in source?{...source,authority:{kind:'phone_discovery' as const,runId,expiresAt:new Date(Date.now()+1000).toISOString()}}:source)};
 f.setView({...original,phoneEvidence:evidence});await click('Read phone result');expect(screen.getByText(/Phone \+12145550123/u)).toBeTruthy();
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(f.calls).toHaveLength(1);
});
it('phone discovery changed selection during session preflight prevents first dispatch with held old IDs',async()=>{
 const f=await mount();let resolve:(value:Response)=>void=()=>{throw Error('No gate');};const gate=new Promise<Response>(done=>{resolve=done;});
 f.fetcher.mockImplementationOnce(async()=>gate);fireEvent.click(screen.getByRole('button',{name:'Find business phone'}));expect(f.uuid).toHaveBeenCalledTimes(1);
 f.view.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={other} revision={2}/>);
 await act(async()=>{resolve(Response.json({status:'signed_in',workspaceId:candidateId,userId:candidateId,deviceId:candidateId,role:'admin',revision:'session-one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()}));});
 expect(f.calls).toEqual([]);expect(f.client.qualification.read()?.command.payload).toEqual({candidateId,expectedRevision:1,commandId});expect(f.client.qualification.read()?.receipt).toBeUndefined();
 expect(screen.getByText(/Another command is unresolved/u)).toBeTruthy();
});
it('phone discovery confirmed refusal remains honest and cannot be retried by this control',async()=>{
 const f=await mount();f.lose();await click('Find business phone');f.setReceipt('refused');await click('Check phone discovery receipt');
 expect(screen.getByText(/Phone discovery request refused/u)).toBeTruthy();expect(screen.getByRole('button',{name:'Find business phone'}).matches(':disabled')).toBe(true);expect(f.calls.filter(c=>c.path===`${root}request`)).toHaveLength(1);
});
it('phone discovery UNKNOWN created during a read preflight prevents content dispatch',async()=>{
 const f=await mount();let resolve:(value:Response)=>void=()=>{throw Error('No gate');};const gate=new Promise<Response>(done=>{resolve=done;});f.fetcher.mockImplementationOnce(async()=>gate);
 fireEvent.click(screen.getByRole('button',{name:'Read phone result'}));
 act(()=>{f.client.qualification.prepare({kind:'phone_discovery',candidateId:other,expectedRevision:1});});
 await act(async()=>{resolve(Response.json({status:'signed_in',workspaceId:candidateId,userId:candidateId,deviceId:candidateId,role:'admin',revision:'session-one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()}));});
 expect(f.calls).toEqual([]);expect(screen.queryByLabelText('Current phone discovery result')).toBeNull();expect(screen.getByText(/Another command is unresolved/u)).toBeTruthy();
});
it('phone discovery repeated click while first request is outstanding never remints or redispatches',async()=>{
 const f=await mount();let resolve:(value:Response)=>void=()=>{throw Error('No gate');};f.holdRequest(new Promise<Response>(done=>{resolve=done;}));
 const button=screen.getByRole('button',{name:'Find business phone'});fireEvent.click(button);fireEvent.click(button);await waitFor(()=>expect(f.calls).toHaveLength(1));
 expect(f.uuid).toHaveBeenCalledTimes(1);await act(async()=>{resolve(Response.json({status:'accepted',replayed:false,result:{runId}}));});expect(f.calls).toHaveLength(1);
});
it('phone discovery shared helpers retain IDs, hash exact version-free payload and do receipt-only recovery',async()=>{
 const f=setup();await f.client.refresh();const held=f.client.qualification.prepare({kind:'phone_discovery',candidateId,expectedRevision:1});f.lose();
 await expect(dispatchQualification(f.client,held,()=>true)).rejects.toThrow();
 await expect(reconcilePhoneDiscovery(f.client,held,()=>true)).resolves.toBe('accepted');
 expect(f.calls[1]).toEqual({path:`${root}receipt`,body:{commandId,payloadHash:await privateDraftSHA256(privateDraftCanonicalJson({candidateId,expectedRevision:1}))}});
 expect(f.calls.filter(c=>c.path===`${root}request`)).toHaveLength(1);expect(localStorage.getItem(QUALIFICATION_PENDING_KEY)).not.toContain('clientVersion');
 await expect(reconcilePhoneDiscovery(f.client,f.client.qualification.read()!,()=>true)).rejects.toThrow();expect(f.calls).toHaveLength(2);
});
it('phone discovery Calling mount keeps original unknown record intact and exposes no qualification or dial controls',async()=>{
 const f=setup();await f.client.refresh();const p=manualProspectSchema.parse({candidateId,revision:1,observedName:'Synthetic company',website:null,locality:null,region:null,observedPhone:null,phoneBasis:'unknown',sources:[{label:'retained source',url:null,observedAt:null}],sourceNotices:[],retainedAt:new Date().toISOString(),state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
 const before=JSON.stringify(p);render(<CallingContext client={f.client} entry={{subject:{kind:'candidate',candidateId,expectedCandidateRevision:1},label:p.observedName,prospect:p}} onReady={vi.fn()}/>);
 expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(f.calls).toEqual([]);await click('Find business phone');await click('Read phone result');
 const result=screen.getByLabelText('Current phone discovery result');expect(within(result).getByText(/Phone \+12145550123/u)).toBeTruthy();expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();expect(JSON.stringify(p)).toBe(before);
 expect(screen.queryByRole('button',{name:/qualify|admit|dial|send/iu})).toBeNull();expect(f.calls.every(c=>c.path.startsWith(root))).toBe(true);
});
it('phone discovery actual Calling current conflicting read selects no winner or acquisition',async()=>{
 const f=setup();await f.client.refresh();const original=fresh();
 if(original.phoneEvidence.state!=='observed')throw Error('Expected discovery literal fixture');
 const legacy={runId:other,observationId:candidateId,blockId:'business-phone',url:'https://company.example.test/about',retrievedAt:original.checkedAt};
 const current=prospectPhoneDiscoveryViewSchema.parse({...original,phoneEvidence:{state:'conflicting',reason:'multiple_retained_numbers',sources:[legacy,...original.phoneEvidence.sources],coverage:original.phoneEvidence.coverage}});
 f.setView(current);
 const prospect=manualProspectSchema.parse({candidateId,revision:1,observedName:'FICTIONAL conflicting phone company',website:original.website,locality:null,region:null,observedPhone:null,phoneBasis:'unknown',phoneEvidence:current.phoneEvidence,sources:[{label:'retained source',url:legacy.url,observedAt:legacy.retrievedAt}],sourceNotices:[],retainedAt:original.requestedAt,state:'new',unknowns:[],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
 const before=JSON.stringify(prospect);
 const mounted=render(<CallingContext client={f.client} entry={{subject:{kind:'candidate',candidateId,expectedCandidateRevision:1},label:prospect.observedName,prospect}} onReady={vi.fn()}/>);
 expect(f.calls).toEqual([]);expect(screen.getByText('Phone conflicting · no number selected')).toBeTruthy();
 await click('Read phone result');
 const result=screen.getByLabelText('Current phone discovery result');
 expect(within(result).getByText('Phone conflicting · no number selected')).toBeTruthy();
 expect(within(result).getByText(/Phone evidence: multiple retained numbers/u)).toBeTruthy();
 expect(within(result).getByRole('link',{name:legacy.url})).toBeTruthy();
 expect(within(result).getByRole('link',{name:'https://company.example.test/contact'})).toBeTruthy();
 expect(screen.getAllByText('Phone conflicting · no number selected')).toHaveLength(2);
 expect(screen.queryByText(/observed, not call-ready/u)).toBeNull();
 expect(mounted.container.textContent).not.toMatch(/\+1214555012[34]/u);
 expect(mounted.container.querySelector('a[href^="tel:"]')).toBeNull();
 expect(screen.queryByRole('button',{name:/qualify|admit|dial|send/iu})).toBeNull();
 expect(f.calls).toEqual([{path:`${root}read`,body:{candidateId,expectedRevision:1}}]);
 expect(f.uuid).not.toHaveBeenCalled();expect(localStorage.getItem(QUALIFICATION_PENDING_KEY)).toBeNull();
 expect(JSON.stringify(prospect)).toBe(before);expect('value' in current.phoneEvidence).toBe(false);
});
