// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {priorityFixturePage} from './support/priorityFixture.ts';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,within,waitFor} from '@testing-library/react';
import {manualProspectSchema,type ManualProspect} from '@fss/contracts';
import {ManualProspectCard} from '../../src/client/ManualProspectCard.tsx';
import {BrowserManualProspects} from '../../src/client/BrowserManualProspects.tsx';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
const id='10000000-0000-4000-8000-000000000001',other='10000000-0000-4000-8000-000000000002';
const source={runId:id,observationId:other,blockId:'phone-0',url:'https://source.example.test/phone',retrievedAt:'2026-10-24T00:00:00.000Z'};
function prospect(patch:Partial<ManualProspect>={}):ManualProspect{return manualProspectSchema.parse({candidateId:id,revision:3,observedName:'Home | Boston Property Management - Contact',website:'javascript:alert(1)',locality:'Boston',region:'MA',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained source',url:'https://source.example.test/',observedAt:null}],sourceNotices:[{label:'Retained license',url:null}],retainedAt:source.retrievedAt,state:'new',unknowns:['Identity and fit unverified','Contact authority not granted'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted',presentation:{label:'Boston Property Management',basis:'retained_name',kind:'apparent_company',reason:'Suggested from retained name, not canonical identity.'},...patch});}
afterEach(cleanup);
it('is compact by default and expands original name, truthful label basis, safe sources, notices and exact feedback scope',()=>{
 const p=prospect();render(<ManualProspectCard prospect={p} disabled={false} feedback={vi.fn()}/>);
 expect(screen.getByRole('heading',{name:'Boston Property Management'})).toBeTruthy();
 const details=screen.getByText('Observed name, sources and details').closest('details')!;expect(details.open).toBe(false);
 fireEvent.click(screen.getByText('Observed name, sources and details'));expect(details.open).toBe(true);
 expect(screen.getByText(`Original observed name: ${p.observedName}`)).toBeTruthy();expect(screen.getByText(/Suggested label basis: retained name/u)).toBeTruthy();expect(screen.getByText('Retained license')).toBeTruthy();
 expect(screen.getByText(/Feedback applies only to this observation/u)).toBeTruthy();expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
});
it.each([
 [{state:'not_extracted',reason:'no_retained_phone_field'},'Phone unknown · not extracted'],
 [{state:'absent',basis:'retained_source_declares_absent'},'Phone absent · retained source explicitly declares absent'],
 [{state:'conflicting',reason:'multiple_retained_numbers',sources:[source]},'Phone conflicting · no number selected'],
 [{state:'observed',value:'+12145550123',sources:[source]},'Phone +12145550123 · observed, not call-ready'],
] as const)('renders honest phone state %j and exact provenance only when supported',(phoneEvidence,label)=>{
 const p=prospect({phoneEvidence:structuredClone(phoneEvidence) as ManualProspect['phoneEvidence'],...(phoneEvidence.state==='observed'?{observedPhone:phoneEvidence.value,phoneBasis:'retained_observation'}:{})});
 render(<ManualProspectCard prospect={p} disabled={false} feedback={vi.fn()}/>);expect(screen.getByText(label)).toBeTruthy();
 fireEvent.click(screen.getByText('Observed name, sources and details'));
 if(phoneEvidence.state==='observed'||phoneEvidence.state==='conflicting'){
  const provenance=screen.getByRole('list',{name:'Retained phone provenance'});expect(provenance.textContent).toContain(source.runId);expect(provenance.textContent).toContain(source.observationId);expect(provenance.textContent).toContain(source.blockId);expect(provenance.textContent).toContain(source.retrievedAt);
 }
});
it('supports a legacy DTO without presentation/evidence, never claiming an inferred observed number',()=>{
 const p=prospect();delete p.presentation;delete p.phoneEvidence;
 render(<ManualProspectCard prospect={p} disabled={false} feedback={vi.fn()}/>);expect(screen.getByRole('heading',{name:p.observedName})).toBeTruthy();expect(screen.getByText('Phone unknown · not extracted')).toBeTruthy();
});
it('same-site visible observations remain individual and batched feedback targets exactly the selected candidate and revision',async()=>{
 const first=prospect(),second=prospect({candidateId:other,revision:7,observedName:'Other retained original',presentation:{...first.presentation!,kind:'unresolved'}}),commands:unknown[]=[];
 const json=(value:unknown)=>new Response(JSON.stringify(value),{status:200});
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'queue-session',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 const storage=new Map<string,string>();
 const client=new BrowserClient({storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{storage.set(key,value);},removeItem:key=>{storage.delete(key);}},fetch:vi.fn(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  if(String(url).endsWith('/prospects/priority/list'))return json(priorityFixturePage({prospects:[first,second],hasMore:false}));
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;commands.push(body);return json({status:'accepted',replayed:false,result:{candidateId:other,revision:7,state:'kept'}});
 }),randomUUID:()=>crypto.randomUUID(),navigate:vi.fn()});
 await client.refresh();render(<BrowserManualProspects client={client}/>);
 await screen.findByRole('table');fireEvent.click(within(screen.getByRole('table')).getAllByRole('button')[1]!);
 const member=await screen.findByRole('article',{name:`Manual prospect ${other}`});await waitFor(()=>{expect(within(member).getByRole('button',{name:'Keep'}).hasAttribute('disabled')).toBe(false);});
 expect(screen.getAllByRole('article')).toHaveLength(1);expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(3);const button=within(member).getByRole('button',{name:'Keep'});act(()=>{fireEvent.click(button);fireEvent.click(button);});
 await waitFor(()=>{expect(commands).toHaveLength(1);});expect(commands[0]).toMatchObject({candidateId:other,expectedRevision:7,state:'kept'});
 await act(async()=>{client.dispose();});
});
