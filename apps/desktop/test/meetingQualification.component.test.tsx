// @vitest-environment jsdom
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {MeetingQualification,type QualificationPorts} from '../src/renderer/meetings/Qualification.tsx';
import type {MeetingQualificationView} from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
const view=():MeetingQualificationView=>({meetingId:id,revision:0,buyingParticipant:'unknown',maintenanceNeed:'unknown',openToPaying:'unknown',attendanceConfirmed:false,qualified:false,evidence:[],sourceLinks:[],staleFields:[]});
const ports=():QualificationPorts=>({read:vi.fn(async()=>({view:view(),reason:null})),save:vi.fn(async()=>({view:{...view(),revision:1},reason:null}))});
it('starts unknown, preserves edits across navigation, and requires no extra note',async()=>{
 const p=ports();const {rerender}=render(<DraftsProvider key="session"><MeetingQualification meetingId={id} ports={p}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Demo qualification'}));const select=await screen.findByLabelText('Real maintenance need');expect((select as HTMLSelectElement).value).toBe('unknown');
 fireEvent.change(select,{target:{value:'yes'}});rerender(<DraftsProvider key="session"><span>Other page</span></DraftsProvider>);rerender(<DraftsProvider key="session"><MeetingQualification meetingId={id} ports={p}/></DraftsProvider>);
 expect((await screen.findByLabelText('Real maintenance need') as HTMLSelectElement).value).toBe('yes');fireEvent.click(screen.getByRole('button',{name:'Save qualification'}));
 await waitFor(()=>expect(p.save).toHaveBeenCalledWith(expect.objectContaining({maintenanceNeed:'yes',evidence:[expect.objectContaining({field:'maintenanceNeed',sourceKind:'user_confirmation'})]})));
 expect(screen.queryByRole('textbox')).toBeNull();
});
it('keeps a stale draft and lets the user refresh the version before explicitly saving again',async()=>{
 const p=ports();p.save=vi.fn(async()=>({view:null,reason:'qualification_changed'}));
 render(<DraftsProvider><MeetingQualification meetingId={id} ports={p}/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Demo qualification'}));
 fireEvent.change(await screen.findByLabelText('Open to paying'),{target:{value:'yes'}});fireEvent.click(screen.getByRole('button',{name:'Save qualification'}));
 expect(await screen.findByText(/changed elsewhere/)).toBeTruthy();expect((screen.getByLabelText('Open to paying') as HTMLSelectElement).value).toBe('yes');
});
it('retries uncertain delivery with the same command and does not display another meeting response',async()=>{
 const p=ports();p.save=vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({view:{...view(),revision:1},reason:null});
 render(<DraftsProvider><MeetingQualification meetingId={id} ports={p}/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Demo qualification'}));
 fireEvent.change(await screen.findByLabelText('Buying participant'),{target:{value:'yes'}});fireEvent.click(screen.getByRole('button',{name:'Save qualification'}));fireEvent.click(await screen.findByRole('button',{name:'Retry save'}));
 await waitFor(()=>expect(p.save).toHaveBeenCalledTimes(2));expect(vi.mocked(p.save).mock.calls[1]![0]).toEqual(vi.mocked(p.save).mock.calls[0]![0]);
});
