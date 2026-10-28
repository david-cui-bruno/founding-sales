// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {CallingRecordedFirms} from '../../src/client/CallingRecordedFirms.tsx';
import {CallingContext,type CallingContextData} from '../../src/client/CallingContext.tsx';
import {BrowserToday} from '../../src/client/BrowserToday.tsx';
import {CALLING_PREPARATION_PENDING_KEY} from '../../src/client/CallingPreparationCustody.ts';
const id='00000000-0000-4000-8000-000000000001',routeId='00000000-0000-4000-8000-000000000002';
const clients:BrowserClient[]=[];
afterEach(()=>{cleanup();clients.splice(0).forEach(c=>c.dispose());localStorage.clear();vi.restoreAllMocks();});
async function fixture(late=false){
 const expiresAt=new Date(Date.now()+400).toISOString();
 const firm={id,name:'Temporary source company',website:'https://temporary.example.test/',locality:'Providence',regionCode:'RI',status:'active',assignedUserId:id,stageKey:null,opportunityStatus:null,controlMode:null,openedAt:null,timeZone:'America/New_York',timeZoneUnresolvedReason:null,callingPreparationExpiresAt:expiresAt};
 const detail={...firm,addressLine:'Temporary office address',postalCode:'02901',countryCode:'US',timeZoneConfidence:'high',timeZoneSource:'recorded',contacts:[{id,fullName:'Independent contact',title:null,status:'active',isPrimary:true}],phoneRoutes:[{id:routeId,contactId:null,value:'+14015550123',eligibility:'candidate',version:1}],emailRoutes:[],aliases:[]};
 const page={version:3,visibility:'assigned_or_admin',read:{visibility:'assigned_or_admin',firm:detail},opportunities:[],holds:[],followUpPermissions:[]};
 let release!:()=>void,arrived!:()=>void;const arrival=new Promise<void>(yes=>{arrived=yes;}),resume=new Promise<void>(yes=>{release=yes;});
 const paths:string[]=[];const fetcher=vi.fn<typeof fetch>(async(url,init)=>{paths.push(String(url));
  if(url==='/browser/session')return Response.json({status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+60000).toISOString()});
  if(late){arrived();await resume;}
  if(url==='/browser/api/firms?include=callingPreparation')return Response.json({firms:[firm,{...firm,id:routeId,name:'Independent company',callingPreparationExpiresAt:undefined}]});
  if(url==='/browser/api/crm/firm-page-v3'){expect(JSON.parse(String(init?.body)).include).toContain('callingPreparation');return Response.json(page);}
  if(url==='/browser/api/today?include=tasks&include=meeting_tasks&include=callingPreparation')return Response.json({workspaceId:id,snapshotDate:'2026-10-28',businessTimeZone:'America/New_York',cards:[{firmId:id,firmName:firm.name,callingPreparationExpiresAt:expiresAt,lane:'new_firm',dueAt:'2026-10-28T00:00:00Z',counts:{replies:0,emailsDue:0,callsDue:0}}]});
  throw Error('No write/provider/acquisition route exists in this fixture');
 });
 const client=new BrowserClient({fetch:fetcher,storage:localStorage,navigate:vi.fn(),randomUUID:()=>id});clients.push(client);await client.refresh();return {client,paths,arrival,release,expiresAt};
}
it('Recorded companies purges only known source-owned identity at the negotiated deadline without hiding an independent company',async()=>{
 const f=await fixture();render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={vi.fn()}/>);await screen.findByText('Temporary source company');
 await screen.findByText('[source unavailable company]');expect(screen.queryByText('Temporary source company')).toBeNull();expect(screen.getByText('Independent company')).toBeTruthy();expect(f.paths.filter(p=>p!=='/browser/session')).toEqual(['/browser/api/firms?include=callingPreparation']);
});
it('mounted canonical Calling context clears copied profile/site/phone at deadline while preserving independent contact/history and original UNKNOWN custody',async()=>{
 const f=await fixture(),views:CallingContextData[]=[];localStorage.setItem(CALLING_PREPARATION_PENDING_KEY,'original opaque UNKNOWN fixture');
 render(<CallingContext client={f.client} entry={{subject:{kind:'firm',firmId:id},label:'Selected company'}} onReady={value=>{if(value)views.push(value);}}/>);
 await screen.findByText('Temporary source company');await screen.findByText(/\+14015550123/u);await screen.findByText('[source unavailable company]');
 expect(screen.queryByText(/\+14015550123/u)).toBeNull();expect(screen.queryByRole('link',{name:/website/u})).toBeNull();expect(screen.getByText('Independent contact')).toBeTruthy();expect(localStorage.getItem(CALLING_PREPARATION_PENDING_KEY)).toBe('original opaque UNKNOWN fixture');
 await waitFor(()=>expect(views.at(-1)?.firm?.read.firm).toMatchObject({name:'[source unavailable company]',website:null,locality:null,regionCode:null,timeZone:null,phoneRoutes:[],contacts:[{fullName:'Independent contact'}]}));
});
it('mounted Today card drops the source-owned name at its negotiated deadline without a command or source sweep',async()=>{
 const f=await fixture();render(<BrowserToday client={f.client}/>);await screen.findByText('Temporary source company');await screen.findByText('[source unavailable company]');expect(f.paths.filter(p=>p!=='/browser/session')).toEqual(['/browser/api/today?include=tasks&include=meeting_tasks&include=callingPreparation']);
});

it.each(['recorded','today','calling'] as const)('%s sanitizes a source-leased response that arrives after its deadline before any render',async surface=>{
 const f=await fixture(true),observed:string[]=[];const observer=new MutationObserver(()=>{observed.push(document.body.textContent??'');});observer.observe(document.body,{childList:true,subtree:true,characterData:true});
 try{
  if(surface==='recorded')render(<CallingRecordedFirms client={f.client} disabled={false} onSelect={vi.fn()}/>);
  else if(surface==='today')render(<BrowserToday client={f.client}/>);
  else render(<CallingContext client={f.client} entry={{subject:{kind:'firm',firmId:id},label:'Selected company'}} onReady={vi.fn()}/>);
  await f.arrival;vi.spyOn(Date,'now').mockReturnValue(Date.parse(f.expiresAt)+1);await act(async()=>{f.release();});
  await screen.findByText('[source unavailable company]');
  expect(observed.some(text=>text.includes('Temporary source company')||text.includes('+14015550123')||text.includes('Temporary office address'))).toBe(false);
  if(surface==='calling')expect(screen.getByText('Independent contact')).toBeTruthy();
 }finally{observer.disconnect();}
});
