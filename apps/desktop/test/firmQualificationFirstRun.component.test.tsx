// @vitest-environment jsdom
import {QueryClient,QueryClientProvider} from '@tanstack/react-query';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import type {JSX} from 'react';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {createGeneration} from '../src/renderer/app/generation.ts';
import {FirmsRoute} from '../src/renderer/firms/FirmsRoute.tsx';
import {resetCrmMemory} from '../src/renderer/firms/crmMemory.ts';
import {TodayWorkspace,useTodayMemory} from '../src/renderer/today/TodayWorkspace.tsx';
import type {Today,TodayActions} from '../src/renderer/today/useToday.ts';
import type {TodayState} from '../src/renderer/todayContract.ts';
import {buildTodayView} from '../src/renderer/todayView.ts';
import type {HomeView} from '../src/renderer/homeView.ts';
import type {CallControl} from '../src/renderer/calling/useCall.ts';
import type {OperationApi} from '../src/shared/operations.ts';
import {OPERATIONS} from '../src/shared/operations.ts';
import {assigneeFirmPage,crmState,FIRM_ID} from './e2e/support/crmFixtures.ts';
const candidateId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const notStarted={candidateId,candidateRevision:3,status:'not_started' as const,nativeEligibility:{status:'pending' as const,reason:'evidence_pending' as const,channelAuthority:'not_granted' as const}};
afterEach(()=>{cleanup();resetCrmMemory();globalThis.callieApi=undefined;});
const todayState=(enabled=true):TodayState=>({snapshotDate:'2026-10-21',businessTimeZone:'America/Chicago',cards:[],expanded:{firmId:FIRM_ID,firmName:'Synthetic research Firm',snapshotDate:'2026-10-21',lane:'new_firm',counts:{replies:0,emailsDue:0,callsDue:0},tasks:[],routes:[],callingIdentityId:null},online:true,stale:false,asOf:'2026-10-21T12:00:00Z',mayMutate:enabled,role:'admin',notice:null,handoffNotice:'',dialAdvice:[],followUpTemplates:[]});
const home={heading:'Today',summary:null,notices:[],lanes:{sections:[],emptyLine:null},status:[],needs:[],needsLine:'Nothing needs you.',figures:{label:'Numbers',cells:[],line:null}} as unknown as HomeView;
function ExpandedToday({enabled}:{enabled:boolean}):JSX.Element {
 const state=todayState(enabled),memory=useTodayMemory();
 const today:Today={state,pending:0,commands:0,refreshAnswered:true,now:Date.parse(state.asOf!),refresh:vi.fn(),actions:{busy:()=>false,expand:vi.fn(),dial:vi.fn()} as unknown as TodayActions,autoRefresh:vi.fn()};
 const call:CallControl={state:{phase:'idle'},muted:false,seconds:0,place:vi.fn(),toggleMute:vi.fn(),hangUp:vi.fn(),dismiss:vi.fn()};
 return <TodayWorkspace home={home} today={today} todayView={buildTodayView(state)} call={call} memory={memory} hasTodayBridge onRefresh={vi.fn()} onConnectMailbox={vi.fn()}/>;
}
function fixture(surface:'Firm'|'Today',reason:string|null=null,enabled=true){
 const generation=createGeneration();generation.note(0);
 let current=true;
 const state=crmState({role:'admin',mayMutate:enabled,firm:assigneeFirmPage()});
 const read=vi.fn(async(name:string)=>{
  if(name==='sourcing.firmQualification')return {view:current?notStarted:null,reason:current?null:'not_found'};
  if(name==='sourcing.qualification')return {view:null,reason:'not_found'};
  if(name==='crm.state'||name==='crm.openFirm')return state;
  if(name==='research.open')return {firm:null,settings:null,worstCaseRunCents:null,spend:null,notice:null,mayMutate:enabled,role:'admin'};
  if(name==='calling.history')return {calls:[]};
  if(name==='calling.status')return {provider:'twilio',cadence:{unansweredAttempts:0,nextAttempt:1,limit:4,parked:false,refusal:null}};
  if(name==='recordings.recoveries')return {items:[],truncated:false};
  if(name==='meetings.forFirm'||name==='meetings.unmatched')return {meetings:[]};
  if(name==='crm.progressRead')return {version:1,events:[],truncated:false,coverage:'partial'};
  if(name==='crm.businessMailList')return {sources:[],nextAfterId:null};
  if(name==='crm.businessMailControls')return {mailboxId:FIRM_ID,enabled:false,ready:false,reason:'activation_not_available',revision:0};
  if(name==='crm.personList')return {people:[],nextAfterId:null};
  if(name==='crm.relationshipFirms')return {firms:[]};
  return {};
 });
 const command=vi.fn(async()=>reason?{result:null,reason}:{result:{runId:'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'},reason:null});
 globalThis.callieApi={read,command} as unknown as OperationApi;
 const client=new QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity}}});
 const tree=(owner='owner')=><QueryClientProvider client={client}><DraftsProvider key={owner}>{surface==='Firm'?<FirmsRoute route={{name:'firm',firmId:FIRM_ID}} identity={owner} generation={0} guard={generation.guard}/>:<ExpandedToday enabled={enabled}/>}</DraftsProvider></QueryClientProvider>;
 const mounted=render(tree());return {read,command,mounted,tree,loseOwner:()=>{current=false;}};
}
it('shared existing output accepts only the locked not-started union, never invented run fields',()=>{
 const output=OPERATIONS['sourcing.firmQualification'].output;
 expect(output.safeParse({view:notStarted,reason:null}).success).toBe(true);
 expect(output.safeParse({view:{...notStarted,runId:candidateId,observations:[]},reason:null}).success).toBe(false);
});
it.each(['Firm','Today'] as const)('%s actual consumer opens the existing first action without automatic commands or synthetic evidence',async surface=>{
 const f=fixture(surface);await screen.findByText(/Qualification has not started/);
 expect(f.command).not.toHaveBeenCalled();expect(f.read.mock.calls.filter(([name])=>name==='sourcing.qualification')).toHaveLength(0);
 expect(screen.getByText(/Channel authority: not granted/)).toBeTruthy();expect(screen.queryByText('Native firm eligibility: verified')).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));
 await screen.findByRole('button',{name:'Check qualification'});await waitFor(()=>expect(f.read.mock.calls.some(([name])=>name==='sourcing.qualification')).toBe(true));
 expect(screen.queryByRole('button',{name:'Add to call queue'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Check qualification'}));
 await waitFor(()=>expect(f.command).toHaveBeenCalledTimes(1));
 expect(f.command.mock.calls[0]).toEqual(['sourcing.qualify',{candidateId,expectedRevision:3,commandId:expect.any(String)}]);
 await screen.findByText('Qualification request recorded. Refresh to see its current result.');
});
it.each(['Firm','Today'] as const)('%s actual consumer preserves refusal, held and research-disabled responses without admission',async surface=>{
 for(const [reason,message] of [['identity_review_required','Firm identity was marked incorrect'],['research_held','Research is on hold'],['research_disabled','Research is paused']] as const){
  const f=fixture(surface,reason);await screen.findByText(/Qualification has not started/);fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));fireEvent.click(await screen.findByRole('button',{name:'Check qualification'}));
  await screen.findByText(message);expect(f.command).toHaveBeenCalledTimes(1);expect(screen.queryByRole('button',{name:'Add to call queue'})).toBeNull();f.mounted.unmount();resetCrmMemory();
 }
});
it.each(['Firm','Today'] as const)('%s actual consumer removes first action after owner/source loss and obeys mutation disable',async surface=>{
 const f=fixture(surface,null,false);await screen.findByText(/Qualification has not started/);fireEvent.click(screen.getByRole('button',{name:'Evidence and call readiness'}));
 expect((await screen.findByRole('button',{name:'Check qualification'}) as HTMLButtonElement).disabled).toBe(true);expect(f.command).not.toHaveBeenCalled();
 f.loseOwner();f.mounted.rerender(f.tree('replacement-owner'));
 await waitFor(()=>expect(screen.queryByRole('button',{name:'Check qualification'})).toBeNull());expect(screen.queryByText(/Qualification has not started/)).toBeNull();expect(f.command).not.toHaveBeenCalled();
});
