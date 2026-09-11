import { beforeEach,describe,expect,it,vi } from 'vitest';
const electron=vi.hoisted(()=>({handle:vi.fn(),removeHandler:vi.fn()}));
vi.mock('electron',()=>({ipcMain:electron}));
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';
import { createCallieApi } from '../../src/preload/createCallieApi';
import type { OutreachApi,EmailDraft,OutreachStatus,LocalEmailAuthorityRead } from '../../src/shared/contracts/outreachContract';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const draft:EmailDraft={id:'d1',personId:'p1',salesCycleId:'c1',contactMethodId:'e1',recipient:'owner@example.com',subject:'Hello',body:'Message',revision:1,status:'draft',generation:'none',messageId:null,notice:null,updatedAt:'2026-09-08T15:00:00.000Z'};
const status:OutreachStatus={model:'unconfigured' as const,modelName:'',gmail:'unconfigured' as const,accountEmail:null,senderName:'',postalAddress:''};
const channels=['status','configure','connect-gmail','disconnect-gmail','open-draft','save-draft','generate-draft','send-draft','inspect-local-authority'].map(s=>`outreach:${s}`);
let calls:number;
const provider=():OutreachApi=>({status:async()=>status,configure:async()=>status,connectGmail:async()=>status,disconnectGmail:async()=>status,
 inspectLocalAuthority:async input=>({draftId:input.draftId,expectedRevision:input.expectedRevision,personId:'p1',contactMethodId:'e1',state:'held',reason:'email_authority_unavailable',checkedAt:'2026-09-08T15:00:00.000Z'}),
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

function expectSingleCall(fn:unknown,...args:unknown[]) { expect(fn).toHaveBeenCalledTimes(1);expect(fn).toHaveBeenCalledWith(...args); }
// Task7 source-only additions exercise both actual public boundaries independently.
const authorityRequest={draftId:'d1',expectedRevision:1};
const authorityRead:LocalEmailAuthorityRead={...authorityRequest,personId:'p1',contactMethodId:'e1',state:'allowed',reason:null,checkedAt:'2026-09-08T15:00:00.000Z'};
const authorityChannel='outreach:inspect-local-authority';
function authorityBridge() {
  const p=provider();p.inspectLocalAuthority=vi.fn(async input=>{expect(input).toEqual(authorityRequest);return {...authorityRead};});
  const dispose=registerOutreachIpc({provider:p});
  let invoke:ReturnType<typeof registeredIpcHandler>;
  try {invoke=registeredIpcHandler(electron.handle,authorityChannel);} catch(error) {dispose();throw error;}
  const transport=vi.fn(async(channel:string,...args:unknown[])=>registeredIpcHandler(electron.handle,channel)(trusted,...args));
  const api=createCallieApi({invoke:transport});
  return {p,dispose,invoke,transport,api};
}
it('Task7 bridges exact saved-draft authority and disposes exactly nine handlers once',async()=>{
  const f=authorityBridge();
  try {
    expect(await f.api.outreach.inspectLocalAuthority(authorityRequest)).toEqual(authorityRead);
    expectSingleCall(f.transport,authorityChannel,authorityRequest);
    expectSingleCall(f.p.inspectLocalAuthority,authorityRequest);
    expect(electron.handle.mock.calls.map(([channel])=>channel)).toEqual(channels);
  } finally {f.dispose();f.dispose();}
  expect(electron.removeHandler.mock.calls.map(([channel])=>channel)).toEqual([...channels].reverse());
},10000);
const invalidAuthorityArgs: {name:string;args:unknown[]}[]=[
  {name:'missing argument',args:[]},{name:'extra argument',args:[authorityRequest,authorityRequest]},
  {name:'null request',args:[null]},{name:'empty ID',args:[{...authorityRequest,draftId:''}]},
  {name:'excessive ID',args:[{...authorityRequest,draftId:'x'.repeat(257)}]},
  {name:'numeric ID',args:[{...authorityRequest,draftId:7}]},
  {name:'zero revision',args:[{...authorityRequest,expectedRevision:0}]},
  {name:'negative revision',args:[{...authorityRequest,expectedRevision:-1}]},
  {name:'fractional revision',args:[{...authorityRequest,expectedRevision:1.5}]},
  {name:'string revision',args:[{...authorityRequest,expectedRevision:'1'}]},
  ...['personId','recipient','contactSnapshot','expectedWorkspaceId','allowed'].map(key=>({name:`injected ${key}`,args:[{...authorityRequest,[key]:'forged'}]})),
];
it.each(invalidAuthorityArgs)('Task7 registrar rejects $name before provider',async({args})=>{
  const f=authorityBridge();try {
    await expect(f.invoke(trusted,...args)).rejects.toThrow(/^EMAIL_AUTHORITY_READ_FAILED$/);
    expect(f.p.inspectLocalAuthority).not.toHaveBeenCalled();
  } finally {f.dispose();}
},10000);
it.each(invalidAuthorityArgs)('Task7 preload rejects $name before transport',async({args})=>{
  const f=authorityBridge();try {
    await expect(Promise.resolve().then(()=>Reflect.apply(f.api.outreach.inspectLocalAuthority,f.api.outreach,args))).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();expect(f.p.inspectLocalAuthority).not.toHaveBeenCalled();
  } finally {f.dispose();}
},10000);
it('Task7 untrusted sender is refused before authority provider and request inspection',async()=>{
  const f=authorityBridge();let inspected=0;
  const input=Object.defineProperty({},'draftId',{get(){inspected++;throw Error('private getter');}});
  try {
    await expect(f.invoke({senderFrame:{url:'https://untrusted.example.test/'}},input)).rejects.toThrow(/^EMAIL_AUTHORITY_READ_FAILED$/);
    expect(inspected).toBe(0);expect(f.p.inspectLocalAuthority).not.toHaveBeenCalled();
  } finally {f.dispose();}
},10000);
const invalidAuthorityResults=[
  {name:'wrong draft',patch:{draftId:'different-draft'}},
  {name:'wrong revision',patch:{expectedRevision:2}},
  {name:'empty person',patch:{personId:''}},
  {name:'empty contact',patch:{contactMethodId:''}},
  {name:'unknown state',patch:{state:'ready'}},
  {name:'unknown reason',patch:{reason:'private_reason'}},
  {name:'invalid timestamp',patch:{checkedAt:'yesterday'}},
  {name:'public snapshot leak',patch:{contactSnapshot:'private-snapshot'}},
];
it.each(invalidAuthorityResults)('Task7 registrar rejects $name response itself',async({patch})=>{
  const f=authorityBridge();try {
    vi.mocked(f.p.inspectLocalAuthority).mockResolvedValue({...authorityRead,...patch} as LocalEmailAuthorityRead);
    await expect(f.invoke(trusted,authorityRequest)).rejects.toThrow(/^EMAIL_AUTHORITY_READ_FAILED$/);
    expectSingleCall(f.p.inspectLocalAuthority,authorityRequest);
  } finally {f.dispose();}
},10000);
it.each(invalidAuthorityResults)('Task7 preload rejects $name response independently',async({patch})=>{
  const transport=vi.fn(async()=>({...authorityRead,...patch}));const api=createCallieApi({invoke:transport});
  await expect(api.outreach.inspectLocalAuthority(authorityRequest)).rejects.toThrow();
  expectSingleCall(transport,authorityChannel,authorityRequest);
},10000);
it('Task7 authority failure is a redacted Error while unrelated channel errors stay unchanged',async()=>{
  const f=authorityBridge();try {
    vi.mocked(f.p.inspectLocalAuthority).mockRejectedValue(new Error('SECRET token /private/fictional.sqlite'));
    const error=await f.api.outreach.inspectLocalAuthority(authorityRequest).then(():null=>null,error=>error);
    expect(error).toBeInstanceOf(Error);expect(error.message).toBe('EMAIL_AUTHORITY_READ_FAILED');
    expect(String(error)).not.toMatch(/SECRET|private|sqlite/);
    f.p.configure=async()=>{throw Error('SECRET unrelated');};
    await expect(f.api.outreach.configure({apiKey:'fictional-key'})).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
  } finally {f.dispose();}
},10000);
it.each([0,1,2,3,4,5,6,7,8])('Task7 registration rolls back exact prefix before position %s',position=>{
  let index=0;electron.handle.mockImplementation(()=>{if(index++===position) throw Error('fixture registration failure');});
  expect(()=>registerOutreachIpc({provider:provider()})).toThrow('fixture registration failure');
  expect(electron.handle.mock.calls.map(([channel])=>channel)).toEqual(channels.slice(0,position+1));
  expect(electron.removeHandler.mock.calls.map(([channel])=>channel)).toEqual(channels.slice(0,position).reverse());
},10000);

it('Task7 later optional registration failure rolls back the newly registered ninth authority handler',()=>{
  let index=0;electron.handle.mockImplementation(()=>{if(index++===9) throw Error('fixture later registration failure');});
  expect(()=>registerOutreachIpc({provider:provider(),delegation:{} as never})).toThrow('fixture later registration failure');
  expect(electron.handle.mock.calls.map(([channel])=>channel)).toEqual([...channels,'outreach:requested-followup-prepare']);
  expect(electron.removeHandler.mock.calls.map(([channel])=>channel)).toEqual([...channels].reverse());
},10000);
