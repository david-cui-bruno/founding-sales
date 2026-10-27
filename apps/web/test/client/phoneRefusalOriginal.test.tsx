// @vitest-environment jsdom
import {webcrypto} from 'node:crypto';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {prospectPhoneDiscoveryViewSchema,type ProspectPhoneDiscoveryView} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserPhoneDiscovery} from '../../src/client/BrowserPhoneDiscovery.tsx';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002',text='PHONE: <script>literal only</script> Ask the office. WHOLE TAIL';
const read='/sourcing/candidates/phone-discovery/read',original='/sourcing/candidates/phone-discovery/refusal-original/read';
const clients:BrowserClient[]=[];
function fixture():ProspectPhoneDiscoveryView{
 const now=new Date().toISOString(),expiresAt=new Date(Date.now()+2000).toISOString();
 return prospectPhoneDiscoveryViewSchema.parse({candidateId:id,candidateRevision:1,runId:other,state:'complete',reason:null,requestedAt:now,checkedAt:now,expiresAt,method:'company-public-phone-v1',website:'https://fixture.example.test/',channelAuthority:'not_granted',phoneEvidence:{state:'conflicting',reason:'unresolved_retained_literal',sources:[],diagnostics:{entries:[{runId:other,observationId:id,blockId:'whole',url:'https://fixture.example.test/contact',retrievedAt:now,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',label:'PHONE',labelStart:0,labelEnd:5,reason:'unattached_label_content',authority:{kind:'phone_discovery',runId:other,expiresAt},lineage:{kind:'provider_original'}}],truncated:false}}});
}
async function setup(){
 const view=fixture(),calls:{path:string;body:unknown}[]=[];let gate:Promise<Response>|null=null,mutate:(value:Record<string,unknown>)=>unknown=v=>v;
 const fetcher=vi.fn<typeof fetch>(async(url,init)=>{
  if(String(url)==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'x'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  const path=String(url).replace('/browser/api','');calls.push({path,body:JSON.parse(String(init?.body)) as unknown});
  if(path===read)return Response.json(view);
  if(path===original)return gate??Response.json(mutate({candidateId:id,candidateRevision:1,location:view.phoneEvidence.state==='conflicting'?view.phoneEvidence.diagnostics!.entries[0]:null,text,purpose:'manual_refusal_review',channelAuthority:'not_granted'}));
  throw Error('Forbidden IO');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>other});clients.push(client);await client.refresh();
 const mounted=render(<BrowserPhoneDiscovery client={client} candidateId={id} revision={1}/>);
 return {client,view,calls,fetcher,mounted,hold:(next:Promise<Response>)=>{gate=next;},mutate:(next:typeof mutate)=>{mutate=next;}};
}
async function click(name:string){await act(async()=>{fireEvent.click(screen.getByRole('button',{name}));});if(name==='Read phone result'){const summary=screen.queryByText('Phone-specific sources and coverage');if(summary&&!summary.parentElement?.hasAttribute('open'))fireEvent.click(summary);}}
beforeEach(()=>{vi.stubGlobal('crypto',webcrypto);});
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();sessionStorage.clear();vi.useRealTimers();vi.unstubAllGlobals();});
it('mount and explicit result read do not fetch originals; a selected refusal reads one exact whole plain text block in memory only',async()=>{
 const f=await setup();expect(f.calls).toEqual([]);await click('Read phone result');expect(f.calls.map(c=>c.path)).toEqual([read]);
 await click('Read this retained refusal original');
 expect(f.calls[1]).toEqual({path:original,body:{candidateId:id,expectedRevision:1,runId:other,observationId:id,blockId:'whole',labelStart:0,labelEnd:5,reason:'unattached_label_content'}});
 const block=screen.getByLabelText('Selected retained refusal original');expect(block.textContent).toContain(text);expect(block.querySelector('script')).toBeNull();expect(block.querySelector('a')).toBeNull();
 expect(JSON.stringify({...localStorage})).not.toContain(text);expect(JSON.stringify({...sessionStorage})).not.toContain(text);expect(screen.queryByRole('button',{name:/dial|send|promote/iu})).toBeNull();
 await click('Read phone result');expect(screen.queryByLabelText('Selected retained refusal original')).toBeNull();expect(f.calls.map(c=>c.path)).toEqual([read,original,read]);
});
it.each(['candidate','revision','session','unknown','reread','unmount'] as const)('late original cannot cross %s binding',async change=>{
 const f=await setup();await click('Read phone result');let resolve:(value:Response)=>void=()=>{throw Error('gate');};f.hold(new Promise(done=>{resolve=done;}));
 fireEvent.click(screen.getByRole('button',{name:'Read this retained refusal original'}));await waitFor(()=>expect(f.calls).toHaveLength(2));
 if(change==='candidate'||change==='revision')f.mounted.rerender(<BrowserPhoneDiscovery client={f.client} candidateId={change==='candidate'?other:id} revision={change==='revision'?2:1}/>);
 if(change==='session')act(()=>f.client.invalidate());
 if(change==='unknown')act(()=>{f.client.qualification.prepare({kind:'phone_discovery',candidateId:other,expectedRevision:1});});
 if(change==='reread')await click('Read phone result');
 if(change==='unmount')f.mounted.unmount();
 const location=f.view.phoneEvidence.state==='conflicting'?f.view.phoneEvidence.diagnostics!.entries[0]:null;
 await act(async()=>{resolve(Response.json({candidateId:id,candidateRevision:1,location,text,purpose:'manual_refusal_review',channelAuthority:'not_granted'}));});
 expect(screen.queryByLabelText('Selected retained refusal original')).toBeNull();expect(document.body.textContent).not.toContain(text);
});
it.each(['candidate','revision','location','label','authority','text'] as const)('rejects mismatched selected response %s',async change=>{
 const f=await setup();await click('Read phone result');f.mutate(value=>{
  if(change==='candidate')return {...value,candidateId:other};if(change==='revision')return {...value,candidateRevision:2};
  if(change==='text')return {...value,text:'wrong label'};
  const location={...(value['location'] as Record<string,unknown>)};
  if(change==='location')location['blockId']='foreign';if(change==='label')location['label']='phone';if(change==='authority')location['authority']={kind:'candidate_source',sourceUrl:'https://fixture.example.test/'};
  return {...value,location};
 });await click('Read this retained refusal original');expect(screen.queryByLabelText('Selected retained refusal original')).toBeNull();expect(document.body.textContent).not.toContain(text);
});
it('expiry erases the whole original with no background read, retry or renewal',async()=>{
 vi.useFakeTimers();const f=await setup();await click('Read phone result');await click('Read this retained refusal original');expect(screen.getByLabelText('Selected retained refusal original').textContent).toContain(text);
 await act(async()=>{await vi.advanceTimersByTimeAsync(2001);});expect(document.body.textContent).not.toContain(text);expect(f.calls.map(c=>c.path)).toEqual([read,original]);
});
it('source denial on a new explicit read erases the previous original and all text',async()=>{
 const f=await setup();await click('Read phone result');await click('Read this retained refusal original');f.hold(Promise.resolve(Response.json({error:'source_changed'},{status:409})));
 await click('Read this retained refusal original');expect(document.body.textContent).not.toContain(text);expect(screen.queryByLabelText('Selected retained refusal original')).toBeNull();expect(f.calls).toHaveLength(3);
});
