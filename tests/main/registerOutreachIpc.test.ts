import { beforeEach,describe,expect,it,vi } from 'vitest';
const electron=vi.hoisted(()=>({handle:vi.fn(),removeHandler:vi.fn()}));
vi.mock('electron',()=>({ipcMain:electron}));
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { OutreachApi,EmailDraft,OutreachStatus } from '../../src/shared/contracts/outreachContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const draft:EmailDraft={id:'d1',personId:'p1',salesCycleId:'c1',contactMethodId:'e1',recipient:'owner@example.com',subject:'Hello',body:'Message',revision:1,status:'draft',generation:'none',messageId:null,notice:null,updatedAt:'2026-09-08T15:00:00.000Z'};
const status:OutreachStatus={model:'unconfigured' as const,modelName:'',gmail:'unconfigured' as const,accountEmail:null,senderName:'',postalAddress:''};
const channels=['status','configure','connect-gmail','disconnect-gmail','open-draft','save-draft','generate-draft','send-draft'].map(s=>`outreach:${s}`);
let calls:number;
const provider=():OutreachApi=>({status:async()=>status,configure:async()=>status,connectGmail:async()=>status,disconnectGmail:async()=>status,
 openDraft:async()=>{calls++;return draft;},saveDraft:async()=>draft,generateDraft:async()=>draft,sendDraft:async()=>draft});
const trusted={senderFrame:{url:'callie://app/index.html'}};
beforeEach(()=>{electron.handle.mockReset();electron.removeHandler.mockReset();calls=0;});
describe('outreach trusted IPC and real preload composition',()=>{
 it('exposes the new namespace and matches draft identity across the bridge',async()=>{
   const unregister=registerOutreachIpc({provider:provider()});
   const api=createCallieApi({invoke:async(channel,...args)=>registeredIpcHandler(electron.handle,channel)(trusted,...args)});
   expect(await api.outreach.openDraft({personId:'p1',contactMethodId:'e1'})).toEqual(draft);
   expect(calls).toBe(1);expect(electron.handle.mock.calls.map(([channel])=>channel)).toEqual(channels);
   unregister();unregister();expect(electron.removeHandler.mock.calls.map(([channel])=>channel)).toEqual([...channels].reverse());
 });
 it('refuses untrusted or target-smuggled requests before provider access',async()=>{
   registerOutreachIpc({provider:provider()});const invoke=registeredIpcHandler(electron.handle,'outreach:open-draft');
   await expect(invoke({senderFrame:{url:'https://untrusted.test/'}},{personId:'p1',contactMethodId:'e1'})).rejects.toThrow('OUTREACH_REQUEST_FAILED');
   await expect(invoke(trusted,{personId:'p1',contactMethodId:'e1',recipient:'other@example.com'})).rejects.toThrow('OUTREACH_REQUEST_FAILED');
   expect(calls).toBe(0);
 });
 it('does not expose provider secret errors',async()=>{
   const p=provider();p.configure=async()=>{throw new Error('token SECRET');};registerOutreachIpc({provider:p});
   await expect(registeredIpcHandler(electron.handle,'outreach:configure')(trusted,{apiKey:'key'})).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
 });
 it('rejects mismatched person response in preload',async()=>{
   const api=createCallieApi({invoke:async()=>({...draft,personId:'other'})});
   await expect(api.outreach.openDraft({personId:'p1',contactMethodId:'e1'})).rejects.toThrow();
 });
});
