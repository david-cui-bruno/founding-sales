// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {useState} from 'react';
import {afterEach,expect,it,vi,type Mock} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {manualProspectSchema,preparedProspectBriefSchema,preparedProspectSummarySchema,type PreparedProspectCallable,type PreparedProspectSummary} from '@fss/contracts';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {usePreparedProspects} from '../../src/client/PreparedProspects.tsx';
import {BrowserProspectsWorkspace} from '../../src/client/BrowserProspectsWorkspace.tsx';
import {WorkspaceNavigationGuard,useUnsavedWorkspaceText} from '../../src/client/WorkspaceNavigationGuard.tsx';
import {workspaceChoiceDisabled} from './support/workspaceChoice.ts';
import type {CallingSelection} from '../../src/client/workspaceNavigation.ts';
const at='2026-10-30T12:00:00.000Z',id='10000000-0000-4000-8000-000000000001',run='10000000-0000-4000-8000-000000000002';
const revision='a'.repeat(64),expiry='2026-10-31T12:00:00.000Z';
const notCallable:PreparedProspectCallable={state:'not_callable',missing:['no_published_phone'],phone:null,person:null,residential:true,businessContext:true,software:false};
const row=(index=1,callable:PreparedProspectCallable=notCallable):PreparedProspectSummary=>preparedProspectSummarySchema.parse({target:{candidateId:`10000000-0000-4000-8000-${String(index).padStart(12,'0')}`,candidateRevision:2,runId:run},displayName:`Harbor Residential ${index}`,discoveryLabel:`Home | HRM ${index}`,website:'https://harbor.example.test/',targetingLocality:'Boston',targetingRegion:'MA',state:'prepared',summary:'Retained first-party residential management and maintenance workflow context.',unknowns:['Business email is unknown','Buying intent is unknown'],validUntil:expiry,callable,companyHost:'harbor.example.test'});
// V1 briefs predate callable assessment; rolling clients still read them.
const legacy=({callable:_callable,companyHost:_companyHost,...summary}:PreparedProspectSummary)=>summary;
const brief=preparedProspectBriefSchema.parse({...legacy(row()),policyVersion:'prepared-prospect-v1',checkedAt:at,coverage:'complete_retained_pages',nextAction:'Research who owns maintenance intake and vendor coordination.',contactAuthority:'not_granted',passages:[
 {kind:'business',observationId:id,blockId:'business',url:'https://harbor.example.test/about',retrievedAt:at,quote:'Harbor Residential manages residential homes and apartments.'},
 {kind:'workflow',observationId:id,blockId:'workflow',url:'https://harbor.example.test/services',retrievedAt:at,quote:'The account manager coordinates tenant intake and outside vendors.'},
 {kind:'person',observationId:id,blockId:'person',url:'https://harbor.example.test/team',retrievedAt:at,quote:'Morgan Lane is listed as the owner.'},
 {kind:'location',observationId:id,blockId:'location',url:'https://harbor.example.test/contact',retrievedAt:at,quote:'Office: Cambridge, MA. Serving the Greater Boston area.'},
 {kind:'contact',observationId:id,blockId:'contact',url:'https://harbor.example.test/contact',retrievedAt:at,quote:'Please use the general office line for business questions.'},
]});
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
const open=(summary:PreparedProspectSummary=row())=>'Open company brief for '+summary.displayName;
const retained=manualProspectSchema.parse({candidateId:row().target.candidateId,revision:row().target.candidateRevision,observedName:'Harbor retained observation',website:null,locality:'Boston',region:'MA',observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained source',url:'https://harbor.example.test/',observedAt:at}],sourceNotices:[],retainedAt:at,state:'new',unknowns:['Identity unverified'],possibleDuplicateCount:0,qualification:'unverified',contactAuthority:'not_granted'});
/** A real consumer of the hook, as BrowserProspectsWorkspace is. An isolated reader that never advances has no selection. */
function Research({client,onOpenCalling,selection=null}:{client:BrowserClient;onOpenCalling?:(selection:CallingSelection)=>void;selection?:CallingSelection|null}){
 const research=usePreparedProspects({client,selection,...(onOpenCalling?{onOpenCalling}:{})});
 return <><aside aria-label="Company research list">{research.list}</aside>{research.detail}<button type="button" onClick={research.back}>Back to companies</button></>;
}
function UnsavedText(){useUnsavedWorkspaceText(true);return null;}
function setup(){
 const values=new Map<string,string>(),requests:Array<{url:string;body:unknown}>=[];
 const storage={getItem:(key:string)=>values.get(key)??null,setItem:vi.fn((key:string,value:string)=>{values.set(key,value);}),removeItem:(key:string)=>{values.delete(key);}};
 const session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'one',csrfToken:'c'.repeat(40),expiresAt:'2026-11-01T12:00:00.000Z'};
 let pageRows=[row()],laterRows:PreparedProspectSummary[]|null=null,hasMore=false,listFailure:unknown|null=null,readResult:unknown=brief,readDelay:PromiseWithResolvers<Response>|undefined;
 const send=vi.fn<typeof fetch>(async(url,init)=>{
  if(url==='/browser/session')return json(session);
  const body:unknown=init?.body===undefined?undefined:JSON.parse(String(init.body));requests.push({url:String(url),body});
  if(url==='/browser/api/sourcing/prepared-prospects/list'){
   if(listFailure)return json(listFailure);
   const offset=(body as {offset?:number}|undefined)?.offset??0;
   if(offset>0&&laterRows)return json({prospects:laterRows,hasMore:false,viewRevision:revision,checkedAt:at});
   return json({prospects:pageRows,hasMore,viewRevision:revision,checkedAt:at});
  }
  // The exact read answers the exact target it was asked for.
  if(url==='/browser/api/sourcing/prepared-prospects/read')return readDelay?readDelay.promise:json(readResult===brief?{...brief,target:body}:readResult);
  if(url==='/browser/api/sourcing/candidates/prospects/list'){const asked=body as {candidateId?:string;expectedRevision?:number}|undefined;return json({prospects:[asked?.candidateId?{...retained,candidateId:asked.candidateId,revision:asked.expectedRevision??retained.revision}:retained],hasMore:false});}
  if(url==='/browser/api/today/actions/v4?include=callingPreparation')return json({version:4,workspaceId:id,businessTimeZone:'America/Chicago',asOf:at,actions:[],promiseCoverage:{scope:'current_authorized_work',truncated:false,nextAfterId:null}});
  throw Error('Unexpected route '+String(url));
 });
 const randomUUID=vi.fn(()=>crypto.randomUUID());
 const client=new BrowserClient({fetch:send,storage,navigate:vi.fn(),randomUUID});
 return {client,session,storage,randomUUID,requests,rows:(next:PreparedProspectSummary[],more=false)=>{pageRows=next;hasMore=more;},later:(next:PreparedProspectSummary[])=>{laterRows=next;},failList:(value:unknown)=>{listFailure=value;},read:(value:unknown)=>{readResult=value;},delayRead:()=>{readDelay=Promise.withResolvers<Response>();return readDelay;}};
}
async function mounted(workspace=false){vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();render(workspace?<BrowserProspectsWorkspace client={f.client}/>:<Research client={f.client}/>);return f;}
afterEach(()=>{cleanup();Reflect.deleteProperty(HTMLDialogElement.prototype,'showModal');Reflect.deleteProperty(HTMLDialogElement.prototype,'close');vi.restoreAllMocks();vi.useRealTimers();});
// jsdom has no modal dialog; this supplies only the open/close state the platform would.
function dialogs(){
 const showModal=vi.fn(function(this:HTMLDialogElement){this.setAttribute('open','');}),close=vi.fn(function(this:HTMLDialogElement){this.removeAttribute('open');});
 Object.defineProperty(HTMLDialogElement.prototype,'showModal',{configurable:true,value:showModal});Object.defineProperty(HTMLDialogElement.prototype,'close',{configurable:true,value:close});
 return {showModal,close};
}
const rowNames=()=>screen.getAllByRole('button',{name:/Open company brief for/iu}).map(button=>button.getAttribute('aria-label'));

it('opens a useful company brief without email or canonical publication, using only the exact read endpoints',async()=>{
 const f=await mounted();fireEvent.click(await screen.findByRole('button',{name:open()}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 await waitFor(()=>expect(within(detail).getByRole('heading',{name:brief.displayName})).toBe(document.activeElement));
 for(const passage of brief.passages)expect(within(detail).getByText(passage.quote)).toBeTruthy();
 expect(within(detail).getByText('Business email is unknown')).toBeTruthy();
 const hints=within(detail).getByRole('region',{name:'Discovery hints'});
 expect(within(hints).getByText(/Home \| HRM 1/u)).toBeTruthy();expect(within(hints).getByText(/Boston, MA/u)).toBeTruthy();expect(within(hints).getByText(/discovery hints.*do not confirm/iu)).toBeTruthy();
 expect(within(detail).getAllByRole('link').every(link=>link.getAttribute('referrerpolicy')==='no-referrer')).toBe(true);
 expect(within(detail).queryByRole('button',{name:/call|email|create firm|keep|send/iu})).toBeNull();expect(screen.queryByRole('button',{name:/Open in Calling/iu})).toBeNull();
 expect(screen.getByRole('button',{name:open()})).toBeTruthy();
 expect(f.requests).toEqual([{url:listUrl,body:{offset:0}},{url:'/browser/api/sourcing/prepared-prospects/read',body:row().target}]);
 expect(f.randomUUID).not.toHaveBeenCalled();expect(f.storage.setItem).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Back to companies'}));
 expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();expect(screen.getByRole('heading',{name:'Prepared companies'})).toBe(document.activeElement);
 expect(f.requests).toHaveLength(2);f.client.dispose();
});

it('keeps technical source diagnostics in a modal dialog that opens and closes on request',async()=>{
 const {showModal,close}=dialogs();const f=await mounted();fireEvent.click(await screen.findByRole('button',{name:open()}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(detail.textContent).not.toMatch(/observation [0-9a-f-]{36}/u);expect(screen.queryByRole('dialog')).toBeNull();expect(showModal).not.toHaveBeenCalled();
 fireEvent.click(within(detail).getByRole('button',{name:'Source diagnostics'}));
 const dialog=screen.getByRole('dialog',{name:'Source diagnostics'});expect(showModal).toHaveBeenCalledTimes(1);
 for(const exact of [brief.target.candidateId,run,...brief.passages.map(passage=>passage.url)])expect(dialog.textContent).toContain(exact);
 expect(dialog.textContent).toContain(`observation ${id}, block ${brief.passages[0]!.blockId}`);
 fireEvent.click(within(dialog).getByRole('button',{name:'Close'}));expect(screen.queryByRole('dialog')).toBeNull();expect(close).toHaveBeenCalled();
 fireEvent.click(within(detail).getByRole('button',{name:'Source diagnostics'}));
 expect(fireEvent(screen.getByRole('dialog',{name:'Source diagnostics'}),new Event('cancel',{cancelable:true}))).toBe(false);expect(screen.queryByRole('dialog')).toBeNull();
 expect(f.requests).toHaveLength(2);f.client.dispose();
});

it('paginates bounded fifty-row pages with the view revision and keeps needs-research distinct',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const first=Array.from({length:50},(_,index)=>row(index+1));f.rows(first,true);
 fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));await screen.findByRole('button',{name:open(row(50))});
 expect(rowNames()).toHaveLength(50);
 const next={...row(51),state:'needs_research' as const,summary:'No usable retained pages support identity and fit.',validUntil:null};f.rows([next]);
 fireEvent.click(screen.getByRole('button',{name:'Next companies'}));await screen.findByRole('button',{name:open(next)});
 expect(screen.queryByRole('button',{name:open()})).toBeNull();expect(screen.getByRole('button',{name:open(next)}).textContent).toContain('Needs research');
 expect(screen.getByText('0 prepared · 1 need research on this page. This is research supply, not a contact-ready count.')).toBeTruthy();
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:50,viewRevision:revision}});
 f.rows(first,true);fireEvent.click(screen.getByRole('button',{name:'Previous companies'}));await screen.findByRole('button',{name:open()});
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:0,viewRevision:revision}});f.client.dispose();
});

it('clears a changed list and offers a first-page refresh without invalidating the signed-in session',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 f.failList({error:'view_changed'});fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByText('The company list changed. Refresh companies to start from the first page.');
 expect(screen.queryByRole('button',{name:open()})).toBeNull();expect(f.client.current?.status).toBe('signed_in');expect(screen.getByRole('button',{name:'Refresh companies'})).toBeTruthy();f.client.dispose();
});

it.each(['candidate_changed','source_changed','source_expired'] as const)('clears stale company context on a %s product refusal while retaining sign-in',async error=>{
 const f=await mounted();fireEvent.click(await screen.findByRole('button',{name:open()}));
 f.read({error});
 await waitFor(()=>expect(screen.getByRole('button',{name:'Refresh companies'}).hasAttribute('disabled')).toBe(false));
 expect(screen.queryByRole('button',{name:open()})).toBeNull();expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(f.client.current?.status).toBe('signed_in');f.client.dispose();
});

it('ignores a late exact-detail response after Back to companies',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});const held=f.delayRead();
 fireEvent.click(screen.getByRole('button',{name:open()}));await screen.findByText('Opening company brief…');
 await waitFor(()=>expect(f.requests).toHaveLength(2));fireEvent.click(screen.getByRole('button',{name:'Back to companies'}));
 await act(async()=>{held.resolve(json(brief));});
 expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();expect(screen.getByRole('button',{name:open()})).toBeTruthy();f.client.dispose();
});

it('clears private context on identity invalidation and rejects a late read response',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});const held=f.delayRead();
 fireEvent.click(screen.getByRole('button',{name:open()}));await waitFor(()=>expect(f.requests).toHaveLength(2));
 await act(async()=>{f.client.invalidate();held.resolve(json(brief));});
 expect(screen.queryByText(brief.displayName)).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.getByText('Prepared company research requires current administrator access.')).toBeTruthy();f.client.dispose();
});

it('refuses an exact-detail response for another revision instead of showing its passages',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});f.read({...brief,target:{...brief.target,candidateRevision:3}});
 fireEvent.click(screen.getByRole('button',{name:open()}));await screen.findByText('The selected company changed. Refresh companies to read current research.');
 expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();expect(screen.queryByRole('button',{name:open()})).toBeNull();f.client.dispose();
});

it('expires both an opened brief and its list without polling or re-fetching',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(at));const f=setup();f.rows([row(),{...row(2),discoveryLabel:row().discoveryLabel,validUntil:'2026-10-30T12:00:01.000Z'}]);f.read(brief);
 await f.client.refresh();render(<Research client={f.client}/>);
 await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 fireEvent.click(screen.getByRole('button',{name:open()}));await act(async()=>{await vi.advanceTimersByTimeAsync(0);});
 expect(screen.getByText(brief.passages[0]!.quote)).toBeTruthy();const calls=f.requests.length;
 await act(async()=>{await vi.advanceTimersByTimeAsync(1001);});
 expect(screen.queryByText(brief.displayName)).toBeNull();expect(screen.queryByText(row(2).displayName)).toBeNull();expect(screen.queryByText(brief.passages[0]!.quote)).toBeNull();expect(screen.getByText('Research evidence expired. Refresh companies to read current sources.')).toBeTruthy();expect(f.requests).toHaveLength(calls);f.client.dispose();
});

it('refuses to open another company while unsaved text is held, until the user agrees to discard it',async()=>{
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();const onOpenCalling=vi.fn();
 render(<WorkspaceNavigationGuard><UnsavedText/><Research client={f.client} onOpenCalling={onOpenCalling}/></WorkspaceNavigationGuard>);
 fireEvent.click(await screen.findByRole('button',{name:open()}));
 expect(confirm).toHaveBeenCalledTimes(1);
 expect(onOpenCalling).not.toHaveBeenCalled();expect(f.requests).toEqual([{url:listUrl,body:{offset:0}}]);expect(screen.queryByText('Opening company brief…')).toBeNull();
 confirm.mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:open()}));
 await screen.findByRole('article',{name:'Prepared company brief'});expect(onOpenCalling).toHaveBeenCalledTimes(1);expect(f.requests).toHaveLength(2);f.client.dispose();
});

it('starts administrators on prepared research while keeping qualified publication requests accessible',async()=>{
 const f=await mounted(true);await screen.findByRole('button',{name:open()});
 expect(screen.getByRole('button',{name:'Prepared research'}).getAttribute('aria-pressed')).toBe('true');
 expect(f.requests.map(request=>request.url)).toEqual([listUrl]);
 fireEvent.click(screen.getByRole('button',{name:'Qualified publications'}));await screen.findByRole('button',{name:'Refresh action queue'});
 expect(screen.getByRole('button',{name:'Qualified publications'}).getAttribute('aria-pressed')).toBe('true');
 await waitFor(()=>expect(f.requests.map(request=>request.url)).toContain('/browser/api/today/actions/v4?include=callingPreparation'));
 expect(screen.getByText('Qualified selection and existing research requests')).toBeTruthy();f.client.dispose();
});
it('preserves inherited source notices in both the page and selected brief without making unsafe links',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const sourceNotices=[{label:'Fictional retained attribution',url:'https://source.example.test/license'},{label:'Literal source notice',url:'javascript:alert(1)'}];
 f.rows([{...row(),sourceNotices}]);fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByText(sourceNotices[0]!.label);expect(screen.getByText(sourceNotices[1]!.label).closest('a')).toBeNull();
 f.read({...brief,sourceNotices});fireEvent.click(screen.getByRole('button',{name:open()}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 const notices=within(detail).getByRole('region',{name:'Source notices'});expect(notices.closest('details')).toBeNull();
 expect(within(notices).getByRole('link',{name:sourceNotices[0]!.label}).getAttribute('href')).toBe(sourceNotices[0]!.url);
 expect(within(notices).getByText(sourceNotices[1]!.label).closest('a')).toBeNull();f.client.dispose();
});

it('shows partial retained blocks with their coverage and leaves missing fields unknown',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 f.read({...brief,policyVersion:'prepared-prospect-v2',coverage:'partial_retained_pages',callable:notCallable,companyHost:'harbor.example.test',
  unknowns:['Some source content was omitted; buyer and residential fit remain unknown.'],
  passages:brief.passages.map(p=>({...p,sourceCoverage:'partial_page'}))});
 fireEvent.click(screen.getByRole('button',{name:open()}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(within(detail).getAllByText('Partial page').length).toBe(brief.passages.length);
 expect(within(detail).getByText(/source coverage is incomplete/iu)).toBeTruthy();
 expect(within(detail).getByText(/buyer and residential fit remain unknown/iu)).toBeTruthy();
 expect(within(detail).queryByText(/Supported by the complete retained pages/iu)).toBeNull();
 expect(f.requests.map(r=>r.url)).toEqual([listUrl,'/browser/api/sourcing/prepared-prospects/read']);
 f.client.dispose();
});

it('refuses partial V2 passages whose response claims complete coverage or omits provenance',()=>{
 const partial={...brief,policyVersion:'prepared-prospect-v2',coverage:'partial_retained_pages',callable:notCallable,companyHost:'harbor.example.test',passages:brief.passages.map(p=>({...p,sourceCoverage:'partial_page'}))};
 expect(preparedProspectBriefSchema.safeParse(partial).success).toBe(true);
 expect(preparedProspectBriefSchema.safeParse({...partial,coverage:'complete_retained_pages'}).success).toBe(false);
 expect(preparedProspectBriefSchema.safeParse({...partial,passages:partial.passages.map(p=>Object.fromEntries(Object.entries(p).filter(([key])=>key!=='sourceCoverage')))}).success).toBe(false);
 expect(preparedProspectBriefSchema.safeParse({...partial,policyVersion:'prepared-prospect-v1'}).success).toBe(false);
});

it('labels the discovery heading and full website/source URLs without inventing a company name or changing quotations',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const original='Our property team anticipates residents&rsquo; maintenance requests and handles them promptly.';
 f.read({...brief,passages:[{...brief.passages[0]!,quote:original}]});
 fireEvent.click(screen.getByRole('button',{name:open()}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(within(detail).getByText('Discovery label; company identity is unverified.')).toBeTruthy();
 expect(within(detail).getByRole('link',{name:row().website!}).getAttribute('href')).toBe(row().website);
 expect(within(detail).getByRole('link',{name:brief.passages[0]!.url}).getAttribute('href')).toBe(brief.passages[0]!.url);
 expect(within(detail).getByText(original)).toBeTruthy();
 expect(within(detail).queryByText('Our property team anticipates residents’ maintenance requests and handles them promptly.')).toBeNull();
 f.client.dispose();
});

it('groups adjacent exact website/location metadata even when discovery labels differ, preserving each label, order and exact open target',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const first={...row(1),displayName:'Harbor Residential | Management',discoveryLabel:'Harbor Residential | Management'},second={...row(2),displayName:'Home | Harbor',discoveryLabel:'Home | Harbor'};
 const office={...row(3),discoveryLabel:first.discoveryLabel,targetingLocality:'Cambridge'};
 const directory={...row(4),discoveryLabel:first.discoveryLabel,website:first.website+'directory/another-profile'};
 const separated={...row(5),discoveryLabel:first.discoveryLabel};
 f.rows([first,second,office,directory,separated]);fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByRole('button',{name:open(separated)});
 expect(screen.getAllByRole('group',{name:'Records with the same website'})).toHaveLength(1);
 const group=screen.getByRole('group',{name:'Records with the same website'});
 expect(within(group).getByText(/identities are not merged/iu)).toBeTruthy();
 expect(within(group).getAllByRole('button',{name:/Open company brief for/iu}).map(button=>button.getAttribute('aria-label'))).toEqual([open(first),open(second)]);
 expect(rowNames()).toEqual([first,second,office,directory,separated].map(open));
 expect(screen.getByText('5 prepared · 0 need research on this page. This is research supply, not a contact-ready count.')).toBeTruthy();
 f.read({...brief,...legacy(second)});fireEvent.click(screen.getByRole('button',{name:open(second)}));
 await screen.findByRole('article',{name:'Prepared company brief'});expect(f.requests.at(-1)?.body).toEqual(second.target);
 expect(f.requests.map(r=>r.url)).toEqual([listUrl,listUrl,'/browser/api/sourcing/prepared-prospects/read']);
 f.client.dispose();
});

it('does not group records without a website or across distinct directory paths, source spelling or location hints',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const same=(index:number)=>({...row(index),discoveryLabel:'Shared discovery label'});
 const records=[{...same(1),website:null},{...same(2),website:null},
  {...same(3),website:'https://directory.example.test/office/a'},
  {...same(4),website:'https://directory.example.test/office/b'},
  {...same(5),website:'https://harbor.example.test'},same(6),
  {...same(7),targetingRegion:'RI'}];
 f.rows(records);fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));await screen.findByRole('button',{name:open(records[6]!)});
 expect(screen.queryByRole('group',{name:'Records with the same website'})).toBeNull();expect(rowNames()).toHaveLength(7);
 f.client.dispose();
});

const callable:PreparedProspectCallable={state:'callable',missing:[],phone:'(804) 555-0142',person:'Jordan Reyes, Owner',residential:true,businessContext:true,software:false};
const listUrl='/browser/api/sourcing/prepared-prospects/list';
it('shows the stored named person on the research row only when one is stored',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 f.rows([{...row(2,callable),namedPerson:{name:'Tyler Bradford',title:'President, CPM'}},row(3,callable)],true);
 fireEvent.click(screen.getByRole('button',{name:'Callable today'}));await screen.findByRole('button',{name:open(row(2))});
 // Only the stored person is shown, and only on the row that stores one; the presentation wording is not pinned.
 expect(screen.getByRole('button',{name:open(row(2))}).textContent).toContain('Tyler');expect(screen.getByRole('button',{name:open(row(2))}).textContent).toContain('President, CPM');
 expect(screen.getByRole('button',{name:open(row(3))}).textContent).not.toContain('Tyler');
 f.client.dispose();
});
it('marks callable research rows and Callable today reads the callable order, showing only callable rows of this page honestly',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 expect(screen.getByRole('button',{name:open()}).textContent).not.toContain('Callable');
 f.rows([row(1),row(2,callable)],true);
 const toggle=screen.getByRole('button',{name:'Callable today'});expect(toggle.getAttribute('aria-pressed')).toBe('false');
 fireEvent.click(toggle);await screen.findByRole('button',{name:open(row(2))});
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:0,order:'callable'}});
 expect(screen.getByRole('button',{name:'Callable today'}).getAttribute('aria-pressed')).toBe('true');
 expect(screen.queryByRole('button',{name:open(row(1))})).toBeNull();
 expect(screen.getByRole('button',{name:open(row(2))}).textContent).toContain('Callable research');
 expect(screen.getByText(/^1 callable company on this page, best first across all pages and one per website host\..*not permission to call\.$/u)).toBeTruthy();
 f.rows([row(3)]);fireEvent.click(screen.getByRole('button',{name:'Next companies'}));
 await screen.findByText('No ranked callable companies. Ranks refresh in the background, so try again shortly.');
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:50,viewRevision:revision,order:'callable'}});
 f.rows([row(1),row(2,callable)]);fireEvent.click(screen.getByRole('button',{name:'Callable today'}));
 await screen.findByRole('button',{name:open(row(1))});
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:0}});
 expect(screen.getByText('2 prepared · 0 need research on this page. This is research supply, not a contact-ready count.')).toBeTruthy();f.client.dispose();
});

it('states callable research facts in the brief as text, never a dial link or contact permission',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const target={...row(2,{...callable,software:true,businessContext:false}),companyHost:'h2.example.test'};f.rows([target]);fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await screen.findByRole('button',{name:open(target)});f.read({...brief,...target,policyVersion:'prepared-prospect-v2'});fireEvent.click(screen.getByRole('button',{name:open(target)}));
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 expect(within(detail).getByText('Callable',{exact:true})).toBeTruthy();
 expect(within(detail).getByText('Published phone: (804) 555-0142 · Person in sources: Jordan Reyes, Owner · Residential context observed · AppFolio or Buildium named in sources · No property-management wording found')).toBeTruthy();
 expect(within(detail).queryByRole('link',{name:/555-0142/u})).toBeNull();expect(within(detail).getByText(/No permission to call or email/u)).toBeTruthy();f.client.dispose();
});

it.each([['callable',callable],['not callable',notCallable]] as const)('opening a %s brief selects its exact bounded conversation at the start of the read and offers no calling action',async(_,state)=>{
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();const onOpenCalling=vi.fn();
 const target=row(2,state),answer={...brief,...target,policyVersion:'prepared-prospect-v2'};f.rows([target]);const held=f.delayRead();
 render(<Research client={f.client} onOpenCalling={onOpenCalling}/>);
 fireEvent.click(await screen.findByRole('button',{name:open(target)}));
 expect(onOpenCalling).toHaveBeenCalledExactlyOnceWith({kind:'candidate',candidateId:target.target.candidateId,expectedCandidateRevision:2,prospectPage:{state:'all',offset:0,candidateId:target.target.candidateId,expectedRevision:2}});
 expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull();
 await act(async()=>{held.resolve(json(answer));});
 const detail=await screen.findByRole('article',{name:'Prepared company brief'});
 if(state.state==='callable')expect(within(detail).getByText('Callable',{exact:true})).toBeTruthy();else expect(within(detail).queryByText('Callable',{exact:true})).toBeNull();
 expect(within(detail).getByText(/No permission to call or email/u)).toBeTruthy();expect(screen.queryByRole('button',{name:/Open in Calling/iu})).toBeNull();
 expect(onOpenCalling).toHaveBeenCalledTimes(1);expect(f.requests.map(r=>r.url)).toEqual([listUrl,'/browser/api/sourcing/prepared-prospects/read']);
 expect(f.randomUUID).not.toHaveBeenCalled();expect(f.storage.setItem).not.toHaveBeenCalled();f.client.dispose();
});

it('workspace shows the current exact calling brief beside the retained research brief and its list',async()=>{
 const f=await mounted(true);fireEvent.click(await screen.findByRole('button',{name:open()}));
 await screen.findByRole('region',{name:'Current calling brief'});
 expect(await screen.findByRole('article',{name:'Prepared company brief'})).toBeTruthy();expect(screen.getByRole('button',{name:open()})).toBeTruthy();
 expect(screen.getByRole('button',{name:'Prepared research'}).getAttribute('aria-pressed')).toBe('true');
 expect(f.requests.filter(r=>r.url!==listUrl&&r.url!=='/browser/api/sourcing/prepared-prospects/read')).toEqual([{url:'/browser/api/sourcing/candidates/prospects/list',body:{state:'all',offset:0,candidateId:row().target.candidateId,expectedRevision:2,includeManualPhone:true}}]);
 expect(f.requests.filter(r=>r.url===listUrl||r.url.endsWith('/prepared-prospects/read'))).toHaveLength(2);
 expect(f.randomUUID).not.toHaveBeenCalled();expect(f.storage.setItem).not.toHaveBeenCalled();f.client.dispose();
});

it('a selection observer preserves the local exact brief without duplicating its prepared read',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();const onSelectionChange=vi.fn();
 render(<BrowserProspectsWorkspace client={f.client} onSelectionChange={onSelectionChange}/>);
 fireEvent.click(await screen.findByRole('button',{name:open()}));await screen.findByRole('article',{name:'Prepared company brief'});
 expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({kind:'candidate',candidateId:row().target.candidateId,expectedCandidateRevision:2,prospectPage:{state:'all',offset:0,candidateId:row().target.candidateId,expectedRevision:2}});
 expect(f.requests.filter(r=>r.url==='/browser/api/sourcing/prepared-prospects/read')).toHaveLength(1);
 expect(f.requests.filter(r=>r.url==='/browser/api/sourcing/candidates/prospects/list')).toHaveLength(1);f.client.dispose();
});

it('research is projected only while the selected conversation is that exact candidate and revision',async()=>{
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();await f.client.refresh();
 const candidateId=row().target.candidateId;let move!:(selection:CallingSelection)=>void;
 function Controlled(){const [selection,setSelection]=useState<CallingSelection|null>(null);move=setSelection;return <BrowserProspectsWorkspace client={f.client} selection={selection} onSelectionChange={setSelection}/>;}
 render(<Controlled/>);
 fireEvent.click(await screen.findByRole('button',{name:open()}));await screen.findByRole('article',{name:'Prepared company brief'});
 act(()=>{move({kind:'candidate',candidateId,expectedCandidateRevision:3});});
 await waitFor(()=>expect(screen.queryByRole('article',{name:'Prepared company brief'})).toBeNull());
 act(()=>{move({kind:'candidate',candidateId,expectedCandidateRevision:2});});
 await screen.findByRole('article',{name:'Prepared company brief'});
 expect(f.requests.filter(r=>r.url.endsWith('/prepared-prospects/read'))).toHaveLength(1);f.client.dispose();
});

const nextButton=():HTMLButtonElement=>screen.getByRole('button',{name:'Next prospect →'}) as HTMLButtonElement;
const lastSelection=(spy:Mock<(selection:CallingSelection|null)=>void>):CallingSelection|null=>spy.mock.calls.at(-1)?.[0]??null;
function Workspace({spy}:{spy:(selection:CallingSelection|null)=>void}){
 const [selection,setSelection]=useState<CallingSelection|null>(null);
 return <WorkspaceNavigationGuard><BrowserProspectsWorkspace client={client} selection={selection} onSelectionChange={next=>{spy(next);setSelection(next);}}/></WorkspaceNavigationGuard>;
}
let client!:BrowserClient;
async function openedWorkspace(first:PreparedProspectSummary[],more=false,later?:PreparedProspectSummary[]){
 vi.spyOn(Date,'now').mockReturnValue(Date.parse(at));const f=setup();client=f.client;f.rows(first,more);if(later)f.later(later);await f.client.refresh();
 const spy=vi.fn<(selection:CallingSelection|null)=>void>();render(<Workspace spy={spy}/>);
 fireEvent.click(await screen.findByRole('button',{name:open(first[0]!)}));
 await waitFor(()=>expect(workspaceChoiceDisabled('Actual outcome')).toBe(false));
 return {f,spy,listReads:()=>f.requests.filter(r=>r.url===listUrl)};
}
it('Next after a refresh advances from the exact selected record, not from the cleared research brief',async()=>{
 const {f,spy}=await openedWorkspace([row(1),row(2)]);
 fireEvent.click(screen.getByRole('button',{name:'Refresh companies'}));
 await waitFor(()=>expect(f.requests.filter(r=>r.url===listUrl)).toHaveLength(2));await screen.findByRole('button',{name:open(row(2))});
 await waitFor(()=>expect(nextButton().disabled).toBe(false));
 fireEvent.click(nextButton());
 await waitFor(()=>expect(lastSelection(spy)).toMatchObject({kind:'candidate',candidateId:row(2).target.candidateId,expectedCandidateRevision:2}));
 expect(spy).toHaveBeenCalledTimes(2);f.client.dispose();
});
it('a cancelled Next keeps the exact selection and unsaved note, and a retry reuses the already read next page',async()=>{
 const {f,spy,listReads}=await openedWorkspace([row(1)],true,[row(2)]);
 const confirm=vi.spyOn(window,'confirm').mockReturnValue(false);
 fireEvent.change(screen.getByLabelText('Private call notes'),{target:{value:'PRIVATE unsaved note'}});
 await waitFor(()=>expect(nextButton().disabled).toBe(false));
 fireEvent.click(nextButton());
 await waitFor(()=>expect(confirm).toHaveBeenCalled());await waitFor(()=>expect(listReads()).toHaveLength(2));
 // The next bounded page was read, but the refusal moved nothing.
 expect(listReads()[1]!.body).toMatchObject({offset:50});
 expect(spy).toHaveBeenCalledTimes(1);expect(lastSelection(spy)).toMatchObject({candidateId:row(1).target.candidateId});
 expect((screen.getByLabelText('Private call notes') as HTMLTextAreaElement).value).toBe('PRIVATE unsaved note');
 await waitFor(()=>expect(nextButton().disabled).toBe(false));
 confirm.mockReturnValue(true);fireEvent.click(nextButton());
 await waitFor(()=>expect(lastSelection(spy)).toMatchObject({candidateId:row(2).target.candidateId,expectedCandidateRevision:2}));
 expect(listReads()).toHaveLength(2);
 await waitFor(()=>expect((screen.getByLabelText('Private call notes') as HTMLTextAreaElement).value).toBe(''));
 f.client.dispose();
});

it('Callable today keeps the server order across pages, leaves out a row that is no longer callable and says how it is ordered',async()=>{
 const f=await mounted();await screen.findByRole('button',{name:open()});
 const at=(index:number,facts:Partial<PreparedProspectCallable>)=>({...row(index,{...callable,...facts}),companyHost:`h${index}.example.test`});
 const bare={residential:false,person:null,businessContext:false};
 f.rows([at(3,{}),at(4,{...bare,software:true}),at(2,{...bare,businessContext:true}),row(6),at(1,bare),at(5,bare)],true);
 fireEvent.click(screen.getByRole('button',{name:'Callable today'}));await screen.findByRole('button',{name:open(row(3))});
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:0,order:'callable'}});
 expect(rowNames()).toEqual([3,4,2,1,5].map(index=>open(row(index))));
 expect(screen.getByText(/^5 callable companies on this page, best first across all pages and one per website host\./u)).toBeTruthy();
 expect(screen.getByText(/ordered by residential context, a named person, AppFolio or Buildium named, then property-management wording, then newest/iu)).toBeTruthy();
 f.rows([at(7,bare)]);fireEvent.click(screen.getByRole('button',{name:'Next companies'}));await screen.findByRole('button',{name:open(row(7))});
 expect(f.requests.at(-1)).toEqual({url:listUrl,body:{offset:50,viewRevision:revision,order:'callable'}});
 // The normal view keeps every research row.
 f.rows([row(1),row(2,callable)]);fireEvent.click(screen.getByRole('button',{name:'Callable today'}));await screen.findByRole('button',{name:open(row(1))});
 expect(rowNames()).toHaveLength(2);f.client.dispose();
});
