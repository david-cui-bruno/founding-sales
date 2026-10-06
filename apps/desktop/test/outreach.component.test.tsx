// @vitest-environment jsdom
import {afterEach,it,expect,vi} from 'vitest';
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {OutreachSection,type OutreachPorts} from '../src/renderer/outreach/OutreachSection.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import type {OutreachControl} from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const view:OutreachControl={settings:{revision:0,enabled:false,sequenceVersionId:null,bookingUrl:null},blocks:[],senders:[{id,address:'david@usecallie.com',ownerUserId:id,connected:true,authorized:false,authorizationRevision:0,sendingEnabled:false,dailyCap:5}],sequences:[],candidates:[],replies:[]};
const ports=():OutreachPorts=>({read:vi.fn(async()=>({view,reason:null})),preview:vi.fn(async()=>({view:null,reason:'not_found'})),mutate:vi.fn(async()=>({accepted:true,view,reason:null}))});
it('shows exact sender and separate sending pause without enabling anything on open',async()=>{
 const p=ports();render(<OutreachSection enabled ports={p}/>);fireEvent.click(screen.getByRole('button',{name:'Outreach setup'}));
 expect(await screen.findByText(/^Sending paused/)).toBeTruthy();expect(screen.getByRole('option',{name:'david@usecallie.com'})).toBeTruthy();expect(p.mutate).not.toHaveBeenCalled();
 expect((screen.getByLabelText('Automatically answer supported replies') as HTMLInputElement).checked).toBe(false);
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
