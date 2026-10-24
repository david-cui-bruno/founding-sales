// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {qualificationViewSchema} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserRetainedRecovery} from '../../src/client/BrowserRetainedRecovery.tsx';
import {BrowserQualificationRecovery} from '../../src/client/BrowserQualificationRecovery.tsx';
import {QUALIFICATION_PENDING_KEY} from '../../src/client/QualificationPending.ts';
const id='10000000-0000-4000-8000-000000000001',runId='10000000-0000-4000-8000-000000000002',decisionId='10000000-0000-4000-8000-000000000003';
const date='2026-10-23T12:00:00.000Z';
const view=qualificationViewSchema.parse({candidateId:id,runId,candidateRevision:1,currentCandidateRevision:1,status:'unavailable',reason:'invalid_evidence',admissionReason:null,requestedAt:date,deadlineAt:date,observations:[{id:runId,url:'https://retained.example.test/',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),retrievedAt:date,publishedAt:null,publishedAtBlockId:null,firstParty:true,truncated:false,blocks:[{id:'identity',text:'Copyright Retained Harbor PM'},{id:'unsafe',text:'<img src="https://never-fetch.test/">'}]}],facts:[],verdict:null,openingQuestion:null,admission:null,history:[]});
const json=(body:unknown)=>new Response(JSON.stringify(body));
function setup(){
 const data=new Map<string,string>(),storage={getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};
 const commands:{path:string;body:unknown}[]=[],randomUUID=vi.fn(()=>crypto.randomUUID());let lose=false,answer:unknown=view;
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  if(url==='/browser/session')return json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()});
  if(url==='/browser/api/sourcing/qualification/read')return json(answer);
  expect(storage.getItem(QUALIFICATION_PENDING_KEY)).not.toBeNull();commands.push({path:String(url),body:JSON.parse(String(init?.body))});if(lose)throw Error('Response lost');
  return json({status:'accepted',replayed:commands.length>1,result:String(url).endsWith('/identity')?{decisionId,candidateId:id,revision:2,qualificationRunId:runId}:{runId:decisionId,candidateId:id,candidateRevision:2,decisionId}});
 });
 const make=()=>new BrowserClient({storage,fetch:send,randomUUID,navigate:vi.fn()});return {client:make(),make,storage,commands,randomUUID,lose:(value:boolean)=>{lose=value;},answer:(value:unknown)=>{answer=value;}};
}
afterEach(cleanup);
function choose(){fireEvent.change(screen.getByLabelText('Recovery observation'),{target:{value:runId}});fireEvent.change(screen.getByLabelText('Recovery block'),{target:{value:'identity'}});fireEvent.change(screen.getByLabelText('Literal retained trade-name'),{target:{value:'Retained Harbor PM'}});fireEvent.click(screen.getByRole('checkbox'));}
it('keeps unresolved private text memory-only and renders captured markup escaped',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserRetainedRecovery client={s.client} view={view} revision={1} blocked={false} onSaved={vi.fn()}/>);choose();
 fireEvent.change(screen.getByLabelText('Recovery block'),{target:{value:'unsafe'}});expect(screen.getByLabelText('Selected recovery original').textContent).toContain('<img');expect(document.querySelector('img')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Keep unresolved'}));expect(s.commands).toHaveLength(0);expect(s.randomUUID).not.toHaveBeenCalled();expect(s.storage.getItem(QUALIFICATION_PENDING_KEY)).toBeNull();await act(async()=>s.client.dispose());
});
it('rejects changed originals before minting identity custody',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserRetainedRecovery client={s.client} view={view} revision={1} blocked={false} onSaved={vi.fn()}/>);choose();s.answer({...view,runId:decisionId});fireEvent.click(screen.getByRole('button',{name:'Record identity-only decision'}));await screen.findByText(/Recovery unavailable/u);expect(s.commands).toHaveLength(0);expect(s.randomUUID).not.toHaveBeenCalled();await act(async()=>s.client.dispose());
});
it.each(['identity','interpret'] as const)('retains lost %s command IDs/hashes only and reconciles exact command after reload',async kind=>{
 const s=setup(),current=kind==='identity'?view:{...view,currentCandidateRevision:2,recovery:{decisionId,originalRunId:runId,identityRevision:2,interpretationRunId:null,acquisitionMode:'retained_only' as const,methodVersion:'human-retained-v1' as const}};
 s.answer(current);s.lose(true);await s.client.refresh();const first=render(<BrowserRetainedRecovery client={s.client} view={current} revision={kind==='identity'?1:2} blocked={false} onSaved={vi.fn()}/>);
 if(kind==='identity')choose();else{fireEvent.change(screen.getByLabelText('Recovery observation'),{target:{value:runId}});fireEvent.change(screen.getByLabelText('Recovery block'),{target:{value:'identity'}});fireEvent.click(screen.getByRole('button',{name:'Add retained citation'}));fireEvent.click(screen.getByRole('checkbox'));}
 fireEvent.click(screen.getByRole('button',{name:kind==='identity'?'Record identity-only decision':'Interpret retained citations'}));await screen.findByText(/Recovery unavailable/u);expect(s.commands).toHaveLength(1);
 const held=s.storage.getItem(QUALIFICATION_PENDING_KEY)!;expect(held).not.toMatch(/Retained Harbor|Copyright|https|never-fetch|csrf/u);first.unmount();s.lose(false);const reload=s.make();await reload.refresh();render(<BrowserQualificationRecovery client={reload}/>);
 expect(s.commands).toHaveLength(1);fireEvent.click(screen.getByRole('button',{name:'Reconcile exact qualification command'}));await waitFor(()=>expect(s.commands).toHaveLength(2));expect(s.commands[1]).toEqual(s.commands[0]);await screen.findByText(/Confirmed qualification/u);expect(s.randomUUID).toHaveBeenCalledTimes(1);await act(async()=>{s.client.dispose();reload.dispose();});
});
