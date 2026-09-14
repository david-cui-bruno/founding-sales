import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DelegationRuntime } from '../../src/main/delegation/delegationRuntime';
import type { OutreachApi } from '../../src/shared/contracts/outreachContract';
import type { ResearchSetupApi, ResearchSetupApproveInput, ResearchSetupReceipt } from '../../src/shared/contracts/researchSetupContract';
import { createResearchSetupApi } from '../../src/preload/apis/researchSetupApi';
import { createCallieApi } from '../../src/preload/createCallieApi';
import { createIpcClient } from '../../src/preload/ipcClient';
import { registeredIpcHandler } from '../fixtures/registeredIpcHandler';
const electron = vi.hoisted(() => ({ handle: vi.fn(), removeHandler: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: electron }));
import { registerOutreachIpc } from '../../src/main/ipc/registerOutreachIpc';

const trusted = { senderFrame: { url: 'callie://app/index.html' } };
const proposal: ResearchSetupApproveInput = { expectedRevision: 0, descriptorFingerprint: 'a'.repeat(64), audience: { residential: true, regions: ['Fictional region'], terms: ['property management'] }, permittedSources: ['https://fictional.example.test/'], maxCompanies: 1, maxPages: 1, maxBytes: 10000, discoveryCeilingMicros: 100, researchCeilingMicros: 200, disclosureAcknowledged: true };
const transition = { state: 'paused' as const, expectedRevision: 1, disclosureAcknowledged: true as const };
const applied: ResearchSetupReceipt = { workspaceId: 'fictional-workspace', pairingId: '11111111-1111-4111-8111-111111111111', requestId: '22222222-2222-4222-8222-222222222222', fingerprint: 'a'.repeat(64), kind: 'approve', status: 'applied', revision: 1, state: 'active' };
const cancelled: ResearchSetupReceipt = { workspaceId: applied.workspaceId, pairingId: applied.pairingId, requestId: applied.requestId, fingerprint: applied.fingerprint, kind: applied.kind, status: 'cancelled', revision: null, state: null };
const names = ['status', 'approve', 'setState', 'retry', 'cancelPending'] as const;
const channel = (name: typeof names[number]) => `outreach:research-setup-${name === 'setState' ? 'set-state' : name === 'cancelPending' ? 'cancel-pending' : name}`;
const args = (name: typeof names[number]): unknown[] => name === 'approve' ? [proposal] : name === 'setState' ? [transition] : [];
const outreach = () => ({ status: async () => ({ model: 'unconfigured', modelName: '', gmail: 'unconfigured', accountEmail: null, senderName: '', postalAddress: '' }) }) as OutreachApi;
function bridge() {
  const research: ResearchSetupApi = {
    status: vi.fn(async () => ({ remote: null, pending: null, blockers: [] })),
    approve: vi.fn(async () => applied), setState: vi.fn(async () => ({ ...applied, kind: 'set-state' as const })),
    retry: vi.fn(async () => applied), cancelPending: vi.fn(async () => cancelled),
  };
  const dispose = registerOutreachIpc({ provider: outreach(), delegation: { researchSetup: research } as DelegationRuntime });
  const invoke = (name: typeof names[number]) => registeredIpcHandler(electron.handle, channel(name));
  const transport = vi.fn(async (name: string, ...values: unknown[]) => registeredIpcHandler(electron.handle, name)(trusted, ...values));
  return { research, dispose, invoke, transport, api: createResearchSetupApi(createIpcClient({ invoke: transport })) };
}
beforeEach(() => { electron.handle.mockReset(); electron.removeHandler.mockReset(); });

describe('pure research setup preload and validated IPC', () => {
  it('registers exactly five optional channels, normalizes applied/cancelled receipts and removes once in reverse order', async () => {
    const f = bridge(); expect(electron.handle.mock.calls.map(([name]) => name).filter(name => name.includes('research-setup-'))).toEqual(names.map(channel));
    expect(await f.api.status()).toEqual({ remote: null, pending: null, blockers: [] }); expect(await f.api.approve(proposal)).toEqual(applied);
    expect(await f.api.setState(transition)).toMatchObject({ kind: 'set-state' }); expect(await f.api.retry()).toEqual(applied); expect(await f.api.cancelPending()).toEqual(cancelled);
    for (const name of names) expect(f.research[name]).toHaveBeenCalledWith(...args(name));
    const registered = electron.handle.mock.calls.map(([name]) => name); f.dispose(); f.dispose(); expect(electron.removeHandler.mock.calls.map(([name]) => name)).toEqual(registered.reverse());
  });
  it('keeps legacy runtime fixtures unchanged and the real preload supplies the optional extension', () => {
    const dispose = registerOutreachIpc({ provider: outreach(), delegation: {} as DelegationRuntime });
    expect(electron.handle.mock.calls.some(([name]) => name.includes('research-setup-'))).toBe(false); dispose();
    expect(Object.keys(createCallieApi({ invoke: vi.fn() }).delegation.researchSetup!)).toEqual(names);
  });
  it.each(names)('rejects untrusted %s before effects and redacts errors', async name => {
    const f = bridge();
    await expect(f.invoke(name)({ senderFrame: { url: 'https://untrusted.test' } }, ...args(name))).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    expect(f.research[name]).not.toHaveBeenCalled(); vi.mocked(f.research[name]).mockRejectedValue(Error('SECRET token private targeting https://private.test'));
    await expect(Reflect.apply(f.api[name], f.api, args(name))).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); f.dispose();
  });
  it.each(names)('rejects surplus %s arguments at preload and main before effects', async name => {
    const f = bridge(), invalid = [...args(name), { workspaceId: 'renderer-selected' }];
    await expect(f.invoke(name)(trusted, ...invalid)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    await expect(Reflect.apply(f.api[name], f.api, invalid)).rejects.toThrow(); expect(f.transport).not.toHaveBeenCalled(); expect(f.research[name]).not.toHaveBeenCalled(); f.dispose();
  });
  it.each(['workspaceId', 'pairingId', 'requestId', 'endpoint', 'credential', 'budgetId'] as const)('forbids renderer-selected %s in proposals', async key => {
    const f = bridge(), invalid = { ...proposal, [key]: 'injected' };
    await expect(f.invoke('approve')(trusted, invalid)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/);
    await expect(f.api.approve(invalid)).rejects.toThrow(); expect(f.research.approve).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled(); f.dispose();
  });
  it.each([{}, { ...proposal, disclosureAcknowledged: false }, { ...proposal, discoveryCeilingMicros: 0 }, { ...proposal, expectedRevision: 1 }])('rejects malformed or unacknowledged approval before effects', async input => {
    const f = bridge(); await expect(f.invoke('approve')(trusted, input)).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); expect(f.research.approve).not.toHaveBeenCalled(); f.dispose();
  });
  it.each([{ ...applied, credential: 'SECRET' }, { ...cancelled, revision: 1 }, { ...applied, status: 'unknown' }, { ...applied, fingerprint: 'bad' }])('rejects unsafe or nonterminal response at both boundaries', async raw => {
    const f = bridge(); vi.mocked(f.research.retry).mockResolvedValue(raw as never);
    await expect(f.api.retry()).rejects.toThrow(/^OUTREACH_REQUEST_FAILED$/); f.dispose();
    const api = createResearchSetupApi(createIpcClient({ invoke: vi.fn(async () => raw) })); await expect(api.retry()).rejects.toThrow();
  });
  it('rolls back registration on partial failure', () => {
    electron.handle.mockImplementation((name: string) => { if (name === channel('retry')) throw Error('fixture'); });
    expect(() => bridge()).toThrow('fixture'); const registered = electron.handle.mock.calls.map(([name]) => name).slice(0, -1);
    expect(electron.removeHandler.mock.calls.map(([name]) => name)).toEqual(registered.reverse());
  });
});
