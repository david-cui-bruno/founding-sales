// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {OutreachSection,type OutreachPorts} from '../src/renderer/outreach/OutreachSection.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {OutreachControl,OutreachSenderStandingResponse} from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const view:OutreachControl={emailAdmission:{revision:0,enabled:false,ownerUserId:null,mailboxId:null,sequenceVersionId:null,evaluation:null,configurationSha256:null,ready:false,reasons:['configuration_required']},settings:{revision:0,enabled:false,sequenceVersionId:null,bookingUrl:null},blocks:[],senders:[{id,address:'david@usecallie.com',ownerUserId:id,connected:true,authorized:false,authorizationRevision:0,sendingEnabled:false,dailyCap:5}],sequences:[],candidates:[],replies:[]};
const ports=():OutreachPorts=>({read:vi.fn(async()=>({view,reason:null})),preview:vi.fn(async()=>({view:null,reason:'not_found'})),mutate:vi.fn(async()=>({accepted:true,view,reason:null}))});
it('explains the current recovery allowance separately from earned history without changing sending',async()=>{
 const standing:OutreachSenderStandingResponse={senders:[{mailboxId:id,standing:{healthySendingDays:40,earnedCap:50,effectiveCap:5,lastActivityAt:'2026-09-20T15:00:00.000Z',activityBasis:'confirmed_send',inactivityDays:18,recovery:{epochId:id,active:true,startedOn:'2026-10-08',stageCap:5,earnedCap:50,qualifyingDays:2,nextStageAfterDays:3,lastQualifiedOn:'2026-10-09',stageStartedOn:'2026-10-08'},readiness:{ready:false,reasons:['unresolved_submission']}}}]};
 const p=Object.assign(ports(),{standing:vi.fn(async()=>({view:standing,reason:null}))});
 render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));
 expect(await screen.findByText('Current allowance: 5 emails per day, including follow-ups.')).toBeTruthy();
 expect(screen.getByText('Earned history: 40 healthy sending days · 50 emails per day.')).toBeTruthy();
 expect(screen.getByText('Inactivity recovery: 2 of 5 qualifying days completed at this stage; 3 more required before the next stage.')).toBeTruthy();
 expect(screen.getByText('A previous send still needs reconciliation.')).toBeTruthy();
 expect(screen.getByText(/This is a ceiling, not a daily target/)).toBeTruthy();
 expect(p.mutate).not.toHaveBeenCalled();
});
it('shows exact sender and separate sending pause without enabling anything on open',async()=>{
 const p=ports();render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));
 expect(await screen.findByText(/^Sending paused/)).toBeTruthy();expect(screen.getByRole('option',{name:'david@usecallie.com'})).toBeTruthy();expect(p.mutate).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Automatically answer supported replies') as HTMLInputElement).checked).toBe(false);
});
it('counts only the qualifying days at the current recovery stage and preserves drafts when standing becomes unavailable',async()=>{
 const standing:OutreachSenderStandingResponse={senders:[{mailboxId:id,standing:{healthySendingDays:40,earnedCap:50,effectiveCap:10,lastActivityAt:null,activityBasis:'mailbox_creation',inactivityDays:30,recovery:{epochId:id,active:true,startedOn:'2026-10-08',stageCap:10,earnedCap:50,qualifyingDays:7,nextStageAfterDays:3,lastQualifiedOn:'2026-10-16',stageStartedOn:'2026-10-15'},readiness:{ready:true,reasons:[]}}}]};
 const p=Object.assign(ports(),{standing:vi.fn().mockResolvedValueOnce({view:standing,reason:null}).mockResolvedValue({view:null,reason:'unavailable'})});
 render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));
 expect(await screen.findByText('Inactivity recovery: 2 of 5 qualifying days completed at this stage; 3 more required before the next stage.')).toBeTruthy();
 fireEvent.change(screen.getByLabelText('Answer fact'),{target:{value:'Approved materials are still being prepared.'}});
 fireEvent.click(screen.getByRole('button',{name:'Refresh outreach'}));
 expect(await screen.findByText('Current sender standing is unavailable. Refresh to check the allowance and recovery status.')).toBeTruthy();
 expect(screen.queryByText('Current mailbox checks pass. Each send still requires its normal safety checks.')).toBeNull();
 expect((screen.getByLabelText('Answer fact') as HTMLTextAreaElement).value).toBe('Approved materials are still being prepared.');
 expect(p.mutate).not.toHaveBeenCalled();
});
it('keeps a fact draft across navigation and saving does not approve it',async()=>{
 const p=ports();const {rerender}=render(<DraftsProvider><OutreachSection enabled ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));await screen.findByText(/^Sending paused/);
 fireEvent.change(screen.getByLabelText('Answer fact'),{target:{value:'Callie integrates with AppFolio.'}});
 rerender(<DraftsProvider><span>Elsewhere</span></DraftsProvider>);rerender(<DraftsProvider><OutreachSection enabled ports={p}/></DraftsProvider>);
 expect((screen.getByLabelText('Answer fact') as HTMLTextAreaElement).value).toBe('Callie integrates with AppFolio.');
 fireEvent.click(screen.getByRole('button',{name:'Save fact draft'}));
 await waitFor(()=>expect(p.mutate).toHaveBeenCalledWith(expect.objectContaining({action:'fact_save',text:'Callie integrates with AppFolio.'})));
 expect(p.mutate).toHaveBeenCalledTimes(1);
});
it('retries an uncertain action with the same command identity',async()=>{
 const p=ports();p.mutate=vi.fn().mockRejectedValueOnce(new Error('lost')).mockResolvedValue({accepted:true,view,reason:null});
 render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));await screen.findByText(/^Sending paused/);
 fireEvent.click(screen.getByRole('button',{name:'Authorize this sender'}));fireEvent.click(await screen.findByRole('button',{name:'Retry outreach action'}));
 await waitFor(()=>expect(p.mutate).toHaveBeenCalledTimes(2));expect(vi.mocked(p.mutate).mock.calls[0]).toEqual(vi.mocked(p.mutate).mock.calls[1]);
});
it('requires a fresh cohort preview and clears it when selection changes',async()=>{
 const candidate='22222222-2222-4222-8222-222222222222';
 const p=ports();p.read=vi.fn(async()=>({view:{...view,senders:[{...view.senders[0]!,authorized:true}],candidates:[{id:candidate,revision:1,qualificationRunId:id,name:'Dallas PM',location:'Dallas, TX'}]},reason:null}));
 p.preview=vi.fn(async()=>({view:{hash:'a'.repeat(64),rows:[{candidateId:candidate,name:'Dallas PM',revision:1,qualificationRunId:id,address:'office@pm.test',lane:'email_first' as const,reviewRequired:true,reason:null}]},reason:null}));
 render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));
 fireEvent.click(await screen.findByLabelText('Dallas PM · Dallas, TX'));
 expect(screen.queryByRole('button',{name:'Enable selected cohort'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Preview selected firms'}));
 expect((await screen.findByRole('button',{name:'Enable selected cohort'}) as HTMLButtonElement).disabled).toBe(true);
 fireEvent.click(screen.getByLabelText('I reviewed these firms and their source evidence.'));
 expect((screen.getByRole('button',{name:'Enable selected cohort'}) as HTMLButtonElement).disabled).toBe(false);
 fireEvent.click(screen.getByLabelText('Dallas PM · Dallas, TX'));
 expect(screen.queryByRole('button',{name:'Enable selected cohort'})).toBeNull();expect(p.mutate).not.toHaveBeenCalled();
});
