// @vitest-environment jsdom
import {it,expect,vi,afterEach} from 'vitest';
import {render,screen,fireEvent,waitFor,cleanup} from '@testing-library/react';
import {WeeklyDrafts,type WeeklyPorts} from '../src/renderer/social/WeeklyDrafts.tsx';
afterEach(cleanup);
it('requires an explicit opt-in, preserves an ambiguous retry and reports the saved state',async()=>{
 const off={enabled:false,revision:0,nextAt:null,lastAt:null,lastResult:null};
 const save=vi.fn<WeeklyPorts['save']>().mockResolvedValueOnce({view:null,reason:'offline'}).mockResolvedValueOnce({view:{...off,enabled:true,revision:1,nextAt:'2026-10-10T12:00:00Z'},reason:null});
 render(<WeeklyDrafts ports={{read:async()=>({view:off,reason:null}),save}}/>);
 const button=await screen.findByText('Enable weekly drafts');expect(save).not.toHaveBeenCalled();fireEvent.click(button);fireEvent.click(await screen.findByText('Retry setting change'));
 await waitFor(()=>expect(screen.getByText('Turn off weekly drafts')).toBeTruthy());expect(save.mock.calls[1]).toEqual(save.mock.calls[0]);expect(save.mock.calls[0]![0]).toMatchObject({enabled:true,expectedRevision:0});
});
