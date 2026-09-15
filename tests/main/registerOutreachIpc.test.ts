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
  let index=0;electron.handle.mockImplementation(()=>{if(index++===11) throw Error('fixture later registration failure');});
  expect(()=>registerOutreachIpc({provider:provider(),delegation:{} as never})).toThrow('fixture later registration failure');
  expect(electron.handle.mock.calls.map(([channel])=>channel)).toEqual([...channels,'outreach:reply-reconcile','outreach:reply-edit','outreach:requested-followup-prepare']);
  expect(electron.removeHandler.mock.calls.map(([channel])=>channel)).toEqual([...channels,'outreach:reply-reconcile','outreach:reply-edit'].reverse());
},10000);

// Phone recovery validation is independent at both public trust boundaries.
import { delegatedPhoneStateRequestSchema, delegatedPhoneStateSchema, delegatedPhoneStateReplySchema, type PhoneHandoffState } from '../../src/shared/contracts/delegatedPhoneStateContract';
const phoneRequest = { accountId: 'phone-account', enrollmentId: 'phone-enrollment', stepId: 'call-step' };
const phoneEmpty: PhoneHandoffState = { ...phoneRequest, workspaceId: 'phone-workspace', generatedAt: '2026-09-08T15:00:00.000Z', remote: 'unknown', campaign: { campaignId: 'campaign', campaignRevision: 1, campaignVersionId: 'version' }, completeness: 'complete', issue: null, attempts: [], completions: [] };
function phoneApplied() {
  return delegatedPhoneStateSchema.parse({ ...phoneEmpty, attempts: [{
    command: { commandId: '11111111-1111-4111-8111-111111111111', workspaceId: phoneEmpty.workspaceId, accountId: phoneRequest.accountId, expectedAuthorityGeneration: 1, expectedVersion: 5, kind: 'prepare-manual',
      payload: { actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1, targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: phoneRequest.enrollmentId, enrollmentRevision: 1, stepId: phoneRequest.stepId } } },
    queuedAt: '2026-09-08T14:00:00.000Z', receipt: { commandId: '11111111-1111-4111-8111-111111111111', status: 'applied', authorityGeneration: 1, aggregateVersion: 6, reason: null },
    receiptEvent: { eventId: 'handoff-event', kind: 'manual.handoff', authorityGeneration: 1, aggregateVersion: 6, appliedAt: '2026-09-08T14:00:01.000Z' },
    handoff: { value: { actionId: 'action', channel: 'call', routeId: 'route', routeVersion: 1, targetHash: 'a'.repeat(64), contentHash: 'b'.repeat(64), contextRevision: 'context', campaign: { campaignId: 'campaign', campaignRevision: 1, enrollmentId: phoneRequest.enrollmentId, enrollmentRevision: 1, stepId: phoneRequest.stepId }, handoffId: 'handoff', expiresAt: '2026-09-08T14:01:01.000Z' }, authorityGeneration: 1, consumedAt: '2026-09-08T14:00:02.000Z' },
  }], completions: [{ prepareCommandId: '11111111-1111-4111-8111-111111111111',
    command: { commandId: '22222222-2222-4222-8222-222222222222', workspaceId: phoneEmpty.workspaceId, accountId: phoneRequest.accountId, expectedAuthorityGeneration: 2, expectedVersion: 7, kind: 'complete-manual', payload: { handoffId: 'handoff', targetHash: 'a'.repeat(64), outcome: { actionId: 'action', channel: 'call', outcome: 'no_answer', observedAt: '2026-09-08T14:00:03.000Z', evidenceRef: 'human', replyText: null } } },
    queuedAt: '2026-09-08T14:00:04.000Z', receipt: { commandId: '22222222-2222-4222-8222-222222222222', status: 'applied', authorityGeneration: 1, aggregateVersion: 9, reason: null }, receiptEvent: { eventId: 'outcome-event', kind: 'manual.outcome', authorityGeneration: 1, aggregateVersion: 9, appliedAt: '2026-09-08T14:00:05.000Z' },
    applied: { outcome: { actionId: 'action', channel: 'call', outcome: 'no_answer', observedAt: '2026-09-08T14:00:03.000Z', evidenceRef: 'human', replyText: null }, campaignCommandId: '22222222-2222-4222-8222-222222222222', evidence: { enrollmentId: phoneRequest.enrollmentId, accountId: phoneRequest.accountId, campaignVersionId: 'version', stepId: phoneRequest.stepId, routeId: 'route', routeVersion: 1, outcome: 'no_answer', observedAt: '2026-09-08T14:00:03.000Z', observation: 'unknown', source: 'human', executionContextId: 'context', contextRevision: 1, state: 'human_reported_sent', actionId: 'action', channel: 'call' } },
  }] });
}
const phoneMutations: { name: string; path: string; value: unknown }[] = [
  { name: 'outer account', path: 'accountId', value: 'other' }, { name: 'outer enrollment', path: 'enrollmentId', value: 'other' }, { name: 'outer step', path: 'stepId', value: 'other' },
  { name: 'workspace', path: 'workspaceId', value: 'other' }, { name: 'extra authority', path: 'allowed', value: true },
  { name: 'command account', path: 'attempts.0.command.accountId', value: 'other' }, { name: 'command workspace', path: 'attempts.0.command.workspaceId', value: 'other' },
  { name: 'command UUID', path: 'attempts.0.command.commandId', value: 'opaque' }, { name: 'hash', path: 'attempts.0.command.payload.targetHash', value: 'x'.repeat(64) },
  { name: 'channel', path: 'attempts.0.command.payload.channel', value: 'linkedin' }, { name: 'receipt command', path: 'attempts.0.receipt.commandId', value: 'other' },
  { name: 'receipt event kind', path: 'attempts.0.receiptEvent.kind', value: 'manual.outcome' }, { name: 'receipt generation', path: 'attempts.0.receipt.authorityGeneration', value: 3 },
  { name: 'handoff target', path: 'attempts.0.handoff.value.targetHash', value: 'c'.repeat(64) }, { name: 'handoff action', path: 'attempts.0.handoff.value.actionId', value: 'other' },
  { name: 'handoff campaign', path: 'attempts.0.handoff.value.campaign.campaignRevision', value: 2 }, { name: 'handoff generation', path: 'attempts.0.handoff.authorityGeneration', value: 3 },
  { name: 'consumption before ack', path: 'attempts.0.handoff.consumedAt', value: '2026-09-08T14:00:00.000Z' }, { name: 'consumption at expiry', path: 'attempts.0.handoff.consumedAt', value: '2026-09-08T14:01:01.000Z' },
  { name: 'future queued', path: 'attempts.0.queuedAt', value: '2026-09-09T14:00:00.000Z' }, { name: 'bad timestamp', path: 'generatedAt', value: 'yesterday' },
  { name: 'completion parent', path: 'completions.0.prepareCommandId', value: '33333333-3333-4333-8333-333333333333' }, { name: 'completion handoff', path: 'completions.0.command.payload.handoffId', value: 'other' },
  { name: 'outcome action', path: 'completions.0.applied.outcome.actionId', value: 'other' }, { name: 'replyText null versus missing', path: 'completions.0.applied.outcome.replyText', value: undefined },
  { name: 'evidence account', path: 'completions.0.applied.evidence.accountId', value: 'other' }, { name: 'evidence enrollment', path: 'completions.0.applied.evidence.enrollmentId', value: 'other' },
  { name: 'evidence version', path: 'completions.0.applied.evidence.campaignVersionId', value: 'other' }, { name: 'evidence step', path: 'completions.0.applied.evidence.stepId', value: 'other' },
  { name: 'evidence route', path: 'completions.0.applied.evidence.routeId', value: 'other' }, { name: 'evidence context', path: 'completions.0.applied.evidence.executionContextId', value: 'other' },
  { name: 'evidence state', path: 'completions.0.applied.evidence.state', value: 'unknown' }, { name: 'evidence source', path: 'completions.0.applied.evidence.source', value: 'provider' },
  { name: 'evidence cancellation extra', path: 'completions.0.applied.evidence.cancellationEvidence', value: {} }, { name: 'evidence observed', path: 'completions.0.applied.evidence.observedAt', value: '2026-09-08T14:00:02.000Z' },
  { name: 'campaign command', path: 'completions.0.applied.campaignCommandId', value: '33333333-3333-4333-8333-333333333333' },
  { name: 'old completion generation', path: 'completions.0.command.expectedAuthorityGeneration', value: 0 }, { name: 'completion event generation', path: 'completions.0.receiptEvent.authorityGeneration', value: 2 },
  { name: 'event before outcome', path: 'completions.0.receiptEvent.appliedAt', value: '2026-09-08T14:00:02.000Z' },
];
function changedPhone(path: string, value: unknown): PhoneHandoffState {
  const result = structuredClone(phoneApplied());
  let target: unknown = result; const keys = path.split('.');
  for (const key of keys.slice(0, -1)) { if (typeof target !== 'object' || target === null) throw Error('bad test path'); target = Reflect.get(target, key); }
  if (typeof target !== 'object' || target === null) throw Error('bad test path'); Reflect.set(target, keys.at(-1)!, value); return result;
}
it.each(phoneMutations)('phone_state_strict_public_correspondence independently rejects $name in preload', async ({ path, value }) => {
  const response = changedPhone(path, value);
  expect(delegatedPhoneStateReplySchema(phoneRequest).safeParse(response).success).toBe(false);
  const api = createCallieApi({ invoke: async () => response }); await expect(api.delegation.getPhoneHandoffState(phoneRequest)).rejects.toThrow();
});
it('phone_state_strict_public_correspondence freezes actual selector while invoke is pending, including incomplete', async () => {
  let reply!: (value: unknown) => void; const invoke = vi.fn(() => new Promise<unknown>(resolve => { reply = resolve; }));
  const request = { ...phoneRequest }, api = createCallieApi({ invoke }); const waiting = api.delegation.getPhoneHandoffState(request);
  request.accountId = 'mutated'; reply({ ...phoneEmpty }); expect(await waiting).toEqual(phoneEmpty);
  const bound = delegatedPhoneStateReplySchema(request); request.accountId = phoneRequest.accountId;
  expect(bound.safeParse(phoneEmpty).success).toBe(false);
  for (const key of ['accountId', 'enrollmentId', 'stepId']) expect(delegatedPhoneStateReplySchema(phoneRequest).safeParse({ ...phoneEmpty, completeness: 'incomplete', issue: 'source_limit', [key]: 'foreign' }).success).toBe(false);
});
it.each([{}, { ...phoneRequest, workspaceId: 'other' }, { ...phoneRequest, limit: 1 }, { ...phoneRequest, accountId: '' }])('phone_state strict request rejects authority and limit smuggling', request => {
  expect(delegatedPhoneStateRequestSchema.safeParse(request).success).toBe(false);
});
it('phone_state strict schema rejects array overflow, duplicate identities and ordering', () => {
  const valid = phoneApplied(); expect(delegatedPhoneStateSchema.safeParse(valid).success).toBe(true);
  expect(delegatedPhoneStateSchema.safeParse({ ...valid, attempts: Array.from({ length: 33 }, () => valid.attempts[0]) }).success).toBe(false);
  expect(delegatedPhoneStateSchema.safeParse({ ...valid, completions: Array.from({ length: 101 }, () => valid.completions[0]) }).success).toBe(false);
  expect(delegatedPhoneStateSchema.safeParse({ ...valid, attempts: [...valid.attempts, ...valid.attempts] }).success).toBe(false);
});
it('phone_state main binds selector before preload, validates sender/arity and removes channel once', async () => {
  const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
  const gate = vi.fn(async () => { throw Error('must not access SQL'); });
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: gate }, pairing: null, clock: { now: () => phoneEmpty.generatedAt } });
  runtime.getPhoneHandoffState = vi.fn(async () => ({ ...phoneEmpty, accountId: 'wrong' }));
  const remove = registerOutreachIpc({ provider: provider(), delegation: runtime }); const channel = 'outreach:delegation-get-phone-handoff-state', invoke = registeredIpcHandler(electron.handle, channel);
  try {
    await expect(invoke(trusted, phoneRequest)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    vi.mocked(runtime.getPhoneHandoffState).mockClear();
    for (const args of [[], [phoneRequest, phoneRequest], [{ ...phoneRequest, allowed: true }]]) await expect(invoke(trusted, ...args)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    await expect(invoke({ senderFrame: { url: 'https://untrusted.test' } }, phoneRequest)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    expect(runtime.getPhoneHandoffState).not.toHaveBeenCalled(); expect(gate).not.toHaveBeenCalled();
  } finally { remove(); remove(); await runtime.dispose(); }
  expect(electron.removeHandler.mock.calls.filter(([name]) => name === channel)).toHaveLength(1);
});
it.each(['accountId', 'enrollmentId', 'stepId'] as const)('phone_state main independently rejects wrong %s on an empty reply', async key => {
  const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async () => { throw Error('No SQL expected'); } }, pairing: null, clock: { now: () => phoneEmpty.generatedAt } });
  runtime.getPhoneHandoffState = async () => ({ ...phoneEmpty, [key]: 'foreign' });
  const remove = registerOutreachIpc({ provider: provider(), delegation: runtime });
  try { await expect(registeredIpcHandler(electron.handle, 'outreach:delegation-get-phone-handoff-state')(trusted, phoneRequest)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); }
  finally { remove(); await runtime.dispose(); }
});
it('phone_state schema UTF-8 serialized reply admission has an exact positive and overflow control', () => {
  const base = phoneApplied();
  if (base.completeness !== 'complete') throw Error('fixture');
  const template = base.completions[0];
  if (!template.applied) throw Error('fixture');
  const completions = Array.from({ length: 100 }, (_, i) => {
    const commandId = `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`;
    return { ...structuredClone(template), command: { ...structuredClone(template.command), commandId }, receipt: { ...template.receipt, commandId }, receiptEvent: { ...template.receiptEvent!, eventId: `event-${i}` }, applied: { ...structuredClone(template.applied!), campaignCommandId: commandId } };
  });
  const value = { ...base, completions }; const bytes = () => new TextEncoder().encode(JSON.stringify(value)).byteLength;
  // Escape expansion, not JavaScript string length, is the limiting wire size.
  let remaining = 8_388_608 - bytes();
  for (const c of completions) {
    // null currently occupies four bytes on each of the two outcome projections.
    const count = Math.min(10000, Math.floor((remaining + 4) / 12));
    const note = '\u0001'.repeat(count); c.command.payload.outcome.replyText = note; c.applied.outcome.replyText = note;
    remaining = 8_388_608 - bytes();
    if (remaining < 12) break;
  }
  // Use receipt.reason for the remaining single-byte precision adjustment.
  const last = completions.at(-1)!; last.receipt.reason = 'x'.repeat(remaining + 2);
  expect(bytes()).toBe(8_388_608); expect(delegatedPhoneStateSchema.safeParse(value).success).toBe(true);
  last.receipt.reason += 'x'; expect(bytes()).toBe(8_388_609); expect(delegatedPhoneStateSchema.safeParse(value).success).toBe(false);
});
it.each(['missing-pairing', 'lease-unavailable', 'locked', 'disposed', 'lock-pending', 'dispose-pending'] as const)('phone_state_lifecycle_fails_closed: %s', async mode => {
  const { createPmFixture, PM_NOW } = await import('../fixtures/pmAccounts'); const f = await createPmFixture();
  const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
  let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
  const gate = { withDatabase: async <T,>(fn: (db: typeof f.db) => T | Promise<T>) => { if (mode === 'lease-unavailable') throw Error('secret unavailable lease'); if (mode.endsWith('pending')) await barrier; return fn(f.db); } };
  const runtime = createDelegationRuntime({ databaseGate: gate, pairing: mode === 'missing-pairing' ? null : { endpoint: 'https://worker.invalid', workspaceId: 'ws', pairingId: 'pairing', credential: 'a'.repeat(43), emergencyCredential: 'b'.repeat(43), generation: 0, scopes: ['commands:write', 'events:read'] }, clock: { now: () => PM_NOW } });
  const remove = registerOutreachIpc({ provider: provider(), delegation: runtime }); let disposal: Promise<void> | undefined;
  try {
    if (mode === 'locked') runtime.invalidate(true); if (mode === 'disposed') await runtime.dispose();
    const waiting = registeredIpcHandler(electron.handle, 'outreach:delegation-get-phone-handoff-state')(trusted, phoneRequest);
    const assertion = expect(waiting).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    if (mode === 'lock-pending') runtime.invalidate(true); if (mode === 'dispose-pending') disposal = runtime.dispose();
    release(); await assertion; await disposal;
    expect(f.db.raw.prepare('SELECT * FROM delegated_commands').all()).toEqual([]);
  } finally { release(); remove(); await runtime.dispose(); f.close(); }
});
it('phone_state schema keeps pending/rejected records projection-free and preserves unconsumed expiry', () => {
  const applied = phoneApplied(); if (applied.completeness !== 'complete') throw Error('fixture');
  for (const status of ['pending', 'rejected'] as const) {
    const attempt: Extract<PhoneHandoffState, { completeness: 'complete' }>['attempts'][number] = { ...applied.attempts[0], receipt: { ...applied.attempts[0].receipt, status }, receiptEvent: null, handoff: null };
    expect(delegatedPhoneStateSchema.safeParse({ ...applied, attempts: [attempt], completions: [] }).success).toBe(true);
    expect(delegatedPhoneStateSchema.safeParse({ ...applied, attempts: [{ ...attempt, handoff: applied.attempts[0].handoff }], completions: [] }).success).toBe(false);
  }
  const attempt = applied.attempts[0]; if (!attempt.handoff) throw Error('fixture'); attempt.handoff.consumedAt = null;
  expect(delegatedPhoneStateSchema.safeParse({ ...applied, completions: [] }).success).toBe(true);
  expect(delegatedPhoneStateSchema.safeParse(applied).success).toBe(false);
});
it.each(['connected', 'no_answer', 'voicemail', 'busy', 'wrong_number', 'not_called', 'cancelled', 'unknown', 'opt_out'] as const)('phone_state strict outcome/state correspondence: %s', outcome => {
  const base = phoneApplied(); if (base.completeness !== 'complete') throw Error('fixture'); const c = base.completions[0]; if (!c.applied) throw Error('fixture');
  c.command.payload.outcome.outcome = outcome; c.applied.outcome.outcome = outcome; c.applied.evidence.outcome = outcome;
  c.applied.evidence.state = ['not_called', 'cancelled'].includes(outcome) ? 'cancelled' : ['unknown', 'opt_out'].includes(outcome) ? 'unknown' : 'human_reported_sent';
  expect(delegatedPhoneStateSchema.safeParse(base).success).toBe(true);
  c.applied.evidence.state = outcome === 'unknown' ? 'human_reported_sent' : 'cancelled';
  if (['not_called', 'cancelled'].includes(outcome)) c.applied.evidence.state = 'unknown';
  expect(delegatedPhoneStateSchema.safeParse(base).success).toBe(false);
});
it.each(phoneMutations)('phone_state_strict_public_correspondence independently rejects $name in registered main', async ({ path, value }) => {
  const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
  const access = vi.fn(async () => { throw Error('malicious output fixture must not access SQL'); });
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: access }, pairing: null, clock: { now: () => phoneEmpty.generatedAt } });
  runtime.getPhoneHandoffState = async () => changedPhone(path, value);
  const remove = registerOutreachIpc({ provider: provider(), delegation: runtime });
  try { await expect(registeredIpcHandler(electron.handle, 'outreach:delegation-get-phone-handoff-state')(trusted, phoneRequest)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); expect(access).not.toHaveBeenCalled(); }
  finally { remove(); await runtime.dispose(); }
});
it.each(['attempts', 'completions'] as const)('phone_state response array overflow rejects independently at preload and registered main: %s', async key => {
  const value = phoneApplied(); if (value.completeness !== 'complete') throw Error('fixture');
  if (key === 'attempts') value.attempts = Array.from({ length: 33 }, () => value.attempts[0]);
  else value.completions = Array.from({ length: 101 }, () => value.completions[0]);
  await expect(createCallieApi({ invoke: async () => value }).delegation.getPhoneHandoffState(phoneRequest)).rejects.toThrow();
  const { createDelegationRuntime } = await import('../../src/main/delegation/delegationRuntime');
  const runtime = createDelegationRuntime({ databaseGate: { withDatabase: async () => { throw Error('No SQL expected'); } }, pairing: null, clock: { now: () => phoneEmpty.generatedAt } });
  runtime.getPhoneHandoffState = async () => value; const remove = registerOutreachIpc({ provider: provider(), delegation: runtime });
  try { await expect(registeredIpcHandler(electron.handle, 'outreach:delegation-get-phone-handoff-state')(trusted, phoneRequest)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); }
  finally { remove(); await runtime.dispose(); }
});
