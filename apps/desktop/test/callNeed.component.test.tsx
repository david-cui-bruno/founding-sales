// @vitest-environment jsdom
import {render,screen,fireEvent,cleanup,waitFor} from '@testing-library/react';
import {afterEach,it,expect,vi} from 'vitest';
import {CallNeed,type CallNeedPorts} from '../src/renderer/sourcing/CallNeed.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111';
it('records confirmed need directly on the answered call without a meeting',async()=>{
 const ports:CallNeedPorts={read:vi.fn(async()=>({view:{callLogId:id,revision:0,sourceRevision:2,answer:'unknown' as const,stale:false,canConfirm:true},reason:null})),save:vi.fn(async()=>({result:{revision:1},reason:null}))};
 render(<DraftsProvider><CallNeed sessionId={id} ports={ports}/></DraftsProvider>);
 fireEvent.click(screen.getByRole('button',{name:'Maintenance need'}));fireEvent.click(await screen.findByRole('button',{name:'Confirmed need'}));
 expect(await screen.findByText('Saved for this call.')).toBeTruthy();expect(ports.save).toHaveBeenCalledWith(expect.objectContaining({callLogId:id,expectedRevision:0,expectedSourceRevision:2,answer:'yes'}));
});
it('keeps the same command after an uncertain result and navigation',async()=>{
 const save=vi.fn().mockResolvedValueOnce({result:null,reason:'offline'}).mockResolvedValueOnce({result:{revision:1},reason:null});
 const ports:CallNeedPorts={read:async()=>({view:{callLogId:id,revision:0,sourceRevision:0,answer:'unknown' as const,stale:false,canConfirm:true},reason:null}),save};
 const v=render(<DraftsProvider><CallNeed sessionId={id} ports={ports}/></DraftsProvider>);fireEvent.click(screen.getByRole('button',{name:'Maintenance need'}));fireEvent.click(await screen.findByRole('button',{name:'Confirmed need'}));await screen.findByText('Save not confirmed. Retry safely.');
 v.rerender(<DraftsProvider><span>Other page</span></DraftsProvider>);v.rerender(<DraftsProvider><CallNeed sessionId={id} ports={ports}/></DraftsProvider>);
 await screen.findByText('Saved: unknown');fireEvent.click(screen.getByRole('button',{name:'Retry confirmation'}));await waitFor(()=>expect(save).toHaveBeenCalledTimes(2));expect(save.mock.calls[1]?.[0]).toEqual(save.mock.calls[0]?.[0]);
});
