// @vitest-environment jsdom
import {afterEach,expect,it,vi} from 'vitest';
import {act,cleanup,fireEvent,render,screen} from '@testing-library/react';
import {FirmQualification,type FirmQualificationRead} from '../src/renderer/sourcing/FirmQualification.tsx';
import {DraftsProvider} from '../src/renderer/app/drafts.tsx';
import {nativeId,nativeView} from './support/nativeFirmFixture.ts';
afterEach(()=>{cleanup();vi.useRealTimers();});
const flush=async()=>{await act(async()=>{await Promise.resolve();});};
it('shows exact Firm-response native service-area citations independently of candidate verdict and grants no channel',async()=>{
 const view=nativeView(),read=vi.fn<FirmQualificationRead>(async()=>({view,reason:null}));render(<FirmQualification firmId={nativeId} read={read}/>);await flush();
 expect(screen.getByText('Native firm eligibility: verified')).toBeTruthy();expect(screen.getByText(/Channel authority: not granted/)).toBeTruthy();expect(screen.getAllByText(view.observations[0]!.blocks[0]!.text)).toHaveLength(3);
 expect(screen.queryByRole('button',{name:'Add to call queue'})).toBeNull();expect(read).toHaveBeenCalledTimes(1);
});
it('removes verified evidence immediately offline, drops late responses and reads afresh on reconnect',async()=>{
 let resolve!:(value:Awaited<ReturnType<FirmQualificationRead>>)=>void;const view=nativeView(),read=vi.fn<FirmQualificationRead>().mockResolvedValueOnce({view,reason:null}).mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({view:null,reason:'not_found'});
 const mounted=render(<FirmQualification firmId={nativeId} online read={read}/>);await flush();expect(screen.getByText('Native firm eligibility: verified')).toBeTruthy();
 fireEvent.click(screen.getByRole('button',{name:'Refresh current Firm evidence'}));mounted.rerender(<FirmQualification firmId={nativeId} online={false} read={read}/>);await act(async()=>resolve({view,reason:null}));
 expect(screen.getByText('Native firm eligibility: unavailable offline')).toBeTruthy();expect(screen.queryByText(view.observations[0]!.blocks[0]!.text)).toBeNull();
 mounted.rerender(<FirmQualification firmId={nativeId} online read={read}/>);await flush();expect(screen.getByText('Native firm eligibility: unavailable')).toBeTruthy();
});
it('clears current badge and original citations exactly when source validity expires',async()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-21T12:00:00.000Z'));const view=nativeView(new Date().toISOString(),1000),read:FirmQualificationRead=async()=>({view,reason:null});
 render(<FirmQualification firmId={nativeId} read={read}/>);await flush();expect(screen.getByText('Native firm eligibility: verified')).toBeTruthy();
 await act(async()=>{vi.advanceTimersByTime(1001);});expect(screen.getByText('Native firm eligibility: unavailable')).toBeTruthy();expect(screen.queryByText(view.observations[0]!.blocks[0]!.text)).toBeNull();
});
it('drops old owner and old Firm results and never uses retained candidate/Today memory as native truth',async()=>{
 let resolve!:(value:Awaited<ReturnType<FirmQualificationRead>>)=>void;const view=nativeView(),read=vi.fn<FirmQualificationRead>().mockImplementationOnce(()=>new Promise(done=>{resolve=done;})).mockResolvedValue({view:null,reason:'not_found'});
 const tree=(owner:string,firmId=nativeId)=><DraftsProvider key={owner}><FirmQualification firmId={firmId} read={read}/></DraftsProvider>;
 const mounted=render(tree('old'));mounted.rerender(tree('new'));await act(async()=>resolve({view,reason:null}));expect(screen.queryByText('Native firm eligibility: verified')).toBeNull();
 mounted.rerender(tree('new','22222222-2222-4222-8222-222222222222'));await flush();expect(screen.queryByText('Native firm eligibility: verified')).toBeNull();
});
it('clears prior verified output while current source-loss read is pending and after refusal',async()=>{
 const view=nativeView(),read=vi.fn<FirmQualificationRead>().mockResolvedValueOnce({view,reason:null}).mockResolvedValue({view:null,reason:'not_found'});
 render(<FirmQualification firmId={nativeId} read={read}/>);await flush();fireEvent.click(screen.getByRole('button',{name:'Refresh current Firm evidence'}));expect(screen.queryByText('Native firm eligibility: verified')).toBeNull();await flush();expect(screen.getByText('Native firm eligibility: unavailable')).toBeTruthy();
});
