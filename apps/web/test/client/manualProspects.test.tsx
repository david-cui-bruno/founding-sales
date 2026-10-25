// @vitest-environment jsdom
import '../../src/client/schemaRuntime.ts';
import {webcrypto} from 'node:crypto';
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {BrowserClient} from '../../src/client/BrowserClient.ts';
import {BrowserManualProspects} from '../../src/client/BrowserManualProspects.tsx';
import {MANUAL_PROSPECT_PENDING_KEY} from '../../src/client/ManualProspectPending.ts';
import {MANUAL_ACTIVITY_PENDING_KEY} from '../../src/client/ManualProspectActivityCustody.ts';
import {manualProspectSchema} from '@fss/contracts';
import {ManualProspectCard} from '../../src/client/ManualProspectCard.tsx';
const id='10000000-0000-4000-8000-000000000001';
const prospect={candidateId:id,revision:1,observedName:'<img src=x onerror=alert(1)> Loose fit',website:'javascript:alert(1)',locality:null,region:null,observedPhone:null,phoneBasis:'unknown',sources:[{label:'Retained source',url:'https://source.example.test/',observedAt:null}],sourceNotices:[{label:'CDLA-Permissive-2.0',url:null}],retainedAt:'2026-10-20T00:00:00.000Z',state:'new',unknowns:['Phone unknown'],possibleDuplicateCount:2,qualification:'unverified',contactAuthority:'not_granted'};
const json=(value:unknown,status=200)=>new Response(JSON.stringify(value),{status});
function deferred(){let resolve!:(value:Response)=>void;const promise=new Promise<Response>(yes=>{resolve=yes;});return {resolve,promise};}
function setup(){
 const data=new Map<string,string>(),storage={getItem:vi.fn((key:string)=>data.get(key)??null),setItem:vi.fn((key:string,value:string)=>{data.set(key,value);}),removeItem:vi.fn((key:string)=>{data.delete(key);})};
 let session={status:'signed_in',workspaceId:id,userId:id,deviceId:id,role:'admin',revision:'manual-session',csrfToken:'c'.repeat(40),expiresAt:new Date(Date.now()+120000).toISOString()};
 let lose=false,malformed=false,sessionUnavailable=false,delayed:ReturnType<typeof deferred>|null=null,sessionDelay:ReturnType<typeof deferred>|null=null;
 const commands:unknown[]=[],reads:unknown[]=[];let state='new';
 let rows=[prospect];
 let route:((url:string,body:Record<string,unknown>)=>Response|Promise<Response>|undefined)|undefined;
 const fetch=vi.fn<typeof globalThis.fetch>(async(url,init)=>{
  if(url==='/browser/session'){if(sessionUnavailable){sessionUnavailable=false;return json({},503);}return sessionDelay?(await sessionDelay.promise).clone():json(session);}
  const body=JSON.parse(String(init?.body)) as Record<string,unknown>;
  const custom=route?.(String(url),body);if(custom)return custom;
  if(String(url).endsWith('/prospects/list')){reads.push(body);return delayed?await delayed.promise:json({prospects:rows.map(row=>({...row,state})),hasMore:reads.length===1});}
  expect(url).toBe('/browser/api/sourcing/candidates/prospects/feedback');expect(storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).not.toBeNull();commands.push(body);state=String(body['state']);
  if(lose)throw Error('Lost response');return json(malformed?{}:{status:'accepted',replayed:commands.length>1,result:{candidateId:id,revision:1,state}});
 });
 const uuid=vi.fn(()=>crypto.randomUUID()),makeClient=()=>new BrowserClient({storage,manualActivityStorage:storage,fetch,randomUUID:uuid,navigate:vi.fn()}),client=makeClient();
 return {client,makeClient,storage,commands,reads,uuid,fetch,rows:(value:typeof rows)=>{rows=value;},route:(value:typeof route)=>{route=value;},sessionUnavailable:()=>{sessionUnavailable=true;},lose:(value=true)=>{lose=value;},malformed:()=>{malformed=true;},change:(patch:Partial<typeof session>)=>{session={...session,...patch};},delay:()=>{delayed=deferred();return delayed;},delaySession:()=>{sessionDelay=deferred();return {...sessionDelay,session};}};
}
async function ready(){await screen.findByRole('heading',{name:prospect.observedName});await waitFor(()=>{expect(screen.getByRole('button',{name:'Keep'}).hasAttribute('disabled')).toBe(false);});}
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each([['Keep','kept'],['Skip','skipped']] as const)('fresh client first %s dispatches once and saves without recovery',async(button,state)=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 fireEvent.click(screen.getByRole('button',{name:button}));
 await waitFor(()=>{expect(s.client.manualProspects.read()?.receipt).toEqual({status:'accepted',result:{candidateId:id,revision:1,state}});});
 expect(s.commands).toHaveLength(1);expect(s.commands[0]).toMatchObject({candidateId:id,expectedRevision:1,state});expect(s.uuid).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button',{name:'Reconcile same manual feedback'})).toBeNull();
 await act(async()=>{s.client.dispose();});
});
it.each([['Keep','kept'],['Skip','skipped']] as const)('a pre-dispatch session-read failure on first %s retains exact custody without a feedback POST',async(button,state)=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();s.sessionUnavailable();
 fireEvent.click(screen.getByRole('button',{name:button}));
 await screen.findByText(/Feedback outcome unknown or dispatch refused/u);
 const held=s.client.manualProspects.read();expect(held?.payload).toMatchObject({candidateId:id,expectedRevision:1,state});expect(held?.receipt).toBeUndefined();
 expect(s.commands).toEqual([]);expect(s.uuid).toHaveBeenCalledTimes(1);
 await act(async()=>{await Promise.resolve();});expect(s.commands).toEqual([]);
 fireEvent.click(screen.getByRole('button',{name:'Reconcile same manual feedback'}));
 await waitFor(()=>{expect(s.client.manualProspects.read()?.receipt?.status).toBe('accepted');});
 expect(s.commands).toEqual([held?.payload]);expect(s.uuid).toHaveBeenCalledTimes(1);
 expect(screen.queryByRole('button',{name:'Reconcile same manual feedback'})).toBeNull();
 await act(async()=>{s.client.dispose();});
});
it.each([['Keep','kept'],['Skip','skipped']] as const)('coalesces two %s clicks before React renders without stranding prepared custody',async(buttonName,state)=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 const before=s.fetch.mock.calls.length,button=screen.getByRole('button',{name:buttonName}),delay=s.delaySession();
 act(()=>{fireEvent.click(button);fireEvent.click(button);});
 expect(s.commands).toEqual([]);expect(s.uuid).toHaveBeenCalledTimes(1);
 expect(s.fetch.mock.calls.slice(before).filter(([url])=>url==='/browser/session')).toHaveLength(1);
 await act(async()=>{delay.resolve(json(delay.session));});
 await waitFor(()=>{expect(s.client.manualProspects.read()?.receipt).toEqual({status:'accepted',result:{candidateId:id,revision:1,state}});});
 expect(s.commands).toHaveLength(1);expect(s.uuid).toHaveBeenCalledTimes(1);
 // Feedback refresh and the normal post-save list refresh only, not a duplicate feedback refresh.
 expect(s.fetch.mock.calls.slice(before).filter(([url])=>url==='/browser/session')).toHaveLength(2);
 expect(screen.queryByRole('button',{name:'Reconcile same manual feedback'})).toBeNull();
 await act(async()=>{s.client.dispose();});
});
it('coalesces two explicit recovery clicks while preserving the original payload and UUID',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();s.lose();
 fireEvent.click(screen.getByRole('button',{name:'Keep'}));await screen.findByRole('button',{name:'Reconcile same manual feedback'});
 const held=s.client.manualProspects.read(),before=s.fetch.mock.calls.length;expect(s.commands).toHaveLength(1);s.lose(false);
 const button=screen.getByRole('button',{name:'Reconcile same manual feedback'}),delay=s.delaySession();
 act(()=>{fireEvent.click(button);fireEvent.click(button);});
 expect(s.commands).toHaveLength(1);
 expect(s.fetch.mock.calls.slice(before).filter(([url])=>url==='/browser/session')).toHaveLength(1);
 await act(async()=>{delay.resolve(json(delay.session));});
 await waitFor(()=>{expect(s.client.manualProspects.read()?.receipt?.status).toBe('accepted');});
 expect(s.commands).toEqual([held?.payload,held?.payload]);expect(s.uuid).toHaveBeenCalledTimes(1);
 expect(s.fetch.mock.calls.slice(before).filter(([url])=>url==='/browser/session')).toHaveLength(2);
 expect(screen.queryByRole('button',{name:'Reconcile same manual feedback'})).toBeNull();
 await act(async()=>{s.client.dispose();});
});
it('initially reads bounded raw worklist, escapes text and unsafe links with no persistent projections or qualification requests',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 expect(s.reads).toEqual([{state:'all',offset:0}]);expect(s.commands).toEqual([]);expect(s.storage.setItem).not.toHaveBeenCalled();expect(s.uuid).not.toHaveBeenCalled();
 expect(screen.queryByRole('img')).toBeNull();fireEvent.click(screen.getByText('Observed name, sources and details'));expect(screen.getAllByRole('link')).toHaveLength(1);expect(screen.getByRole('link').getAttribute('rel')).toBe('noopener noreferrer');expect(screen.getAllByText(/Phone unknown/u).length).toBeGreaterThan(0);
 fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));await waitFor(()=>{expect(s.reads).toHaveLength(2);});expect(s.reads[1]).toEqual({state:'all',offset:50});
 await act(async()=>{s.client.dispose();});
});
it.each(['lost','malformed'])('retains %s feedback through reload and explicitly reconciles same UUID without automatic replay',async failure=>{
 const s=setup();await s.client.refresh();const component=render(<BrowserManualProspects client={s.client}/>);await ready();if(failure==='lost')s.lose();else s.malformed();
 fireEvent.click(screen.getByRole('button',{name:'Wrong number'}));await screen.findByRole('button',{name:'Reconcile same manual feedback'});expect(s.commands).toHaveLength(1);
 const bytes=s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY);expect(bytes).not.toMatch(/Loose fit|https|source|csrf|Phone unknown/u);component.unmount();
 const next=s.makeClient();await next.refresh();render(<BrowserManualProspects client={next}/>);await screen.findByRole('button',{name:'Reconcile same manual feedback'});expect(s.commands).toHaveLength(1);
 if(failure==='lost'){s.lose(false);fireEvent.click(screen.getByRole('button',{name:'Reconcile same manual feedback'}));await waitFor(()=>{expect(next.manualProspects.read()?.receipt?.status).toBe('accepted');});expect(s.commands[1]).toEqual(s.commands[0]);}
 expect(s.uuid).toHaveBeenCalledTimes(1);await act(async()=>{next.dispose();s.client.dispose();});
});
it('storage failure refuses dispatch and does not silently replace custody',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();s.storage.setItem.mockImplementation(()=>{throw Error('Unavailable');});
 fireEvent.click(screen.getByRole('button',{name:'Keep'}));await screen.findByText(/Feedback outcome unknown/u);expect(s.commands).toEqual([]);expect(s.uuid).toHaveBeenCalledTimes(1);await act(async()=>{s.client.dispose();});
});
it('pre-dispatch session wait invalidation clears custody and blocks commands',async()=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();const delay=s.delaySession();fireEvent.click(screen.getByRole('button',{name:'Keep'}));
 await waitFor(()=>{expect(s.client.manualProspects.read()).not.toBeNull();});await act(async()=>{delay.resolve(json({...delay.session,revision:'replaced'}));});
 expect(s.commands).toEqual([]);expect(s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).toBeNull();expect(screen.queryByRole('heading',{name:prospect.observedName})).toBeNull();
});
it('late list response cannot restore observations after auth/session invalidation',async()=>{
 const s=setup();await s.client.refresh();const delayed=s.delay();render(<BrowserManualProspects client={s.client}/>);await waitFor(()=>{expect(s.reads).toHaveLength(1);});
 await act(async()=>{s.client.invalidate();delayed.resolve(json({prospects:[prospect],hasMore:false}));});expect(screen.queryByRole('heading',{name:prospect.observedName})).toBeNull();
});
it.each(['role','revision','workspace','expiry','auth'] as const)('clears IDs-only custody on %s authority change',async kind=>{
 const s=setup();await s.client.refresh();s.client.manualProspects.prepare({candidateId:id,expectedRevision:1,state:'skipped'});
 if(kind==='expiry'){const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001);s.client.isCurrent(s.client.epoch);now.mockRestore();}
 else if(kind==='auth')s.client.invalidate();else{s.change(kind==='role'?{role:'sales'}:kind==='workspace'?{workspaceId:'20000000-0000-4000-8000-000000000002'}:{revision:'new'});await expect(s.client.refresh()).rejects.toThrow();}
 expect(s.storage.getItem(MANUAL_PROSPECT_PENDING_KEY)).toBeNull();s.client.dispose();
});
it('discloses exact authorized literal provenance and scoped coverage without dialing or HTML execution',()=>{
 const source={method:'retained_original_literal',runId:id,observationId:id,blockId:'block-phone',url:'https://source.example.test/phone',retrievedAt:'2026-10-24T00:00:00.000Z',contentHash:'a'.repeat(64),relevantTextHash:'b'.repeat(64),parser:'manual-literal-phone-v1',literal:'(214) 555-0123',start:7,end:21,label:'Phone',labelStart:0,labelEnd:5,normalizedValue:'+12145550123',normalization:'existing-canonicalize-phone-v1',normalizationBasis:'default_us',authority:{kind:'candidate_source',sourceUrl:'https://source.example.test/phone'},lineage:{kind:'provider_original'}};
 const row=manualProspectSchema.parse({...prospect,observedPhone:'+12145550123',phoneBasis:'retained_observation',phoneEvidence:{state:'observed',value:'+12145550123',sources:[source],coverage:{parser:'manual-literal-phone-v1',state:'complete',observations:1,blocks:1}}});
 const view=render(<ManualProspectCard prospect={row} disabled={false} feedback={vi.fn()}/>);fireEvent.click(screen.getByText('Observed name, sources and details'));
 expect(screen.getByText(/Retained original literal: \(214\) 555-0123/u).textContent).toContain('UTF-16 span [7, 21)');
 expect(screen.getByText(/Default US is a formatting assumption/u)).toBeTruthy();expect(screen.getByText(/not the whole business/u)).toBeTruthy();
 expect(view.container.querySelector('a[href^="tel:"]')).toBeNull();expect(view.container.querySelector('img')).toBeNull();
 const legacy=manualProspectSchema.parse({...row,phoneEvidence:{state:'observed',value:'+12145550123',sources:[{runId:id,observationId:id,blockId:'legacy',url:'https://source.example.test/',retrievedAt:'2026-10-24T00:00:00.000Z'}]}});
 view.rerender(<ManualProspectCard prospect={legacy} disabled={false} feedback={vi.fn()}/>);expect(screen.getByText(/not retrospective literal extraction/u)).toBeTruthy();
});
it('changed optional phone read stays unknown and shows no stale rival content',()=>{
 const row=manualProspectSchema.parse({...prospect,phoneEvidence:{state:'not_extracted',reason:'optional_source_changed',coverage:{parser:'manual-literal-phone-v1',state:'changed',observations:0,blocks:0}}});
 const view=render(<ManualProspectCard prospect={row} disabled={false} feedback={vi.fn()}/>);expect(view.container.textContent).toContain('Phone unknown · not extracted');
 expect(view.container.textContent).toContain('optional source changed');expect(view.container.textContent).not.toContain('214555');expect(view.container.querySelectorAll('button')).toHaveLength(3);
});

const rival={...prospect,candidateId:'20000000-0000-4000-8000-000000000002',observedName:'Fictional B'};
const privateDraft='SYNTHETIC private preparation, no real outreach';
function composePreparation(){
 fireEvent.click(screen.getByRole('button',{name:'Prepare manual draft · NO SEND'}));
 fireEvent.change(screen.getByLabelText('Manual outreach draft'),{target:{value:privateDraft}});
 fireEvent.click(screen.getByRole('button',{name:'Review exact draft · NO SEND'}));
}
it('mounted preparation uses exact unknown-phone context, makes no request/storage write and synchronously rejects stale A actions',async()=>{
 const s=setup();s.rows([prospect,rival]);await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 const before=s.fetch.mock.calls.length;composePreparation();
 expect(screen.getByRole('article',{name:'Reviewed manual draft'}).textContent).toContain(privateDraft);
 expect(s.fetch.mock.calls).toHaveLength(before);expect(s.storage.setItem).not.toHaveBeenCalled();
 const staleOpen=screen.getByRole('button',{name:"Open this prospect's private manual activity"});
 const staleReview=screen.getByRole('button',{name:'Review exact draft · NO SEND'});
 act(()=>{fireEvent.click(screen.getByRole('button',{name:'Next prospect'}));fireEvent.click(staleOpen);fireEvent.click(staleReview);});
 expect(screen.queryByLabelText('Manual outreach draft')).toBeNull();expect(screen.queryByRole('region',{name:'Private manual prospect activity'})).toBeNull();
 expect(screen.getByRole('heading',{name:rival.observedName})).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Prepare manual draft · NO SEND'}));expect(screen.getByLabelText('Manual outreach draft')).toHaveProperty('value','');
 expect(s.fetch.mock.calls).toHaveLength(before);await act(async()=>{s.client.dispose();});
});
it.each(['refresh','filter','page','revision','unmount'] as const)('%s replacement clears draft/review/activity without discarding UNKNOWN command identity',async kind=>{
 vi.stubGlobal('crypto',webcrypto);const s=setup();await s.client.refresh();const component=render(<BrowserManualProspects client={s.client}/>);await ready();composePreparation();
 const held=await s.client.manualActivity.prepare({operation:'create',candidateId:id,expectedCandidateRevision:1,attemptId:crypto.randomUUID(),performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'unknown',note:'Fictional report only',callback:null},()=>true);
 fireEvent.click(screen.getByRole('button',{name:"Open this prospect's private manual activity"}));
 await screen.findByText(/Pending exact manual activity command/u);const bytes=s.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY);
 if(kind==='unmount')component.unmount();
 else if(kind==='filter')fireEvent.change(screen.getByLabelText('Manual state'),{target:{value:'kept'}});
 else if(kind==='page')fireEvent.click(screen.getByRole('button',{name:'Next prospect page'}));
 else{if(kind==='revision')s.rows([{...prospect,revision:2}]);fireEvent.click(screen.getByRole('button',{name:'Refresh retained worklist'}));}
 expect(screen.queryByLabelText('Manual outreach draft')).toBeNull();expect(screen.queryByRole('region',{name:'Private manual prospect activity'})).toBeNull();
 await act(async()=>{await Promise.resolve();});expect(s.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY)).toBe(bytes);expect(s.client.manualActivity.read()).toEqual(held);
 if(kind==='unmount')render(<BrowserManualProspects client={s.client}/>);else await ready();
 await ready();fireEvent.click(screen.getByRole('button',{name:'Open private manual activity'}));
 expect(screen.getByRole('button',{name:'Record a user-performed attempt'}).hasAttribute('disabled')).toBe(true);
 expect(s.uuid).toHaveBeenCalledTimes(1);expect(bytes).not.toContain(privateDraft);expect(bytes).not.toContain('Fictional report only');
 await act(async()=>{s.client.dispose();});
});
it('late exact A report read cannot restore content after selecting B',async()=>{
 const s=setup(),late=deferred(),attemptId='30000000-0000-4000-8000-000000000003',at='2026-10-25T12:00:00.000Z';s.rows([prospect,rival]);
 const metadata={candidateId:id,candidateRevision:1,attemptId,activityRevision:1,recordedAt:at,updatedAt:at,availability:'available'};
 s.route(url=>url.endsWith('/activity/list')?json({activities:[metadata],nextAfterId:null}):url.endsWith('/activity/read')?late.promise:undefined);
 await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();composePreparation();fireEvent.click(screen.getByRole('button',{name:"Open this prospect's private manual activity"}));
 fireEvent.click(screen.getByRole('button',{name:'Refresh manual activity'}));await screen.findByRole('button',{name:`Open manual report ${attemptId}`});
 fireEvent.click(screen.getByRole('button',{name:`Open manual report ${attemptId}`}));await waitFor(()=>{expect(s.fetch.mock.calls.some(([url])=>String(url).endsWith('/activity/read'))).toBe(true);});
 fireEvent.click(screen.getByRole('button',{name:'Next prospect'}));
 await act(async()=>{late.resolve(json({activity:{...metadata,performedByUser:true,channel:'manual_phone',occurrence:{kind:'unknown'},result:'callback_requested',note:'STALE PRIVATE A',callback:{note:'A intention',timing:{kind:'unknown'}},qualification:'unverified',contactAuthority:'not_granted',reportBasis:'user_reported_unverified'}}));});
 expect(screen.queryByText(/STALE PRIVATE A/u)).toBeNull();expect(screen.queryByRole('region',{name:'Private manual prospect activity'})).toBeNull();expect(screen.getByRole('heading',{name:rival.observedName})).toBeTruthy();await act(async()=>{s.client.dispose();});
});
it('scope changes during hash/WebLock save preparation block dispatch without clearing held UNKNOWN identity',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 vi.stubGlobal('navigator',{locks:{request:async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work()}});
 const s=setup();s.rows([prospect,rival]);await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 fireEvent.click(screen.getByRole('button',{name:'Open private manual activity'}));fireEvent.click(screen.getByRole('button',{name:'Record a user-performed attempt'}));
 fireEvent.click(screen.getByLabelText('I performed this manual attempt (user report, not verified)',{exact:true}));fireEvent.change(screen.getByLabelText('Relevant business result note'),{target:{value:'SYNTHETIC explicit report'}});
 const session=s.delaySession();fireEvent.click(screen.getByRole('button',{name:'Save manual report'}));
 await waitFor(()=>{expect(s.client.manualActivity.read()).not.toBeNull();});const bytes=s.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY);
 fireEvent.click(screen.getByRole('button',{name:'Next prospect'}));await act(async()=>{session.resolve(json(session.session));});
 expect(s.fetch.mock.calls.some(([url])=>String(url).endsWith('/activity/save'))).toBe(false);expect(s.storage.getItem(MANUAL_ACTIVITY_PENDING_KEY)).toBe(bytes);
 fireEvent.click(screen.getByRole('button',{name:'Open private manual activity'}));expect(screen.getByRole('button',{name:'Record a user-performed attempt'}).hasAttribute('disabled')).toBe(true);
 expect(s.uuid).toHaveBeenCalledTimes(1);await act(async()=>{s.client.dispose();});
});
it('same-turn stale A activity submit is fenced before even acquiring a WebLock',async()=>{
 vi.stubGlobal('crypto',webcrypto);const lock=vi.fn(async(_name:string,_options:unknown,work:()=>Promise<unknown>)=>work());
 vi.stubGlobal('navigator',{locks:{request:lock}});
 const s=setup();s.rows([prospect,rival]);await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();
 fireEvent.click(screen.getByRole('button',{name:'Open private manual activity'}));fireEvent.click(screen.getByRole('button',{name:'Record a user-performed attempt'}));
 fireEvent.click(screen.getByLabelText('I performed this manual attempt (user report, not verified)',{exact:true}));
 const save=screen.getByRole('button',{name:'Save manual report'});
 act(()=>{fireEvent.click(screen.getByRole('button',{name:'Next prospect'}));fireEvent.click(save);});
 expect(lock).not.toHaveBeenCalled();expect(s.uuid).not.toHaveBeenCalled();expect(s.client.manualActivity.read()).toBeNull();await act(async()=>{s.client.dispose();});
});
it.each(['logout','expiry','source'] as const)('%s refusal clears current preparation and private activity',async kind=>{
 const s=setup();await s.client.refresh();render(<BrowserManualProspects client={s.client}/>);await ready();composePreparation();fireEvent.click(screen.getByRole('button',{name:"Open this prospect's private manual activity"}));
 if(kind==='source'){s.route(url=>url.endsWith('/activity/list')?json({error:'unavailable'},404):undefined);fireEvent.click(screen.getByRole('button',{name:'Refresh manual activity'}));await waitFor(()=>{expect(screen.queryByLabelText('Manual outreach draft')).toBeNull();});}
 else if(kind==='expiry'){const now=vi.spyOn(Date,'now').mockReturnValue(Date.now()+120001);act(()=>{s.client.isCurrent(s.client.epoch);});now.mockRestore();}
 else await act(async()=>{await s.client.signOut().catch(()=>{});});
 expect(screen.queryByRole('article',{name:'Reviewed manual draft'})).toBeNull();expect(screen.queryByRole('region',{name:'Private manual prospect activity'})).toBeNull();await act(async()=>{s.client.dispose();});
});
