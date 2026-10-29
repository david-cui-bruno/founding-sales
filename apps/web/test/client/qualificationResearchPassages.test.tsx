// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {qualificationViewSchema} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserQualification} from '../../src/client/BrowserQualification.tsx';

const id='10000000-0000-4000-8000-000000000001',runId='10000000-0000-4000-8000-000000000002';
const companyName='Synthetic Residential Manager',website='https://research.example.test/';
const captured='2026-10-27T12:56:00.000Z';
const phone='Call us at: 401-555-0123',person=`Each week, ${companyName} owner Solana Reed hosts a local podcast.`;
const view=qualificationViewSchema.parse({candidateId:id,currentCandidateRevision:1,candidateRevision:1,runId,status:'review',reason:null,requestedAt:captured,deadlineAt:captured,
 facts:[{kind:'business_phone',observationId:runId,blockId:'p1',value:phone}],
 observations:[{id:runId,url:website,contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:captured,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,
 blocks:[{id:'p1',text:phone},{id:'r1',text:person},{id:'g1',text:`${companyName} manages residential properties in Providence, Rhode Island.`},{id:'l1',text:companyName},{id:'l2',text:'Pawtucket RI Office'},{id:'l3',text:'49 Example Street Pawtucket RI 02860'}]}],
 verdict:{decision:'review',rank:'fit_only',reasons:[],evidenceIds:[],unknowns:['business_phone_unresolved','maintenance_need_unconfirmed'],policyVersion:'qualification-v5'},
 openingQuestion:null,admission:null,history:[]});
function setup(){
 let answer:unknown=view,resolve:((response:Response)=>void)|undefined,waiting:Promise<Response>|undefined;
 const storage={getItem:vi.fn(()=>null),setItem:vi.fn(),removeItem:vi.fn()};
 const send=vi.fn<typeof fetch>(async url=>{
  if(url==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'research-context',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()});
  expect(url).toBe('/browser/api/sourcing/qualification/read');return waiting===undefined?Response.json(answer):await waiting;
 });
 const client=new BrowserClient({storage,fetch:send,navigate:vi.fn(),randomUUID:vi.fn(()=>crypto.randomUUID())});
 return {client,send,storage,answer:(next:unknown)=>{answer=next;},delay:()=>{waiting=new Promise<Response>(yes=>{resolve=yes;});},resolve:()=>{resolve?.(Response.json(answer));}};
}
const panel=(client:BrowserClient,name=companyName,site=website)=><BrowserQualification client={client} candidateId={id} expectedRevision={1} companyName={name} website={site}/>;
async function read(){fireEvent.click(screen.getByRole('button',{name:'Read qualification'}));await screen.findByText(/Latest run/u);await waitFor(()=>expect(screen.getByRole('button',{name:'Read qualification'}).hasAttribute('disabled')).toBe(false));}
afterEach(cleanup);

it('surfaces exact dated phone, named-owner and physical-office passages without upgrading frozen verdict or writing',async()=>{
 const s=setup();await s.client.refresh();render(panel(s.client));expect(screen.queryByText('Phone, people and office context')).toBeNull();
 await read();const requests=s.send.mock.calls.length;
 fireEvent.click(screen.getByText('Phone, people and office context'));
 const context=screen.getByText('Phone, people and office context').closest('details')!;
 expect(within(context).getAllByText(phone).length).toBeGreaterThan(0);
 expect(within(context).getAllByText(person).length).toBeGreaterThan(0);
 expect(within(context).getAllByText('Pawtucket RI Office').length).toBeGreaterThan(0);
 expect(within(context).getAllByText(/Original block /u).length).toBeGreaterThan(0);
 expect(context.textContent).toContain('Captured');expect(context.textContent).toContain(website);
 expect(screen.getByText('Unknown business_phone_unresolved')).toBeTruthy();expect(screen.getByText('Unknown maintenance_need_unconfirmed')).toBeTruthy();
 expect(screen.queryByRole('button',{name:'Admit reviewed qualification'})).toBeNull();
 expect(context.querySelector('a,button,input,img,iframe,script')).toBeNull();
 expect(s.send).toHaveBeenCalledTimes(requests);expect(s.storage.setItem).not.toHaveBeenCalled();s.client.dispose();
});

it.each(['unavailable','old_revision','pending','foreign_host','partial'] as const)('withholds research clues for %s material',async mode=>{
 const s=setup();s.answer(mode==='unavailable'?{...view,status:'unavailable',reason:'invalid_evidence'}:mode==='old_revision'?{...view,candidateRevision:2,currentCandidateRevision:1}:mode==='pending'?{...view,status:'pending'}:
  {...view,observations:view.observations.map(source=>mode==='foreign_host'?{...source,url:'https://foreign.example.test/'}:{...source,truncated:true})});
 await s.client.refresh();render(panel(s.client));await read();expect(screen.queryByText('Phone, people and office context')).toBeNull();s.client.dispose();
});

it('clears context on refresh, context replacement and logout, and never republishes a late old-name response',async()=>{
 const s=setup();await s.client.refresh();const mounted=render(panel(s.client));await read();expect(screen.getByText('Phone, people and office context')).toBeTruthy();
 s.delay();fireEvent.click(screen.getByRole('button',{name:'Read qualification'}));expect(screen.queryByText('Phone, people and office context')).toBeNull();
 mounted.rerender(panel(s.client,'Changed company'));await act(async()=>{s.resolve();});
 expect(screen.queryByText('Phone, people and office context')).toBeNull();
 await act(async()=>{s.client.invalidate();});expect(screen.queryByText(person)).toBeNull();expect(s.storage.setItem).not.toHaveBeenCalled();s.client.dispose();
});
