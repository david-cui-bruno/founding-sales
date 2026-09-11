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

it('registers strict delegation preload against actual leased SQL configuration and never grants by caller flags',async()=>{
 const {createPmFixture,PM_NOW}=await import('../fixtures/pmAccounts');const f=await createPmFixture();
 const {createDelegationRuntime}=await import('../../src/main/delegation/delegationRuntime');let http=0;
 const delegation=createDelegationRuntime({databaseGate:{withDatabase:async fn=>fn(f.db)},pairing:{endpoint:'https://worker.example.test',workspaceId:'ws',pairingId:'11111111-1111-4111-8111-111111111111',credential:'a'.repeat(43),emergencyCredential:'b'.repeat(43),generation:0,scopes:['commands:write','events:read']},clock:{now:()=>PM_NOW},fetch:async()=>{http++;throw Error('Unconfigured HTTP forbidden');}});
 const unregister=registerOutreachIpc({provider:provider(),delegation});
 const api=createCallieApi({invoke:async(channel,...args)=>registeredIpcHandler(electron.handle,channel)(trusted,...args)});
 try{
  expect(await api.delegation.status()).toMatchObject({state:'paused',workspaceId:'ws',configuration:null});
  expect(await api.delegation.configure({expectedRevision:0,configuration:{version:1,state:'paused',research:null}})).toMatchObject({revision:1});
  expect((await api.delegation.status()).configuration?.revision).toBe(1);
  for(const channel of ['delegation-bootstrap','delegation-begin-phone','delegation-policy','delegation-research','delegation-submit']){
   const invoke=registeredIpcHandler(electron.handle,`outreach:${channel}`);
   await expect(invoke(trusted,{allowed:true})).rejects.toThrow('OUTREACH_REQUEST_FAILED');
   await expect(invoke({senderFrame:{url:'https://untrusted.test/'}},{})).rejects.toThrow('OUTREACH_REQUEST_FAILED');
  }
  const {DelegationRepository}=await import('../../src/main/delegation/delegationRepository');
  const account=f.repo.create({commandId:'33333333-3333-4333-8333-333333333333',name:'Actual SQL account',domain:null});
  new DelegationRepository({database:f.db,workspaceId:'ws',clock:{now:()=>PM_NOW}}).initializeLocalAuthority(account.id);
  const changed={...account,name:'Renderer invented replacement'};
  const rawBootstrap:import('../../src/shared/contracts/delegationContract').DelegationCommand={commandId:'22222222-2222-4222-8222-222222222222',workspaceId:'ws',accountId:account.id,expectedAuthorityGeneration:0,expectedVersion:0,kind:'bootstrap-selected-account',payload:{record:{account:changed,history:[{at:PM_NOW,account:changed,claims:[],routes:[]}],claims:[],routes:[],sources:[],researchRevision:1},asOf:PM_NOW,expectedResearchRevision:null,suppression:[]}};
  await expect(registeredIpcHandler(electron.handle,'outreach:delegation-submit')(trusted,rawBootstrap)).rejects.toThrow('OUTREACH_REQUEST_FAILED');
  await expect(api.delegation.submit(rawBootstrap as never)).rejects.toThrow();
  await expect(Promise.resolve().then(()=>delegation.submit(rawBootstrap))).rejects.toThrow();
  expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
  expect(http).toBe(0);delegation.invalidate(true);
  expect(await api.delegation.status()).toMatchObject({state:'locked',configuration:null});
  await expect(api.delegation.configure({expectedRevision:1,configuration:{version:1,state:'active',research:null}})).rejects.toThrow('OUTREACH_REQUEST_FAILED');
 }finally{unregister();await delegation.dispose();f.close();}
});
