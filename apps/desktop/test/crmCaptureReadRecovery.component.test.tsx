// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CaptureReadRecovery, type CaptureReadRecoveryPorts } from '../src/renderer/firms/CaptureReadRecovery.tsx';
import type { CrmCaptureReadRecoveryStatus } from '@fss/contracts';
afterEach(cleanup);
const id='11111111-1111-4111-8111-111111111111',incident='22222222-2222-4222-8222-222222222222';
function status():CrmCaptureReadRecoveryStatus{return {mailboxId:id,generation:1,eligible:true,incidentId:incident,recoveryBinding:'a'.repeat(64),reason:null,attempt:null,sendingUnchanged:true,holdsUnchanged:true,providerCoverage:'unproven'};}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
it('stable UI reads status, never probes automatically, and one deliberate unknown command permits refresh only',async()=>{
 const user=userEvent.setup(),request=vi.fn<CaptureReadRecoveryPorts['request']>(async()=>{throw new Error('unknown transport outcome');}),read=vi.fn(async()=>status());
 render(<CaptureReadRecovery ports={{read,request}} mailboxId={id} privacyKey="owner:1"/>);
 const button=await screen.findByRole('button',{name:'Recover capture read'});await waitFor(()=>expect(button.hasAttribute('disabled')).toBe(false));
 expect(request).not.toHaveBeenCalled();expect(screen.getByText(/Sending stays paused and every existing sending hold remains unchanged/)).toBeTruthy();
 await user.dblClick(button);expect(request).toHaveBeenCalledTimes(1);
 expect(request.mock.calls[0]?.[0]).toMatchObject({mailboxId:id,expectedGeneration:1,incidentId:incident,expectedRecoveryBinding:'a'.repeat(64),commandId:expect.any(String)});
 expect(await screen.findByRole('alert')).toHaveProperty('textContent',expect.stringContaining('Refresh status only'));
 await user.click(screen.getByRole('button',{name:'Refresh capture recovery status'}));expect(read).toHaveBeenCalledTimes(2);
 expect(button.hasAttribute('disabled')).toBe(true);expect(request).toHaveBeenCalledTimes(1);
});
it('late old-identity status and command answers never publish into replacement identity',async()=>{
 const stale=deferred<CrmCaptureReadRecoveryStatus>(),request=vi.fn(async()=>({attemptId:id,state:'queued',sendingUnchanged:true as const,holdsUnchanged:true as const}));
 const old:CaptureReadRecoveryPorts={read:()=>stale.promise,request};
 const current:CaptureReadRecoveryPorts={read:async()=>({...status(),eligible:false,incidentId:null,recoveryBinding:null,reason:'capture_authority_unavailable'}),request};
 const view=render(<CaptureReadRecovery ports={old} mailboxId={id} privacyKey="old:1"/>);
 view.rerender(<CaptureReadRecovery ports={current} mailboxId={id} privacyKey="new:2"/>);
 await screen.findByText(/capture authority unavailable/);
 await act(async()=>{stale.resolve(status());await stale.promise;});
 expect(screen.queryByText(incident)).toBeNull();expect(screen.getByRole('button',{name:'Recover capture read'}).hasAttribute('disabled')).toBe(true);expect(request).not.toHaveBeenCalled();
});
it('verified status says capture only, preserves holds, and never represents provider coverage',async()=>{
 const s=status();s.eligible=false;s.attempt={attemptId:id,state:'verified',reason:'capture_read_verified',requestedAt:'2026-10-21T00:00:00Z',probeStartedAt:'2026-10-21T00:00:01Z',completedAt:'2026-10-21T00:00:02Z'};
 render(<CaptureReadRecovery ports={{read:async()=>s,request:vi.fn()}} mailboxId={id} privacyKey="owner:1"/>);
 expect(await screen.findByText(/Capture-read verified/)).toHaveProperty('textContent',expect.stringContaining('Sending remains held'));
 expect(screen.getByRole('button',{name:'Recover capture read'}).hasAttribute('disabled')).toBe(true);
});
